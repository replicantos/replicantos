export interface ApiFailureBody {
  error?: {
    code?: string;
    message?: string;
  };
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export interface Actor {
  id: string;
  workspaceId: string;
  kind: "human" | "service";
  handle: string;
  displayName: string;
  role: "owner" | "admin" | "member" | "service";
  status: "active" | "suspended" | "disabled";
}

export interface Channel {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  kind: "standard" | "direct" | "system";
}

export interface Message {
  id: string;
  channelId: string;
  authorKind: "user" | "replicant" | "system";
  authorUserId: string | null;
  authorReplicantId: string | null;
  content: string;
  createdAt: string;
}

export interface Notification {
  id: string;
  workspaceId: string;
  recipientUserId: string;
  kind: string;
  title: string;
  body: string | null;
  resourceType: string | null;
  resourceId: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface Replicant {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  persona: string;
  defaultHarness: "codex" | "claude" | "opencode" | "grok";
  defaultModel: string | null;
  status: "active" | "paused" | "archived";
}

export type TaskStatus =
  | "backlog"
  | "ready"
  | "active"
  | "blocked"
  | "done"
  | "canceled";

export interface Task {
  id: string;
  workspaceId: string;
  title: string;
  notes: string | null;
  status: TaskStatus;
  priority: "low" | "normal" | "high" | "urgent";
  dueAt: string | null;
  assigneeUserId: string | null;
  assigneeReplicantId: string | null;
}

export interface Schedule {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  cronExpression: string;
  timezone: string;
  status: "enabled" | "paused" | "archived";
  replicantId: string;
  harnessOverride: "codex" | "claude" | "opencode" | "grok" | null;
  modelOverride: string | null;
  prompt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export interface Run {
  id: string;
  workspaceId: string;
  replicantId: string;
  channelId: string | null;
  taskId: string | null;
  scheduleId: string | null;
  parentRunId: string | null;
  trigger: "message" | "task" | "schedule" | "manual" | "retry";
  status:
    | "queued"
    | "starting"
    | "running"
    | "awaiting-approval"
    | "succeeded"
    | "failed"
    | "canceled";
  harness: string;
  model: string | null;
  effort: string | null;
  requestedBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface RunProjection {
  runId: string;
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  costMicros: number | null;
  assistantText: string;
  cancellationRequestedAt: string | null;
}

export interface RunEvent {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface RunDetail {
  run: Run;
  projection: RunProjection | null;
  events: RunEvent[];
}

export interface Approval {
  id: string;
  workspaceId: string;
  runId: string | null;
  requestedBy: string | null;
  action: string;
  actionDigest: string;
  payload: unknown;
  status: "pending" | "approved" | "denied" | "expired" | "consumed";
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  consumedAt: string | null;
  createdAt: string;
}

export type { DoctorResult, HarnessManifest };

export interface Settings {
  "ui.theme": string | null;
  "ui.timezone": string | null;
  "terminal.enabled": boolean;
  "telemetry.enabled": boolean;
}

export interface AccessGrant {
  id: string;
  workspaceId: string;
  subjectType: "user" | "role";
  subjectUserId: string | null;
  subjectRole: Actor["role"] | null;
  permission: Permission;
  resourceType: ResourceKind;
  resourceId: string | null;
  effect: "allow" | "deny";
  reason: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface AuditRecord {
  id: string;
  workspaceId: string;
  actorKind: "user" | "service" | "system";
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  requestId: string | null;
  detail: unknown;
  createdAt: string;
}

export type ApprovedFileRoot = "library" | "workspace";

export interface FileEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  byteSize: number | null;
  modifiedAt: string;
}

export interface TextFile {
  path: string;
  content: string;
  byteSize: number;
  modifiedAt: string;
}

export interface Artifact {
  id: string;
  workspaceId: string;
  kind: "attachment" | "document" | "export" | "run-output";
  name: string;
  mediaType: string;
  relativePath: string;
  byteSize: number;
  sha256: string;
  searchable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DatabaseTable {
  name: string;
  columns: readonly { name: string; masked: boolean }[];
}

export type DatabaseValue = string | number | boolean | null;

export interface DatabasePage {
  table: string;
  rows: readonly Record<string, DatabaseValue>[];
  nextOffset: number | null;
}

interface DataEnvelope<Value> {
  data: Value;
}

async function decodeFailure(response: Response): Promise<ApiError> {
  let body: ApiFailureBody = {};
  try {
    body = (await response.json()) as ApiFailureBody;
  } catch {
    // The server boundary still maps the response to a generic local error.
  }
  return new ApiError(
    response.status,
    body.error?.code ?? "request_failed",
    body.error?.message ?? "The local server could not complete the request.",
  );
}

export async function api<Value>(
  path: string,
  init: RequestInit = {},
): Promise<Value> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: "include",
    headers,
  });
  if (!response.ok) throw await decodeFailure(response);
  return ((await response.json()) as DataEnvelope<Value>).data;
}

export function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

export function isAuthenticationError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}
import type {
  DoctorResult,
  HarnessManifest,
} from "@replicantos/protocol/harness";
import type { Permission, ResourceKind } from "@replicantos/protocol";
