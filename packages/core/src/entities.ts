import type {
  ApprovalId,
  ArtifactId,
  AuditId,
  BindingId,
  CategoryId,
  ChannelId,
  GrantId,
  IsoTimestamp,
  MessageId,
  NotificationId,
  ProjectId,
  ReplicantId,
  RunEventId,
  RunId,
  ScheduleId,
  SessionId,
  TaskId,
  UserId,
  WorkspaceId,
} from "./ids.ts";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export const roles = ["owner", "admin", "member", "service"] as const;
export type Role = (typeof roles)[number];
export type UserKind = "human" | "service";
export type UserStatus = "active" | "suspended" | "disabled";

export interface Workspace {
  id: WorkspaceId;
  slug: string;
  displayName: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface User {
  id: UserId;
  workspaceId: WorkspaceId;
  kind: UserKind;
  handle: string;
  displayName: string;
  role: Role;
  status: UserStatus;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface Session {
  id: SessionId;
  userId: UserId;
  createdAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  lastSeenAt: IsoTimestamp;
  revokedAt: IsoTimestamp | null;
}

export const permissions = [
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
] as const;
export type Permission = (typeof permissions)[number];
export type ResourceKind = Permission extends `${infer Kind}:${string}`
  ? Kind
  : never;
export type GrantEffect = "allow" | "deny";

export interface AccessGrant {
  id: GrantId;
  workspaceId: WorkspaceId;
  subjectType: "user" | "role";
  subjectUserId: UserId | null;
  subjectRole: Role | null;
  permission: Permission;
  resourceType: ResourceKind;
  resourceId: string | null;
  effect: GrantEffect;
  reason: string | null;
  createdBy: UserId;
  createdAt: IsoTimestamp;
  expiresAt: IsoTimestamp | null;
  revokedAt: IsoTimestamp | null;
}

export interface Category {
  id: CategoryId;
  workspaceId: WorkspaceId;
  name: string;
  position: number;
  createdAt: IsoTimestamp;
}

export type ChannelKind = "standard" | "direct" | "system";
export interface Channel {
  id: ChannelId;
  workspaceId: WorkspaceId;
  categoryId: CategoryId | null;
  kind: ChannelKind;
  slug: string;
  name: string;
  description: string | null;
  archivedAt: IsoTimestamp | null;
  createdBy: UserId;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export type MessageAuthorKind = "user" | "replicant" | "system";
export interface Message {
  id: MessageId;
  channelId: ChannelId;
  replyToId: MessageId | null;
  authorKind: MessageAuthorKind;
  authorUserId: UserId | null;
  authorReplicantId: ReplicantId | null;
  content: string;
  editedAt: IsoTimestamp | null;
  deletedAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
}

export type ReplicantStatus = "active" | "paused" | "archived";
export interface Replicant {
  id: ReplicantId;
  workspaceId: WorkspaceId;
  slug: string;
  name: string;
  description: string | null;
  persona: string;
  defaultHarness: string;
  defaultModel: string | null;
  relativeWorkspacePath: string;
  relativeMemoryPath: string;
  status: ReplicantStatus;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export type ChannelReplicantBehavior =
  | "automatic"
  | "mention-only"
  | "listen-only"
  | "disabled";
export interface ReplicantChannelBinding {
  id: BindingId;
  channelId: ChannelId;
  replicantId: ReplicantId;
  behavior: ChannelReplicantBehavior;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface Project {
  id: ProjectId;
  workspaceId: WorkspaceId;
  slug: string;
  name: string;
  description: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export type TaskStatus =
  | "backlog"
  | "ready"
  | "active"
  | "blocked"
  | "done"
  | "canceled";
export type TaskPriority = "low" | "normal" | "high" | "urgent";
export interface Task {
  id: TaskId;
  workspaceId: WorkspaceId;
  projectId: ProjectId | null;
  title: string;
  notes: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: IsoTimestamp | null;
  assigneeUserId: UserId | null;
  assigneeReplicantId: ReplicantId | null;
  createdBy: UserId;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  completedAt: IsoTimestamp | null;
}

export type ScheduleStatus = "enabled" | "paused" | "archived";
export interface Schedule {
  id: ScheduleId;
  workspaceId: WorkspaceId;
  name: string;
  description: string | null;
  cronExpression: string;
  timezone: string;
  status: ScheduleStatus;
  replicantId: ReplicantId;
  channelId: ChannelId | null;
  taskId: TaskId | null;
  harnessOverride: string | null;
  modelOverride: string | null;
  effortOverride: string | null;
  prompt: string;
  retryPolicy: JsonValue;
  outcomeAssertions: JsonValue;
  nextRunAt: IsoTimestamp | null;
  lastRunAt: IsoTimestamp | null;
  createdBy: UserId;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
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
export interface Run {
  id: RunId;
  workspaceId: WorkspaceId;
  replicantId: ReplicantId;
  channelId: ChannelId | null;
  taskId: TaskId | null;
  scheduleId: ScheduleId | null;
  parentRunId: RunId | null;
  trigger: RunTrigger;
  status: RunStatus;
  harness: string;
  model: string | null;
  effort: string | null;
  harnessSessionKey: string | null;
  requestedBy: UserId | null;
  createdAt: IsoTimestamp;
  startedAt: IsoTimestamp | null;
  finishedAt: IsoTimestamp | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface RunEvent {
  id: RunEventId;
  runId: RunId;
  sequence: number;
  type: string;
  payload: JsonValue;
  createdAt: IsoTimestamp;
}

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "consumed";
export interface Approval {
  id: ApprovalId;
  workspaceId: WorkspaceId;
  runId: RunId | null;
  requestedBy: UserId | null;
  action: string;
  actionDigest: string;
  payload: JsonValue;
  status: ApprovalStatus;
  expiresAt: IsoTimestamp;
  decidedBy: UserId | null;
  decidedAt: IsoTimestamp | null;
  consumedAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
}

export interface Notification {
  id: NotificationId;
  workspaceId: WorkspaceId;
  recipientUserId: UserId;
  kind: string;
  title: string;
  body: string | null;
  resourceType: string | null;
  resourceId: string | null;
  createdAt: IsoTimestamp;
  readAt: IsoTimestamp | null;
}

export type ArtifactKind = "attachment" | "document" | "export" | "run-output";
export interface Artifact {
  id: ArtifactId;
  workspaceId: WorkspaceId;
  kind: ArtifactKind;
  name: string;
  mediaType: string;
  relativePath: string;
  byteSize: number;
  sha256: string;
  searchable: boolean;
  createdByUserId: UserId | null;
  createdByReplicantId: ReplicantId | null;
  metadata: JsonValue;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface AuditRecord {
  id: AuditId;
  workspaceId: WorkspaceId;
  actorKind: "user" | "service" | "system";
  actorUserId: UserId | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  requestId: string | null;
  detail: JsonValue;
  createdAt: IsoTimestamp;
}
