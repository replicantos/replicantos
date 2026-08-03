import type { ReplicantDatabase } from "./database.ts";
import {
  CategoryRepository,
  ChannelRepository,
  MessageRepository,
  ReplicantRepository,
} from "./collaboration-repositories.ts";
import {
  AccessGrantRepository,
  SessionRepository,
  UserRepository,
  WorkspaceRepository,
} from "./identity-repositories.ts";
import {
  ApprovalRepository,
  ArtifactRepository,
  AuditRepository,
  NotificationRepository,
} from "./operations-repositories.ts";
import {
  ProjectRepository,
  RunRepository,
  ScheduleRepository,
  TaskRepository,
} from "./work-repositories.ts";

export interface Repositories {
  workspaces: WorkspaceRepository;
  users: UserRepository;
  sessions: SessionRepository;
  accessGrants: AccessGrantRepository;
  categories: CategoryRepository;
  channels: ChannelRepository;
  messages: MessageRepository;
  replicants: ReplicantRepository;
  projects: ProjectRepository;
  tasks: TaskRepository;
  schedules: ScheduleRepository;
  runs: RunRepository;
  approvals: ApprovalRepository;
  notifications: NotificationRepository;
  artifacts: ArtifactRepository;
  audit: AuditRepository;
}

export function createRepositories(database: ReplicantDatabase): Repositories {
  return {
    workspaces: new WorkspaceRepository(database),
    users: new UserRepository(database),
    sessions: new SessionRepository(database),
    accessGrants: new AccessGrantRepository(database),
    categories: new CategoryRepository(database),
    channels: new ChannelRepository(database),
    messages: new MessageRepository(database),
    replicants: new ReplicantRepository(database),
    projects: new ProjectRepository(database),
    tasks: new TaskRepository(database),
    schedules: new ScheduleRepository(database),
    runs: new RunRepository(database),
    approvals: new ApprovalRepository(database),
    notifications: new NotificationRepository(database),
    artifacts: new ArtifactRepository(database),
    audit: new AuditRepository(database),
  };
}
