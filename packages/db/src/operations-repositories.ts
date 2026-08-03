import type {
  Approval,
  ApprovalId,
  Artifact,
  ArtifactId,
  AuditId,
  AuditRecord,
  IsoTimestamp,
  Notification,
  NotificationId,
  RunId,
  UserId,
  WorkspaceId,
} from "@replicantos/core";

import { connectionFor, type ReplicantDatabase } from "./database.ts";
import {
  cappedLimit,
  jsonText,
  lowercaseHex,
  optionalText,
  parseJson,
  requiredText,
  safeRelativePath,
} from "./validation.ts";

function mapApproval(row: Record<string, unknown>): Approval {
  return {
    id: row.id as ApprovalId,
    workspaceId: row.workspace_id as WorkspaceId,
    runId: row.run_id as RunId | null,
    requestedBy: row.requested_by as UserId | null,
    action: row.action as string,
    actionDigest: row.action_digest as string,
    payload: parseJson(row.payload_json as string),
    status: row.status as Approval["status"],
    expiresAt: row.expires_at as IsoTimestamp,
    decidedBy: row.decided_by as UserId | null,
    decidedAt: row.decided_at as IsoTimestamp | null,
    consumedAt: row.consumed_at as IsoTimestamp | null,
    createdAt: row.created_at as IsoTimestamp,
  };
}

function mapNotification(row: Record<string, unknown>): Notification {
  return {
    id: row.id as NotificationId,
    workspaceId: row.workspace_id as WorkspaceId,
    recipientUserId: row.recipient_user_id as UserId,
    kind: row.kind as string,
    title: row.title as string,
    body: row.body as string | null,
    resourceType: row.resource_type as string | null,
    resourceId: row.resource_id as string | null,
    createdAt: row.created_at as IsoTimestamp,
    readAt: row.read_at as IsoTimestamp | null,
  };
}

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
    metadata: parseJson(row.metadata_json as string),
    createdAt: row.created_at as IsoTimestamp,
    updatedAt: row.updated_at as IsoTimestamp,
  };
}

function mapAudit(row: Record<string, unknown>): AuditRecord {
  return {
    id: row.id as AuditId,
    workspaceId: row.workspace_id as WorkspaceId,
    actorKind: row.actor_kind as AuditRecord["actorKind"],
    actorUserId: row.actor_user_id as UserId | null,
    action: row.action as string,
    resourceType: row.resource_type as string,
    resourceId: row.resource_id as string | null,
    requestId: row.request_id as string | null,
    detail: parseJson(row.detail_json as string),
    createdAt: row.created_at as IsoTimestamp,
  };
}

export class ApprovalExpiredError extends Error {
  constructor() {
    super("Approval has expired");
    this.name = "ApprovalExpiredError";
  }
}

export class ApprovalRepository {
  constructor(private readonly database: ReplicantDatabase) {}

  create(approval: Approval): Approval {
    if (approval.status !== "pending") {
      throw new TypeError("New approvals must have pending status");
    }
    connectionFor(this.database)
      .prepare(
        `INSERT INTO approvals(
          id, workspace_id, run_id, requested_by, action, action_digest, payload_json,
          status, expires_at, decided_by, decided_at, consumed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.id,
        approval.workspaceId,
        approval.runId,
        approval.requestedBy,
        requiredText(approval.action, "approval action", 500),
        lowercaseHex(approval.actionDigest, "actionDigest"),
        jsonText(approval.payload),
        approval.status,
        approval.expiresAt,
        approval.decidedBy,
        approval.decidedAt,
        approval.consumedAt,
        approval.createdAt,
      );
    return approval;
  }

  get(id: ApprovalId): Approval | null {
    const row = connectionFor(this.database)
      .prepare("SELECT * FROM approvals WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? null : mapApproval(row);
  }

  listPending(
    workspaceId: WorkspaceId,
    now: IsoTimestamp,
    limit?: number,
  ): Approval[] {
    const rows = connectionFor(this.database)
      .prepare(
        `SELECT * FROM approvals
         WHERE workspace_id = ? AND status = 'pending' AND expires_at > ?
         ORDER BY expires_at, created_at LIMIT ?`,
      )
      .all(workspaceId, now, cappedLimit(limit)) as Array<
      Record<string, unknown>
    >;
    return rows.map(mapApproval);
  }

  decide(
    id: ApprovalId,
    decision: "approved" | "denied",
    actorId: UserId,
    now: IsoTimestamp,
  ): Approval {
    const result = this.database.transaction(() => {
      const approval = this.get(id);
      if (approval === null) throw new Error("Approval not found");
      if (approval.status !== "pending")
        throw new Error("Approval has already been decided");
      if (approval.expiresAt <= now) {
        connectionFor(this.database)
          .prepare(
            "UPDATE approvals SET status = 'expired' WHERE id = ? AND status = 'pending'",
          )
          .run(id);
        return null;
      }
      connectionFor(this.database)
        .prepare(
          `UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(decision, actorId, now, id);
      const updated = this.get(id);
      if (updated === null)
        throw new Error("Approval disappeared during update");
      return updated;
    });
    if (result === null) throw new ApprovalExpiredError();
    return result;
  }

  consume(
    id: ApprovalId,
    expectedActionDigest: string,
    now: IsoTimestamp,
  ): Approval {
    const result = this.database.transaction(() => {
      const approval = this.get(id);
      if (approval === null) throw new Error("Approval not found");
      if (
        approval.actionDigest !==
        lowercaseHex(expectedActionDigest, "expectedActionDigest")
      ) {
        throw new Error("Approval does not match the requested action");
      }
      if (approval.expiresAt <= now) {
        if (approval.status === "approved") {
          connectionFor(this.database)
            .prepare(
              "UPDATE approvals SET status = 'expired' WHERE id = ? AND status = 'approved'",
            )
            .run(id);
        }
        return null;
      }
      if (approval.status !== "approved") {
        throw new Error(
          "Approval is not approved or has already been consumed",
        );
      }
      const result = connectionFor(this.database)
        .prepare(
          `UPDATE approvals SET status = 'consumed', consumed_at = ?
           WHERE id = ? AND status = 'approved' AND consumed_at IS NULL`,
        )
        .run(now, id);
      if (result.changes !== 1)
        throw new Error("Approval was already consumed");
      const updated = this.get(id);
      if (updated === null)
        throw new Error("Approval disappeared during update");
      return updated;
    });
    if (result === null) throw new ApprovalExpiredError();
    return result;
  }
}

export class NotificationRepository {
  constructor(private readonly database: ReplicantDatabase) {}

  create(notification: Notification): Notification {
    connectionFor(this.database)
      .prepare(
        `INSERT INTO notifications(
          id, workspace_id, recipient_user_id, kind, title, body,
          resource_type, resource_id, created_at, read_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        notification.id,
        notification.workspaceId,
        notification.recipientUserId,
        requiredText(notification.kind, "notification kind", 120),
        requiredText(notification.title, "notification title", 500),
        optionalText(notification.body, "notification body", 10_000),
        notification.resourceType,
        notification.resourceId,
        notification.createdAt,
        notification.readAt,
      );
    return notification;
  }

  listForUser(
    userId: UserId,
    options: { unreadOnly?: boolean; limit?: number } = {},
  ): Notification[] {
    const rows = connectionFor(this.database)
      .prepare(
        `SELECT * FROM notifications
         WHERE recipient_user_id = ? AND (? = 0 OR read_at IS NULL)
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(
        userId,
        options.unreadOnly === true ? 1 : 0,
        cappedLimit(options.limit),
      ) as Array<Record<string, unknown>>;
    return rows.map(mapNotification);
  }

  markRead(
    id: NotificationId,
    recipientUserId: UserId,
    now: IsoTimestamp,
  ): boolean {
    const result = connectionFor(this.database)
      .prepare(
        `UPDATE notifications SET read_at = ?
         WHERE id = ? AND recipient_user_id = ? AND read_at IS NULL`,
      )
      .run(now, id, recipientUserId);
    return result.changes === 1;
  }
}

export class ArtifactRepository {
  constructor(private readonly database: ReplicantDatabase) {}

  create(artifact: Artifact): Artifact {
    connectionFor(this.database)
      .prepare(
        `INSERT INTO artifacts(
          id, workspace_id, kind, name, media_type, relative_path, byte_size, sha256,
          searchable, created_by_user_id, created_by_replicant_id, metadata_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        artifact.workspaceId,
        artifact.kind,
        requiredText(artifact.name, "artifact name", 500),
        requiredText(artifact.mediaType, "media type", 200),
        safeRelativePath(artifact.relativePath),
        artifact.byteSize,
        lowercaseHex(artifact.sha256, "sha256"),
        artifact.searchable ? 1 : 0,
        artifact.createdByUserId,
        artifact.createdByReplicantId,
        jsonText(artifact.metadata),
        artifact.createdAt,
        artifact.updatedAt,
      );
    return artifact;
  }

  get(id: ArtifactId): Artifact | null {
    const row = connectionFor(this.database)
      .prepare("SELECT * FROM artifacts WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? null : mapArtifact(row);
  }

  list(
    workspaceId: WorkspaceId,
    options: {
      searchableOnly?: boolean;
      kind?: Artifact["kind"];
      limit?: number;
    } = {},
  ): Artifact[] {
    const rows = connectionFor(this.database)
      .prepare(
        `SELECT * FROM artifacts
         WHERE workspace_id = ?
           AND (? = 0 OR searchable = 1)
           AND (? IS NULL OR kind = ?)
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(
        workspaceId,
        options.searchableOnly === true ? 1 : 0,
        options.kind ?? null,
        options.kind ?? null,
        cappedLimit(options.limit),
      ) as Array<Record<string, unknown>>;
    return rows.map(mapArtifact);
  }
}

export class AuditRepository {
  constructor(private readonly database: ReplicantDatabase) {}

  append(record: AuditRecord): AuditRecord {
    connectionFor(this.database)
      .prepare(
        `INSERT INTO audit_log(
          id, workspace_id, actor_kind, actor_user_id, action, resource_type,
          resource_id, request_id, detail_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId,
        record.actorKind,
        record.actorUserId,
        requiredText(record.action, "audit action", 500),
        requiredText(record.resourceType, "audit resource type", 120),
        record.resourceId,
        record.requestId,
        jsonText(record.detail),
        record.createdAt,
      );
    return record;
  }

  get(id: AuditId): AuditRecord | null {
    const row = connectionFor(this.database)
      .prepare("SELECT * FROM audit_log WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? null : mapAudit(row);
  }

  listForResource(
    workspaceId: WorkspaceId,
    resourceType: string,
    resourceId: string | null,
    limit?: number,
  ): AuditRecord[] {
    const rows = connectionFor(this.database)
      .prepare(
        `SELECT * FROM audit_log
         WHERE workspace_id = ? AND resource_type = ? AND resource_id IS ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(
        workspaceId,
        requiredText(resourceType, "resource type", 120),
        resourceId,
        cappedLimit(limit),
      ) as Array<Record<string, unknown>>;
    return rows.map(mapAudit);
  }
}
