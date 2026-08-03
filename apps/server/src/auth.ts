import { randomUUID } from "node:crypto";

import {
  authorize,
  createEntityId,
  entityId,
  evaluateAuthorization,
  type Actor,
  type AuditRecord,
  type AuthorizationRequest,
  type EntityId,
  type EntityKind,
  type Session,
  type User,
} from "@replicantos/core";
import type { FastifyRequest } from "fastify";

import type { ServerDependencies } from "./dependencies.js";
import { HttpError, invalidRequest } from "./errors.js";
import { hashSessionToken, SESSION_COOKIE_NAME } from "./security.js";

export interface AuthenticatedActor extends Actor {
  displayName: string;
}

export interface AuthenticationContext {
  actor: AuthenticatedActor;
  session: Session;
}

export function sessionTokenFromRequest(
  request: FastifyRequest,
): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (cookieHeader === undefined) return undefined;
  const matchingCookies = cookieHeader
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (matchingCookies.length !== 1) return undefined;
  return request.cookies[SESSION_COOKIE_NAME];
}

export function nextId<Kind extends EntityKind>(kind: Kind): EntityId<Kind> {
  return createEntityId(kind, randomUUID().replaceAll("-", ""));
}

export function parseEntityId<Kind extends EntityKind>(
  kind: Kind,
  value: string,
): EntityId<Kind> {
  try {
    return entityId(kind, value);
  } catch {
    throw invalidRequest();
  }
}

export function requireServices(dependencies: ServerDependencies): {
  database: NonNullable<ServerDependencies["database"]>;
  repositories: NonNullable<ServerDependencies["repositories"]>;
  passwords: NonNullable<ServerDependencies["passwords"]>;
} {
  if (
    dependencies.database === null ||
    dependencies.repositories === null ||
    dependencies.passwords === null
  ) {
    throw new HttpError(
      503,
      "service_unavailable",
      "The service is not configured for local persistence.",
    );
  }
  return {
    database: dependencies.database,
    repositories: dependencies.repositories,
    passwords: dependencies.passwords,
  };
}

export async function authenticateToken(
  dependencies: ServerDependencies,
  token: string | undefined,
): Promise<AuthenticationContext | null> {
  if (token === undefined || dependencies.repositories === null) return null;
  const now = dependencies.now();
  const session = dependencies.repositories.sessions.resolve(
    hashSessionToken(token),
    now,
  );
  if (session === null) return null;
  const user = dependencies.repositories.users.get(session.userId);
  if (user === null || user.status !== "active") return null;
  return {
    actor: {
      id: user.id,
      workspaceId: user.workspaceId,
      role: user.role,
      kind: user.kind,
      status: user.status,
      displayName: user.displayName,
    },
    session,
  };
}

export async function requireAuthentication(
  request: FastifyRequest,
  dependencies: ServerDependencies,
): Promise<AuthenticationContext> {
  const context = await authenticateToken(
    dependencies,
    sessionTokenFromRequest(request),
  );
  if (context === null) {
    throw new HttpError(
      401,
      "authentication_required",
      "Authentication is required.",
    );
  }
  return context;
}

function decisionRequest(
  actor: AuthenticatedActor,
  request: AuthorizationRequest,
): AuthorizationRequest {
  return { ...request, workspaceId: actor.workspaceId };
}

export function can(
  actor: AuthenticatedActor,
  request: AuthorizationRequest,
  dependencies: ServerDependencies,
): boolean {
  const { repositories } = requireServices(dependencies);
  const grants = repositories.accessGrants.listForActor(
    actor.id,
    actor.role,
    dependencies.now(),
  );
  return evaluateAuthorization(
    actor,
    decisionRequest(actor, request),
    grants,
    dependencies.now(),
  ).allowed;
}

export function requirePermission(
  actor: AuthenticatedActor,
  request: AuthorizationRequest,
  dependencies: ServerDependencies,
): void {
  const { repositories } = requireServices(dependencies);
  const grants = repositories.accessGrants.listForActor(
    actor.id,
    actor.role,
    dependencies.now(),
  );
  try {
    authorize(
      actor,
      decisionRequest(actor, request),
      grants,
      dependencies.now(),
    );
  } catch {
    throw new HttpError(
      403,
      "forbidden",
      "You do not have permission for this action.",
    );
  }
}

export function createAuditRecord(
  dependencies: ServerDependencies,
  request: FastifyRequest,
  actor: AuthenticatedActor | User | null,
  action: string,
  resourceType: string,
  resourceId: string | null,
  detail: AuditRecord["detail"] = {},
): AuditRecord {
  const { repositories } = requireServices(dependencies);
  const workspace = actor?.workspaceId ?? repositories.workspaces.getOnly()?.id;
  if (workspace === undefined)
    throw new Error("Cannot audit without a workspace");
  const record: AuditRecord = {
    id: nextId("audit"),
    workspaceId: workspace,
    actorKind:
      actor === null ? "system" : actor.kind === "service" ? "service" : "user",
    actorUserId: actor?.id ?? null,
    action,
    resourceType,
    resourceId,
    requestId: String(request.id),
    detail,
    createdAt: dependencies.now(),
  };
  return record;
}

export function appendAudit(
  dependencies: ServerDependencies,
  request: FastifyRequest,
  actor: AuthenticatedActor | User | null,
  action: string,
  resourceType: string,
  resourceId: string | null,
  detail: AuditRecord["detail"] = {},
): AuditRecord {
  const { repositories } = requireServices(dependencies);
  return repositories.audit.append(
    createAuditRecord(
      dependencies,
      request,
      actor,
      action,
      resourceType,
      resourceId,
      detail,
    ),
  );
}
