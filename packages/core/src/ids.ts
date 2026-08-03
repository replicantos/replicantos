const idBrand: unique symbol = Symbol("replicantos.entity-id");
const timestampBrand: unique symbol = Symbol("replicantos.iso-timestamp");

export const entityIdPrefixes = {
  workspace: "wsp",
  user: "usr",
  session: "ses",
  grant: "grt",
  category: "cat",
  channel: "chn",
  message: "msg",
  reaction: "rct",
  attachment: "att",
  replicant: "rep",
  binding: "rbd",
  project: "prj",
  task: "tsk",
  schedule: "sch",
  run: "run",
  runEvent: "evt",
  approval: "apr",
  notification: "ntf",
  artifact: "art",
  audit: "aud",
} as const;

export type EntityKind = keyof typeof entityIdPrefixes;
export type EntityId<Kind extends EntityKind> = string & {
  readonly [idBrand]: Kind;
};

export type WorkspaceId = EntityId<"workspace">;
export type UserId = EntityId<"user">;
export type SessionId = EntityId<"session">;
export type GrantId = EntityId<"grant">;
export type CategoryId = EntityId<"category">;
export type ChannelId = EntityId<"channel">;
export type MessageId = EntityId<"message">;
export type ReactionId = EntityId<"reaction">;
export type AttachmentId = EntityId<"attachment">;
export type ReplicantId = EntityId<"replicant">;
export type BindingId = EntityId<"binding">;
export type ProjectId = EntityId<"project">;
export type TaskId = EntityId<"task">;
export type ScheduleId = EntityId<"schedule">;
export type RunId = EntityId<"run">;
export type RunEventId = EntityId<"runEvent">;
export type ApprovalId = EntityId<"approval">;
export type NotificationId = EntityId<"notification">;
export type ArtifactId = EntityId<"artifact">;
export type AuditId = EntityId<"audit">;

export type IsoTimestamp = string & { readonly [timestampBrand]: true };

const suffixPattern = /^[a-z0-9](?:[a-z0-9_-]{6,62}[a-z0-9])?$/;

export function entityId<Kind extends EntityKind>(
  kind: Kind,
  value: string,
): EntityId<Kind> {
  const prefix = `${entityIdPrefixes[kind]}_`;
  const suffix = value.startsWith(prefix) ? value.slice(prefix.length) : "";

  if (!suffixPattern.test(suffix)) {
    throw new TypeError(`Invalid ${kind} identifier`);
  }

  return value as EntityId<Kind>;
}

export function createEntityId<Kind extends EntityKind>(
  kind: Kind,
  suffix: string,
): EntityId<Kind> {
  return entityId(kind, `${entityIdPrefixes[kind]}_${suffix}`);
}

export function isEntityId<Kind extends EntityKind>(
  kind: Kind,
  value: unknown,
): value is EntityId<Kind> {
  if (typeof value !== "string") return false;
  try {
    entityId(kind, value);
    return true;
  } catch {
    return false;
  }
}

export function isoTimestamp(value: string): IsoTimestamp {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError("Timestamp must be an ISO-8601 UTC instant");
  }
  return value as IsoTimestamp;
}
