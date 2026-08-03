import type {
  AccessGrant,
  IsoTimestamp,
  JsonValue,
  Role,
  Session,
  SessionId,
  User,
  UserId,
  UserStatus,
  Workspace,
  WorkspaceId,
} from "@replicantos/core";

import { connectionFor, type ReplicantDatabase } from "./database.ts";
import {
  cappedLimit,
  jsonText,
  lowercaseHex,
  parseJson,
  requiredText,
} from "./validation.ts";

function mapWorkspace(row: Record<string, unknown>): Workspace {
  return {
    id: row.id as WorkspaceId,
    slug: row.slug as string,
    displayName: row.display_name as string,
    createdAt: row.created_at as IsoTimestamp,
    updatedAt: row.updated_at as IsoTimestamp,
  };
}

function mapUser(row: Record<string, unknown>): User {
  return {
    id: row.id as UserId,
    workspaceId: row.workspace_id as WorkspaceId,
    kind: row.kind as User["kind"],
    handle: row.handle as string,
    displayName: row.display_name as string,
    role: row.role as Role,
    status: row.status as UserStatus,
    createdAt: row.created_at as IsoTimestamp,
    updatedAt: row.updated_at as IsoTimestamp,
  };
}

function mapSession(row: Record<string, unknown>): Session {
  return {
    id: row.id as SessionId,
    userId: row.user_id as UserId,
    createdAt: row.created_at as IsoTimestamp,
    expiresAt: row.expires_at as IsoTimestamp,
    lastSeenAt: row.last_seen_at as IsoTimestamp,
    revokedAt: row.revoked_at as IsoTimestamp | null,
  };
}

function mapGrant(row: Record<string, unknown>): AccessGrant {
  return {
    id: row.id as AccessGrant["id"],
    workspaceId: row.workspace_id as WorkspaceId,
    subjectType: row.subject_type as AccessGrant["subjectType"],
    subjectUserId: row.subject_user_id as UserId | null,
    subjectRole: row.subject_role as Role | null,
    permission: row.permission as AccessGrant["permission"],
    resourceType: row.resource_type as AccessGrant["resourceType"],
    resourceId: row.resource_id as string | null,
    effect: row.effect as AccessGrant["effect"],
    reason: row.reason as string | null,
    createdBy: row.created_by as UserId,
    createdAt: row.created_at as IsoTimestamp,
    expiresAt: row.expires_at as IsoTimestamp | null,
    revokedAt: row.revoked_at as IsoTimestamp | null,
  };
}

export class WorkspaceRepository {
  constructor(private readonly database: ReplicantDatabase) {}

  create(workspace: Workspace): Workspace {
    connectionFor(this.database)
      .prepare(
        `INSERT INTO workspaces(id, slug, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        workspace.id,
        requiredText(workspace.slug, "slug", 64),
        requiredText(workspace.displayName, "displayName", 120),
        workspace.createdAt,
        workspace.updatedAt,
      );
    return workspace;
  }

  get(id: WorkspaceId): Workspace | null {
    const row = connectionFor(this.database)
      .prepare("SELECT * FROM workspaces WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? null : mapWorkspace(row);
  }

  getOnly(): Workspace | null {
    const rows = connectionFor(this.database)
      .prepare("SELECT * FROM workspaces LIMIT 2")
      .all() as Array<Record<string, unknown>>;
    if (rows.length > 1)
      throw new Error("This installation contains more than one workspace");
    return rows[0] === undefined ? null : mapWorkspace(rows[0]);
  }

  setSetting(
    workspaceId: WorkspaceId,
    key: string,
    value: JsonValue,
    updatedBy: UserId | null,
    updatedAt: IsoTimestamp,
  ): void {
    connectionFor(this.database)
      .prepare(
        `INSERT INTO workspace_settings(workspace_id, key, value_json, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(
        workspaceId,
        requiredText(key, "setting key", 120),
        jsonText(value),
        updatedBy,
        updatedAt,
      );
  }

  getSetting(workspaceId: WorkspaceId, key: string): JsonValue | null {
    const row = connectionFor(this.database)
      .prepare(
        "SELECT value_json FROM workspace_settings WHERE workspace_id = ? AND key = ?",
      )
      .get(workspaceId, key) as { value_json: string } | undefined;
    return row === undefined ? null : parseJson(row.value_json);
  }
}

export interface CreateUserInput {
  user: User;
  passwordHash: string | null;
}

export class UserRepository {
  constructor(private readonly database: ReplicantDatabase) {}

  create(input: CreateUserInput): User {
    const { user } = input;
    if (
      input.passwordHash !== null &&
      !input.passwordHash.startsWith("$argon2id$")
    ) {
      throw new TypeError("Passwords must be pre-hashed with Argon2id");
    }
    connectionFor(this.database)
      .prepare(
        `INSERT INTO users(
           id, workspace_id, kind, handle, display_name, password_hash, role, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        user.id,
        user.workspaceId,
        user.kind,
        requiredText(user.handle, "handle", 64),
        requiredText(user.displayName, "displayName", 120),
        input.passwordHash,
        user.role,
        user.status,
        user.createdAt,
        user.updatedAt,
      );
    return user;
  }

  get(id: UserId): User | null {
    const row = connectionFor(this.database)
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? null : mapUser(row);
  }

  getByHandle(workspaceId: WorkspaceId, handle: string): User | null {
    const row = connectionFor(this.database)
      .prepare(
        "SELECT * FROM users WHERE workspace_id = ? AND handle = ? COLLATE NOCASE",
      )
      .get(workspaceId, handle) as Record<string, unknown> | undefined;
    return row === undefined ? null : mapUser(row);
  }

  list(workspaceId: WorkspaceId, limit?: number): User[] {
    const rows = connectionFor(this.database)
      .prepare(
        "SELECT * FROM users WHERE workspace_id = ? ORDER BY created_at, id LIMIT ?",
      )
      .all(workspaceId, cappedLimit(limit)) as Array<Record<string, unknown>>;
    return rows.map(mapUser);
  }

  setStatus(id: UserId, status: UserStatus, updatedAt: IsoTimestamp): User {
    return this.database.transaction(() => {
      const existing = this.get(id);
      if (existing === null) throw new Error("User not found");
      if (
        existing.role === "owner" &&
        existing.status === "active" &&
        status !== "active"
      ) {
        throw new Error(
          "The active workspace owner cannot be disabled or suspended",
        );
      }
      connectionFor(this.database)
        .prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ?")
        .run(status, updatedAt, id);
      const updated = this.get(id);
      if (updated === null) throw new Error("User disappeared during update");
      return updated;
    });
  }
}

export interface CreateSessionInput extends Session {
  tokenHash: string;
}

export class SessionRepository {
  constructor(private readonly database: ReplicantDatabase) {}

  create(session: CreateSessionInput): Session {
    connectionFor(this.database)
      .prepare(
        `INSERT INTO sessions(
           id, user_id, token_hash, created_at, expires_at, last_seen_at, revoked_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.userId,
        lowercaseHex(session.tokenHash, "tokenHash"),
        session.createdAt,
        session.expiresAt,
        session.lastSeenAt,
        session.revokedAt,
      );
    return session;
  }

  resolve(tokenHash: string, now: IsoTimestamp): Session | null {
    const row = connectionFor(this.database)
      .prepare(
        `SELECT id, user_id, created_at, expires_at, last_seen_at, revoked_at
         FROM sessions
         WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(lowercaseHex(tokenHash, "tokenHash"), now) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? null : mapSession(row);
  }

  touch(id: SessionId, now: IsoTimestamp): boolean {
    const result = connectionFor(this.database)
      .prepare(
        "UPDATE sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL AND expires_at > ?",
      )
      .run(now, id, now);
    return result.changes === 1;
  }

  revoke(id: SessionId, now: IsoTimestamp): boolean {
    const result = connectionFor(this.database)
      .prepare(
        "UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      )
      .run(now, id);
    return result.changes === 1;
  }

  revokeAllForUser(userId: UserId, now: IsoTimestamp): number {
    const result = connectionFor(this.database)
      .prepare(
        "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
      )
      .run(now, userId);
    return Number(result.changes);
  }
}

export class AccessGrantRepository {
  constructor(private readonly database: ReplicantDatabase) {}

  create(grant: AccessGrant): AccessGrant {
    connectionFor(this.database)
      .prepare(
        `INSERT INTO access_grants(
           id, workspace_id, subject_type, subject_user_id, subject_role, permission,
           resource_type, resource_id, effect, reason, created_by, created_at, expires_at, revoked_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        grant.id,
        grant.workspaceId,
        grant.subjectType,
        grant.subjectUserId,
        grant.subjectRole,
        grant.permission,
        grant.resourceType,
        grant.resourceId,
        grant.effect,
        grant.reason,
        grant.createdBy,
        grant.createdAt,
        grant.expiresAt,
        grant.revokedAt,
      );
    return grant;
  }

  get(id: AccessGrant["id"]): AccessGrant | null {
    const row = connectionFor(this.database)
      .prepare("SELECT * FROM access_grants WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? null : mapGrant(row);
  }

  listForActor(userId: UserId, role: Role, now: IsoTimestamp): AccessGrant[] {
    const rows = connectionFor(this.database)
      .prepare(
        `SELECT * FROM access_grants
         WHERE (subject_user_id = ? OR (subject_type = 'role' AND subject_role = ?))
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at, id`,
      )
      .all(userId, role, now) as Array<Record<string, unknown>>;
    return rows.map(mapGrant);
  }

  revoke(id: AccessGrant["id"], now: IsoTimestamp): boolean {
    const result = connectionFor(this.database)
      .prepare(
        "UPDATE access_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      )
      .run(now, id);
    return result.changes === 1;
  }
}
