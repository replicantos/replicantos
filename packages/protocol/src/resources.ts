import type { HarnessId } from "./harness.js";
import type { JsonValue } from "./schema.js";

export const roles = ["owner", "admin", "member", "service"] as const;
export type WorkspaceRole = (typeof roles)[number];
export type UserKind = "human" | "service";
export type UserStatus = "active" | "suspended" | "disabled";

export interface ActorResource {
  id: string;
  workspaceId: string;
  role: WorkspaceRole;
  kind: UserKind;
  status: UserStatus;
}

export interface UserResource extends ActorResource {
  handle: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export type ChannelKind = "standard" | "direct" | "system";
export interface ChannelResource {
  id: string;
  workspaceId: string;
  categoryId: string | null;
  kind: ChannelKind;
  slug: string;
  name: string;
  description: string | null;
  archivedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type MessageAuthorKind = "user" | "replicant" | "system";
export interface MessageResource {
  id: string;
  channelId: string;
  replyToId: string | null;
  authorKind: MessageAuthorKind;
  authorUserId: string | null;
  authorReplicantId: string | null;
  content: string;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

export type ReplicantStatus = "active" | "paused" | "archived";
export interface ReplicantResource {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  persona: string;
  defaultHarness: HarnessId | string;
  defaultModel: string | null;
  relativeWorkspacePath: string;
  relativeMemoryPath: string;
  status: ReplicantStatus;
  createdAt: string;
  updatedAt: string;
}

export type TaskStatus =
  | "backlog"
  | "ready"
  | "active"
  | "blocked"
  | "done"
  | "canceled";
export type TaskPriority = "low" | "normal" | "high" | "urgent";

export interface TaskResource {
  id: string;
  workspaceId: string;
  projectId: string | null;
  title: string;
  notes: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: string | null;
  assigneeUserId: string | null;
  assigneeReplicantId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type ScheduleStatus = "enabled" | "paused" | "archived";
export interface ScheduleResource {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  cronExpression: string;
  timezone: string;
  status: ScheduleStatus;
  replicantId: string;
  channelId: string | null;
  taskId: string | null;
  harnessOverride: string | null;
  modelOverride: string | null;
  effortOverride: string | null;
  prompt: string;
  retryPolicy: JsonValue;
  outcomeAssertions: JsonValue;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type RunStatus =
  | "queued"
  | "starting"
  | "running"
  | "awaiting-approval"
  | "succeeded"
  | "failed"
  | "canceled";
export type RunTrigger = "message" | "task" | "schedule" | "manual" | "retry";

export interface HarnessRunResource {
  id: string;
  workspaceId: string;
  replicantId: string;
  channelId: string | null;
  taskId: string | null;
  scheduleId: string | null;
  parentRunId: string | null;
  trigger: RunTrigger;
  status: RunStatus;
  harness: string;
  model: string | null;
  effort: string | null;
  harnessSessionKey: string | null;
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

/** Public HTTP run shape. Provider session identifiers stay server-side. */
export type PublicHarnessRunResource = Omit<
  HarnessRunResource,
  "harnessSessionKey"
>;

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "consumed";

export interface ApprovalResource {
  id: string;
  workspaceId: string;
  runId: string | null;
  requestedBy: string | null;
  action: string;
  actionDigest: string;
  payload: JsonValue;
  status: ApprovalStatus;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  consumedAt: string | null;
  createdAt: string;
}

export interface FileEntryResource {
  path: string;
  name: string;
  kind: "directory" | "file";
  byteSize: number | null;
  modifiedAt: string;
}

export type ArtifactKind = "attachment" | "document" | "export" | "run-output";
export interface ArtifactResource {
  id: string;
  workspaceId: string;
  kind: ArtifactKind;
  name: string;
  mediaType: string;
  relativePath: string;
  byteSize: number;
  sha256: string;
  searchable: boolean;
  createdByUserId: string | null;
  createdByReplicantId: string | null;
  metadata: JsonValue;
  createdAt: string;
  updatedAt: string;
}

export type DocumentResource = ArtifactResource & { kind: "document" };

export interface NotificationResource {
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
