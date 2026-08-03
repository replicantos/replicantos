import { DatabaseSync } from "node:sqlite";

import type {
  Artifact,
  ArtifactId,
  AuditRecord,
  IsoTimestamp,
  JsonValue,
  UserId,
  WorkspaceId,
} from "@replicantos/core";

import { HttpError } from "./errors.js";

function mapArtifact(row: Record<string, unknown>): Artifact {
  return {
    id: row.id as ArtifactId,
    workspaceId: row.workspace_id as WorkspaceId,
    kind: row.kind as Artifact["kind"],
    name: row.name as string,
    mediaType: row.media_type as string,
    relativePath: row.relative_path as string,
    byteSize: row.byte_size as number,
    sha256: row.sha256 as string,
    searchable: row.searchable === 1,
    createdByUserId: row.created_by_user_id as UserId | null,
    createdByReplicantId:
      row.created_by_replicant_id as Artifact["createdByReplicantId"],
    metadata: JSON.parse(row.metadata_json as string) as JsonValue,
    createdAt: row.created_at as IsoTimestamp,
    updatedAt: row.updated_at as IsoTimestamp,
  };
}

export interface DocumentIndexResult {
  artifact: Artifact;
  created: boolean;
}

export class DocumentIndexStore {
  #database: DatabaseSync | null;

  constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath, { allowExtension: false });
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA busy_timeout = 5000");
    this.#database.exec("PRAGMA trusted_schema = OFF");
  }

  getByPath(workspaceId: WorkspaceId, relativePath: string): Artifact | null {
    if (this.#database === null) throw new Error("Document index is closed");
    const row = this.#database
      .prepare(
        `SELECT * FROM artifacts
         WHERE workspace_id = ? AND relative_path = ? AND kind = 'document'`,
      )
      .get(workspaceId, relativePath) as Record<string, unknown> | undefined;
    return row === undefined ? null : mapArtifact(row);
  }

  upsert(
    candidate: Artifact,
    expectedArtifactId: ArtifactId | null,
    createAudit: (artifact: Artifact, created: boolean) => AuditRecord,
  ): DocumentIndexResult {
    if (this.#database === null) throw new Error("Document index is closed");
    const database = this.#database;
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getByPath(
        candidate.workspaceId,
        candidate.relativePath,
      );
      if (
        (existing === null && expectedArtifactId !== null) ||
        (existing !== null && existing.id !== expectedArtifactId)
      ) {
        throw new HttpError(
          409,
          "conflict",
          "The document index changed. Retry the request.",
        );
      }

      const artifact: Artifact =
        existing === null
          ? candidate
          : {
              ...candidate,
              id: existing.id,
              createdByUserId: existing.createdByUserId,
              createdByReplicantId: existing.createdByReplicantId,
              createdAt: existing.createdAt,
            };
      if (existing === null) {
        database
          .prepare(
            `INSERT INTO artifacts(
              id, workspace_id, kind, name, media_type, relative_path, byte_size,
              sha256, searchable, created_by_user_id, created_by_replicant_id,
              metadata_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            artifact.id,
            artifact.workspaceId,
            artifact.kind,
            artifact.name,
            artifact.mediaType,
            artifact.relativePath,
            artifact.byteSize,
            artifact.sha256,
            artifact.searchable ? 1 : 0,
            artifact.createdByUserId,
            artifact.createdByReplicantId,
            JSON.stringify(artifact.metadata),
            artifact.createdAt,
            artifact.updatedAt,
          );
      } else {
        database
          .prepare(
            `UPDATE artifacts SET
              name = ?, media_type = ?, byte_size = ?, sha256 = ?, searchable = ?,
              metadata_json = ?, updated_at = ?
             WHERE id = ? AND workspace_id = ? AND kind = 'document'`,
          )
          .run(
            artifact.name,
            artifact.mediaType,
            artifact.byteSize,
            artifact.sha256,
            artifact.searchable ? 1 : 0,
            JSON.stringify(artifact.metadata),
            artifact.updatedAt,
            artifact.id,
            artifact.workspaceId,
          );
      }

      const audit = createAudit(artifact, existing === null);
      database
        .prepare(
          `INSERT INTO audit_log(
            id, workspace_id, actor_kind, actor_user_id, action, resource_type,
            resource_id, request_id, detail_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          audit.id,
          audit.workspaceId,
          audit.actorKind,
          audit.actorUserId,
          audit.action,
          audit.resourceType,
          audit.resourceId,
          audit.requestId,
          JSON.stringify(audit.detail),
          audit.createdAt,
        );
      database.exec("COMMIT");
      return { artifact, created: existing === null };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.#database?.close();
    this.#database = null;
  }
}
