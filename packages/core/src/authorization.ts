import type {
  AccessGrant,
  Permission,
  ResourceKind,
  Role,
  User,
} from "./entities.ts";
import type { GrantId, UserId, WorkspaceId } from "./ids.ts";

export interface Actor {
  id: UserId;
  workspaceId: WorkspaceId;
  role: Role;
  kind: User["kind"];
  status: User["status"];
}

export interface AuthorizationRequest {
  permission: Permission;
  workspaceId?: WorkspaceId;
  resourceType?: ResourceKind;
  resourceId?: string;
  resourceOwnerId?: UserId;
  featureEnabled?: boolean;
}

export type AuthorizationReason =
  | "actor-inactive"
  | "workspace-mismatch"
  | "feature-disabled"
  | "explicit-deny"
  | "explicit-allow"
  | "role-allow"
  | "self-allow"
  | "not-granted";

export interface AuthorizationDecision {
  allowed: boolean;
  reason: AuthorizationReason;
  matchedGrantId: GrantId | null;
}

const allPermissions: ReadonlySet<Permission> = new Set([
  "workspace:read",
  "workspace:manage",
  "workspace:transfer",
  "user:read",
  "user:manage",
  "access:manage",
  "channel:create",
  "channel:read",
  "channel:write",
  "channel:manage",
  "message:read",
  "message:write",
  "message:moderate",
  "replicant:create",
  "replicant:read",
  "replicant:interact",
  "replicant:manage",
  "task:create",
  "task:read",
  "task:write",
  "task:manage",
  "schedule:create",
  "schedule:read",
  "schedule:run",
  "schedule:manage",
  "run:create",
  "run:read",
  "run:cancel",
  "run:retry",
  "approval:read",
  "approval:decide",
  "approval:manage",
  "notification:read",
  "notification:manage",
  "artifact:create",
  "artifact:read",
  "artifact:write",
  "artifact:delete",
  "database:inspect",
  "file:read",
  "file:write",
  "terminal:execute",
  "credential:manage",
  "backup:create",
  "backup:restore",
  "audit:read",
]);

const adminPermissions: ReadonlySet<Permission> = new Set(
  [...allPermissions].filter(
    (permission) =>
      permission !== "workspace:transfer" && permission !== "backup:restore",
  ),
);

const ownerOnlyPermissions: ReadonlySet<Permission> = new Set([
  "workspace:transfer",
  "backup:restore",
]);

const memberBasePermissions: ReadonlySet<Permission> = new Set([
  "workspace:read",
]);

// Members and service accounts can be granted collaboration capabilities, but
// a grant must never turn them into installation administrators. Owner/admin
// roles remain the hard ceiling for host, identity, credential, inspection,
// backup, and audit controls.
const collaboratorGrantCeiling: ReadonlySet<Permission> = new Set([
  "workspace:read",
  "user:read",
  "channel:create",
  "channel:read",
  "channel:write",
  "message:read",
  "message:write",
  "replicant:read",
  "replicant:interact",
  "task:create",
  "task:read",
  "task:write",
  "schedule:create",
  "schedule:read",
  "schedule:run",
  "run:create",
  "run:read",
  "run:cancel",
  "run:retry",
  "approval:read",
  "approval:decide",
  "notification:read",
  "notification:manage",
  "artifact:create",
  "artifact:read",
  "artifact:write",
  "artifact:delete",
  "file:read",
  "file:write",
]);

function permissionResourceType(permission: Permission): ResourceKind {
  return permission.slice(0, permission.indexOf(":")) as ResourceKind;
}

function grantAppliesToActor(grant: AccessGrant, actor: Actor): boolean {
  return (
    grant.workspaceId === actor.workspaceId &&
    (grant.subjectType === "user"
      ? grant.subjectUserId === actor.id
      : grant.subjectRole === actor.role)
  );
}

function grantMatchesRequest(
  grant: AccessGrant,
  request: AuthorizationRequest,
): boolean {
  const requestResourceType =
    request.resourceType ?? permissionResourceType(request.permission);
  if (
    grant.permission !== request.permission ||
    grant.resourceType !== requestResourceType
  ) {
    return false;
  }
  return (
    grant.resourceId === null ||
    grant.resourceId === (request.resourceId ?? null)
  );
}

function grantIsActive(grant: AccessGrant, now: string): boolean {
  return (
    grant.revokedAt === null &&
    (grant.expiresAt === null || grant.expiresAt > now)
  );
}

function matchingGrants(
  actor: Actor,
  request: AuthorizationRequest,
  grants: readonly AccessGrant[],
  now: string,
): AccessGrant[] {
  return grants.filter(
    (grant) =>
      grantAppliesToActor(grant, actor) &&
      grantMatchesRequest(grant, request) &&
      grantIsActive(grant, now),
  );
}

export function evaluateAuthorization(
  actor: Actor,
  request: AuthorizationRequest,
  grants: readonly AccessGrant[],
  now: string,
): AuthorizationDecision {
  if (actor.status !== "active") {
    return { allowed: false, reason: "actor-inactive", matchedGrantId: null };
  }

  if (
    request.workspaceId !== undefined &&
    request.workspaceId !== actor.workspaceId
  ) {
    return {
      allowed: false,
      reason: "workspace-mismatch",
      matchedGrantId: null,
    };
  }

  if (
    request.permission === "terminal:execute" &&
    request.featureEnabled !== true
  ) {
    return { allowed: false, reason: "feature-disabled", matchedGrantId: null };
  }

  const matches = matchingGrants(actor, request, grants, now);
  const deny = matches.find((grant) => grant.effect === "deny");
  if (deny !== undefined) {
    return { allowed: false, reason: "explicit-deny", matchedGrantId: deny.id };
  }

  if (actor.role !== "owner" && ownerOnlyPermissions.has(request.permission)) {
    return { allowed: false, reason: "not-granted", matchedGrantId: null };
  }

  if (
    (actor.role === "member" || actor.role === "service") &&
    !collaboratorGrantCeiling.has(request.permission)
  ) {
    return { allowed: false, reason: "not-granted", matchedGrantId: null };
  }

  const allow = matches.find((grant) => grant.effect === "allow");
  if (allow !== undefined) {
    return {
      allowed: true,
      reason: "explicit-allow",
      matchedGrantId: allow.id,
    };
  }

  const selfPermission =
    request.resourceOwnerId === actor.id &&
    (request.permission === "user:read" ||
      request.permission === "notification:read" ||
      request.permission === "notification:manage");
  if (selfPermission) {
    return { allowed: true, reason: "self-allow", matchedGrantId: null };
  }

  const rolePermissions =
    actor.role === "owner"
      ? allPermissions
      : actor.role === "admin"
        ? adminPermissions
        : actor.role === "member"
          ? memberBasePermissions
          : undefined;

  if (rolePermissions?.has(request.permission) === true) {
    return { allowed: true, reason: "role-allow", matchedGrantId: null };
  }

  return { allowed: false, reason: "not-granted", matchedGrantId: null };
}

export class AuthorizationError extends Error {
  readonly decision: AuthorizationDecision;
  readonly permission: Permission;

  constructor(permission: Permission, decision: AuthorizationDecision) {
    super(`Permission denied: ${permission} (${decision.reason})`);
    this.name = "AuthorizationError";
    this.permission = permission;
    this.decision = decision;
  }
}

export function authorize(
  actor: Actor,
  request: AuthorizationRequest,
  grants: readonly AccessGrant[],
  now: string,
): AuthorizationDecision {
  const decision = evaluateAuthorization(actor, request, grants, now);
  if (!decision.allowed)
    throw new AuthorizationError(request.permission, decision);
  return decision;
}
