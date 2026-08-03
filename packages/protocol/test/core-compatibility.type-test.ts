import type {
  Actor as CoreActor,
  Approval as CoreApproval,
  ApprovalStatus as CoreApprovalStatus,
  Artifact as CoreArtifact,
  Channel as CoreChannel,
  Message as CoreMessage,
  Notification as CoreNotification,
  Permission as CorePermission,
  Replicant as CoreReplicant,
  Role as CoreRole,
  Run as CoreRun,
  RunStatus as CoreRunStatus,
  RunTrigger as CoreRunTrigger,
  Schedule as CoreSchedule,
  ScheduleStatus as CoreScheduleStatus,
  Task as CoreTask,
  TaskPriority as CoreTaskPriority,
  TaskStatus as CoreTaskStatus,
  User as CoreUser,
} from "../../core/src/index.ts";
import type { Permission as ProtocolPermission } from "../src/permissions.js";
import type {
  ActorResource,
  ApprovalResource,
  ApprovalStatus,
  ArtifactResource,
  ChannelResource,
  HarnessRunResource,
  MessageResource,
  NotificationResource,
  ReplicantResource,
  RunStatus,
  RunTrigger,
  ScheduleResource,
  ScheduleStatus,
  TaskPriority,
  TaskResource,
  TaskStatus,
  UserResource,
  WorkspaceRole,
} from "../src/resources.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Assert<Value extends true> = Value;
type IdentityKey = "id" | `${string}Id` | `${string}By`;
type TimestampKey = `${string}At`;
type WireString<Value> = null extends Value ? string | null : string;
type WireEntity<Entity> = {
  [Key in keyof Entity]: Key extends IdentityKey | TimestampKey
    ? WireString<Entity[Key]>
    : Entity[Key];
};

type CompatibilityAssertions = [
  Assert<Equal<WorkspaceRole, CoreRole>>,
  Assert<Equal<ProtocolPermission, CorePermission>>,
  Assert<Equal<TaskStatus, CoreTaskStatus>>,
  Assert<Equal<TaskPriority, CoreTaskPriority>>,
  Assert<Equal<ScheduleStatus, CoreScheduleStatus>>,
  Assert<Equal<RunStatus, CoreRunStatus>>,
  Assert<Equal<RunTrigger, CoreRunTrigger>>,
  Assert<Equal<ApprovalStatus, CoreApprovalStatus>>,
  Assert<Equal<ActorResource, WireEntity<CoreActor>>>,
  Assert<Equal<UserResource, WireEntity<CoreUser>>>,
  Assert<Equal<ChannelResource, WireEntity<CoreChannel>>>,
  Assert<Equal<MessageResource, WireEntity<CoreMessage>>>,
  Assert<Equal<ReplicantResource, WireEntity<CoreReplicant>>>,
  Assert<Equal<TaskResource, WireEntity<CoreTask>>>,
  Assert<Equal<ScheduleResource, WireEntity<CoreSchedule>>>,
  Assert<Equal<HarnessRunResource, WireEntity<CoreRun>>>,
  Assert<Equal<ApprovalResource, WireEntity<CoreApproval>>>,
  Assert<Equal<NotificationResource, WireEntity<CoreNotification>>>,
  Assert<Equal<ArtifactResource, WireEntity<CoreArtifact>>>,
];

export const coreCompatibilityAssertions: CompatibilityAssertions = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
];
