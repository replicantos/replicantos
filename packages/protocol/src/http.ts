import { API_V1_PREFIX } from "./version.js";
import {
  ProtocolValidationError,
  requireJsonValue,
  requireRecord,
  requireString,
  type JsonObject,
  type JsonValue,
} from "./schema.js";
import type {
  ActorResource,
  ApprovalResource,
  ChannelResource,
  DocumentResource,
  FileEntryResource,
  MessageResource,
  NotificationResource,
  PublicHarnessRunResource,
  ReplicantResource,
  ScheduleResource,
  TaskResource,
} from "./resources.js";
import type { Permission } from "./permissions.js";

export type ApiErrorCode =
  | "authentication_required"
  | "conflict"
  | "forbidden"
  | "internal_error"
  | "invalid_credentials"
  | "invalid_request"
  | "not_found"
  | "origin_rejected"
  | "rate_limited"
  | "service_unavailable"
  | "unsupported"
  | "version_mismatch";

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  details?: JsonObject;
}

export interface ApiSuccess<T extends JsonValue = JsonValue> {
  data: T;
}

export interface ApiFailure {
  error: ApiError;
}

export type ApiEnvelope<T extends JsonValue = JsonValue> =
  | ApiFailure
  | ApiSuccess<T>;

export interface CursorPage<T> {
  items: readonly T[];
  nextCursor: string | null;
}

export interface ListPage<T> {
  items: readonly T[];
}

export interface CursorQuery {
  cursor?: string;
  limit?: number;
}

export type HttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

export interface HttpRouteSpec {
  method: HttpMethod;
  path: `${typeof API_V1_PREFIX}${string}`;
  auth: "authenticated" | "owner" | "public";
  capability?: Permission;
}

function route<const T extends HttpRouteSpec>(spec: T): T {
  return Object.freeze(spec);
}

/**
 * Canonical v1 paths. Paths with `:id` are templates and must be populated by
 * the caller; authorization is still evaluated against the resolved resource.
 */
export const HTTP_ROUTES = Object.freeze({
  health: route({ method: "GET", path: "/api/v1/health", auth: "public" }),
  bootstrapStatus: route({
    method: "GET",
    path: "/api/v1/system/bootstrap-status",
    auth: "public",
  }),
  bootstrap: route({
    method: "POST",
    path: "/api/v1/system/bootstrap",
    auth: "public",
  }),
  login: route({
    method: "POST",
    path: "/api/v1/auth/login",
    auth: "public",
  }),
  logout: route({
    method: "POST",
    path: "/api/v1/auth/logout",
    auth: "authenticated",
  }),
  me: route({
    method: "GET",
    path: "/api/v1/auth/me",
    auth: "authenticated",
  }),
  session: route({
    method: "GET",
    path: "/api/v1/session",
    auth: "authenticated",
  }),
  realtime: route({
    method: "GET",
    path: "/api/v1/realtime",
    auth: "authenticated",
  }),
  channels: route({
    method: "GET",
    path: "/api/v1/channels",
    auth: "authenticated",
    capability: "channel:read",
  }),
  createChannel: route({
    method: "POST",
    path: "/api/v1/channels",
    auth: "authenticated",
    capability: "channel:create",
  }),
  messages: route({
    method: "GET",
    path: "/api/v1/channels/:id/messages",
    auth: "authenticated",
    capability: "channel:read",
  }),
  createMessage: route({
    method: "POST",
    path: "/api/v1/channels/:id/messages",
    auth: "authenticated",
    capability: "channel:write",
  }),
  replicants: route({
    method: "GET",
    path: "/api/v1/replicants",
    auth: "authenticated",
    capability: "replicant:read",
  }),
  createReplicant: route({
    method: "POST",
    path: "/api/v1/replicants",
    auth: "authenticated",
    capability: "replicant:create",
  }),
  replicantBindings: route({
    method: "GET",
    path: "/api/v1/replicants/:id/bindings",
    auth: "authenticated",
    capability: "replicant:read",
  }),
  upsertReplicantBinding: route({
    method: "POST",
    path: "/api/v1/replicants/:id/bindings",
    auth: "authenticated",
    capability: "replicant:manage",
  }),
  tasks: route({
    method: "GET",
    path: "/api/v1/tasks",
    auth: "authenticated",
    capability: "task:read",
  }),
  createTask: route({
    method: "POST",
    path: "/api/v1/tasks",
    auth: "authenticated",
    capability: "task:create",
  }),
  updateTaskStatus: route({
    method: "PATCH",
    path: "/api/v1/tasks/:id/status",
    auth: "authenticated",
    capability: "task:write",
  }),
  schedules: route({
    method: "GET",
    path: "/api/v1/schedules",
    auth: "authenticated",
    capability: "schedule:read",
  }),
  createSchedule: route({
    method: "POST",
    path: "/api/v1/schedules",
    auth: "authenticated",
    capability: "schedule:create",
  }),
  schedule: route({
    method: "GET",
    path: "/api/v1/schedules/:id",
    auth: "authenticated",
    capability: "schedule:read",
  }),
  runScheduleNow: route({
    method: "POST",
    path: "/api/v1/schedules/:id/run-now",
    auth: "authenticated",
    capability: "schedule:run",
  }),
  harnesses: route({
    method: "GET",
    path: "/api/v1/harnesses",
    auth: "authenticated",
    capability: "replicant:manage",
  }),
  doctorHarnesses: route({
    method: "POST",
    path: "/api/v1/harnesses/doctor",
    auth: "authenticated",
    capability: "replicant:manage",
  }),
  runs: route({
    method: "GET",
    path: "/api/v1/runs",
    auth: "authenticated",
    capability: "run:read",
  }),
  run: route({
    method: "GET",
    path: "/api/v1/runs/:id",
    auth: "authenticated",
    capability: "run:read",
  }),
  cancelRun: route({
    method: "POST",
    path: "/api/v1/runs/:id/cancel",
    auth: "authenticated",
    capability: "run:cancel",
  }),
  approvals: route({
    method: "GET",
    path: "/api/v1/approvals",
    auth: "authenticated",
    capability: "approval:read",
  }),
  decideApproval: route({
    method: "POST",
    path: "/api/v1/approvals/:id/decision",
    auth: "authenticated",
    capability: "approval:decide",
  }),
  users: route({
    method: "GET",
    path: "/api/v1/users",
    auth: "authenticated",
    capability: "user:read",
  }),
  createUser: route({
    method: "POST",
    path: "/api/v1/users",
    auth: "authenticated",
    capability: "user:manage",
  }),
  updateUserStatus: route({
    method: "PATCH",
    path: "/api/v1/users/:id/status",
    auth: "authenticated",
    capability: "user:manage",
  }),
  createGrant: route({
    method: "POST",
    path: "/api/v1/grants",
    auth: "authenticated",
    capability: "access:manage",
  }),
  userGrants: route({
    method: "GET",
    path: "/api/v1/users/:id/grants",
    auth: "authenticated",
    capability: "access:manage",
  }),
  files: route({
    method: "GET",
    path: "/api/v1/files",
    auth: "authenticated",
    capability: "file:read",
  }),
  fileText: route({
    method: "GET",
    path: "/api/v1/files/text",
    auth: "authenticated",
    capability: "file:read",
  }),
  writeFileText: route({
    method: "PUT",
    path: "/api/v1/files/text",
    auth: "authenticated",
    capability: "file:write",
  }),
  indexDocument: route({
    method: "POST",
    path: "/api/v1/documents/index",
    auth: "authenticated",
    capability: "artifact:create",
  }),
  documents: route({
    method: "GET",
    path: "/api/v1/documents",
    auth: "authenticated",
    capability: "artifact:read",
  }),
  documentText: route({
    method: "GET",
    path: "/api/v1/documents/:id/text",
    auth: "authenticated",
    capability: "artifact:read",
  }),
  databaseTables: route({
    method: "GET",
    path: "/api/v1/database/tables",
    auth: "authenticated",
    capability: "database:inspect",
  }),
  databaseRows: route({
    method: "GET",
    path: "/api/v1/database/tables/:table/rows",
    auth: "authenticated",
    capability: "database:inspect",
  }),
  notifications: route({
    method: "GET",
    path: "/api/v1/notifications",
    auth: "authenticated",
    capability: "notification:read",
  }),
  readNotification: route({
    method: "POST",
    path: "/api/v1/notifications/:id/read",
    auth: "authenticated",
    capability: "notification:manage",
  }),
  audit: route({
    method: "GET",
    path: "/api/v1/audit",
    auth: "authenticated",
    capability: "audit:read",
  }),
  settings: route({
    method: "GET",
    path: "/api/v1/settings",
    auth: "authenticated",
    capability: "workspace:read",
  }),
  updateSetting: route({
    method: "PUT",
    path: "/api/v1/settings/:key",
    auth: "authenticated",
    capability: "workspace:manage",
  }),
});

export interface HttpContract {
  health: {
    request: undefined;
    response: { service: "replicantos-server"; status: "ok" };
  };
  session: {
    request: undefined;
    response: { actor: ActorResource; expiresAt: string };
  };
  channels: { request: undefined; response: ListPage<ChannelResource> };
  messages: {
    request: { before?: string; channelId: string; limit?: number };
    response: ListPage<MessageResource>;
  };
  replicants: { request: undefined; response: ListPage<ReplicantResource> };
  tasks: { request: { limit?: number }; response: ListPage<TaskResource> };
  schedules: {
    request: { limit?: number };
    response: ListPage<ScheduleResource>;
  };
  runs: {
    request: { limit?: number };
    response: ListPage<PublicHarnessRunResource>;
  };
  approvals: {
    request: { limit?: number };
    response: ListPage<ApprovalResource>;
  };
  files: {
    request: { path: string; root: "library" | "workspace" };
    response: ListPage<FileEntryResource>;
  };
  documents: {
    request: { limit?: number };
    response: ListPage<DocumentResource>;
  };
  notifications: {
    request: { limit?: number };
    response: ListPage<NotificationResource>;
  };
}

export function success<T extends JsonValue>(data: T): ApiSuccess<T> {
  return { data };
}

export function failure(error: ApiError): ApiFailure {
  return { error };
}

export function parseApiEnvelope(value: unknown): ApiEnvelope {
  const envelope = requireRecord(value, "response");
  const hasData = Object.hasOwn(envelope, "data");
  const hasError = Object.hasOwn(envelope, "error");
  if (hasData === hasError) {
    throw new ProtocolValidationError(
      "response must contain exactly one of data or error",
    );
  }
  if (hasData) {
    return { data: requireJsonValue(envelope.data, "response.data") };
  }
  const error = requireRecord(envelope.error, "response.error");
  const code = requireString(error.code, "response.error.code");
  const validCodes: readonly string[] = [
    "authentication_required",
    "conflict",
    "forbidden",
    "internal_error",
    "invalid_credentials",
    "invalid_request",
    "not_found",
    "origin_rejected",
    "rate_limited",
    "service_unavailable",
    "unsupported",
    "version_mismatch",
  ];
  if (!validCodes.includes(code)) {
    throw new ProtocolValidationError(`response.error.code ${code} is unknown`);
  }
  const apiError: ApiError = {
    code: code as ApiErrorCode,
    message: requireString(error.message, "response.error.message"),
  };
  if (error.details !== undefined) {
    apiError.details = requireRecord(
      error.details,
      "response.error.details",
    ) as JsonObject;
  }
  return { error: apiError };
}
