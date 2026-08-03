import type {
  AccessGrant,
  Approval,
  Artifact,
  AuditRecord,
  Category,
  Channel,
  Message,
  Notification,
  Project,
  Replicant,
  ReplicantChannelBinding,
  Run,
  Schedule,
  Task,
  User,
  Workspace,
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
  RunId,
  ScheduleId,
  TaskId,
  UserId,
  WorkspaceId,
} from "@replicantos/core";

import { connectionFor, type ReplicantDatabase } from "./database.ts";
import { createRepositories } from "./repositories.ts";

export const DEMO_SEED_VERSION = 1;
export const DEMO_NOW = "2026-04-14T15:30:00.000Z" as IsoTimestamp;

export const demoIds = {
  workspace: "wsp_demo0001" as WorkspaceId,
  owner: "usr_owner001" as UserId,
  member: "usr_member01" as UserId,
  service: "usr_service1" as UserId,
  grantChannelRead: "grt_read0001" as GrantId,
  grantChannelWrite: "grt_write001" as GrantId,
  grantReplicantInteract: "grt_interact1" as GrantId,
  category: "cat_workspace" as CategoryId,
  channelGeneral: "chn_general1" as ChannelId,
  channelOps: "chn_ops00001" as ChannelId,
  replicantAtlas: "rep_atlas001" as ReplicantId,
  replicantQuill: "rep_quill001" as ReplicantId,
  bindingGeneral: "rbd_general1" as BindingId,
  bindingOps: "rbd_ops00001" as BindingId,
  messageWelcome: "msg_welcome1" as MessageId,
  messageStatus: "msg_status01" as MessageId,
  project: "prj_launch01" as ProjectId,
  taskReady: "tsk_review01" as TaskId,
  taskDone: "tsk_verify01" as TaskId,
  schedule: "sch_health01" as ScheduleId,
  run: "run_health01" as RunId,
  approval: "apr_publish1" as ApprovalId,
  notification: "ntf_ready001" as NotificationId,
  artifact: "art_runbook1" as ArtifactId,
  audit: "aud_seed0001" as AuditId,
} as const;

const t = {
  created: "2026-04-14T14:00:00.000Z" as IsoTimestamp,
  messageOne: "2026-04-14T14:05:00.000Z" as IsoTimestamp,
  messageTwo: "2026-04-14T14:08:00.000Z" as IsoTimestamp,
  runStart: "2026-04-14T15:00:00.000Z" as IsoTimestamp,
  runFinish: "2026-04-14T15:02:00.000Z" as IsoTimestamp,
  due: "2026-04-15T17:00:00.000Z" as IsoTimestamp,
  nextSchedule: "2026-04-15T09:00:00.000Z" as IsoTimestamp,
  approvalExpiry: "2026-04-15T15:30:00.000Z" as IsoTimestamp,
} as const;

export interface DemoSeedResult {
  applied: boolean;
  version: number;
  workspaceId: typeof demoIds.workspace;
}

export function seedSyntheticDemo(database: ReplicantDatabase): DemoSeedResult {
  return database.transaction(() => {
    const repositories = createRepositories(database);
    const existingWorkspace = repositories.workspaces.getOnly();
    if (
      existingWorkspace !== null &&
      existingWorkspace.id !== demoIds.workspace
    ) {
      throw new Error(
        "Synthetic demo data can only be seeded into an empty or demo workspace",
      );
    }

    const existingVersion = repositories.workspaces.getSetting(
      demoIds.workspace,
      "demo.seed.version",
    );
    if (existingVersion !== null) {
      if (existingVersion !== DEMO_SEED_VERSION) {
        throw new Error(
          "Synthetic demo seed version does not match this application",
        );
      }
      return {
        applied: false,
        version: DEMO_SEED_VERSION,
        workspaceId: demoIds.workspace,
      };
    }

    const workspace: Workspace = {
      id: demoIds.workspace,
      slug: "demo",
      displayName: "ReplicantOS Demo",
      createdAt: t.created,
      updatedAt: DEMO_NOW,
    };
    if (existingWorkspace === null) repositories.workspaces.create(workspace);

    const owner: User = {
      id: demoIds.owner,
      workspaceId: demoIds.workspace,
      kind: "human",
      handle: "owner",
      displayName: "Demo Owner",
      role: "owner",
      status: "active",
      createdAt: t.created,
      updatedAt: t.created,
    };
    const member: User = {
      id: demoIds.member,
      workspaceId: demoIds.workspace,
      kind: "human",
      handle: "operator",
      displayName: "Demo Operator",
      role: "member",
      status: "active",
      createdAt: t.created,
      updatedAt: t.created,
    };
    const service: User = {
      id: demoIds.service,
      workspaceId: demoIds.workspace,
      kind: "service",
      handle: "scheduler",
      displayName: "Scheduler Service",
      role: "service",
      status: "active",
      createdAt: t.created,
      updatedAt: t.created,
    };
    repositories.users.create({ user: owner, passwordHash: null });
    repositories.users.create({ user: member, passwordHash: null });
    repositories.users.create({ user: service, passwordHash: null });

    const category: Category = {
      id: demoIds.category,
      workspaceId: demoIds.workspace,
      name: "Workspace",
      position: 0,
      createdAt: t.created,
    };
    repositories.categories.create(category);

    const channelGeneral: Channel = {
      id: demoIds.channelGeneral,
      workspaceId: demoIds.workspace,
      categoryId: demoIds.category,
      kind: "standard",
      slug: "general",
      name: "General",
      description: "Shared planning and coordination.",
      archivedAt: null,
      createdBy: demoIds.owner,
      createdAt: t.created,
      updatedAt: t.created,
    };
    const channelOps: Channel = {
      ...channelGeneral,
      id: demoIds.channelOps,
      slug: "operations",
      name: "Operations",
      description: "Scheduled checks, runs, and approvals.",
    };
    repositories.channels.create(channelGeneral);
    repositories.channels.create(channelOps);

    const atlas: Replicant = {
      id: demoIds.replicantAtlas,
      workspaceId: demoIds.workspace,
      slug: "atlas",
      name: "Atlas",
      description: "Coordinates plans, tasks, and operational handoffs.",
      persona: "Be precise, practical, and explicit about uncertainty.",
      defaultHarness: "codex",
      defaultModel: null,
      relativeWorkspacePath: "replicants/atlas/workspace",
      relativeMemoryPath: "replicants/atlas/workspace/memory",
      status: "active",
      createdAt: t.created,
      updatedAt: t.created,
    };
    const quill: Replicant = {
      ...atlas,
      id: demoIds.replicantQuill,
      slug: "quill",
      name: "Quill",
      description: "Turns technical work into clear documentation.",
      persona: "Write clearly, preserve facts, and avoid unsupported claims.",
      defaultHarness: "claude",
      relativeWorkspacePath: "replicants/quill/workspace",
      relativeMemoryPath: "replicants/quill/workspace/memory",
    };
    repositories.replicants.create(atlas);
    repositories.replicants.create(quill);

    const bindingGeneral: ReplicantChannelBinding = {
      id: demoIds.bindingGeneral,
      channelId: demoIds.channelGeneral,
      replicantId: demoIds.replicantAtlas,
      behavior: "mention-only",
      createdAt: t.created,
      updatedAt: t.created,
    };
    const bindingOps: ReplicantChannelBinding = {
      id: demoIds.bindingOps,
      channelId: demoIds.channelOps,
      replicantId: demoIds.replicantAtlas,
      behavior: "automatic",
      createdAt: t.created,
      updatedAt: t.created,
    };
    repositories.replicants.bind(bindingGeneral);
    repositories.replicants.bind(bindingOps);

    const grants: AccessGrant[] = [
      {
        id: demoIds.grantChannelRead,
        workspaceId: demoIds.workspace,
        subjectType: "user",
        subjectUserId: demoIds.member,
        subjectRole: null,
        permission: "channel:read",
        resourceType: "channel",
        resourceId: demoIds.channelGeneral,
        effect: "allow",
        reason: "Synthetic demo access",
        createdBy: demoIds.owner,
        createdAt: t.created,
        expiresAt: null,
        revokedAt: null,
      },
      {
        id: demoIds.grantChannelWrite,
        workspaceId: demoIds.workspace,
        subjectType: "user",
        subjectUserId: demoIds.member,
        subjectRole: null,
        permission: "channel:write",
        resourceType: "channel",
        resourceId: demoIds.channelGeneral,
        effect: "allow",
        reason: "Synthetic demo access",
        createdBy: demoIds.owner,
        createdAt: t.created,
        expiresAt: null,
        revokedAt: null,
      },
      {
        id: demoIds.grantReplicantInteract,
        workspaceId: demoIds.workspace,
        subjectType: "user",
        subjectUserId: demoIds.member,
        subjectRole: null,
        permission: "replicant:interact",
        resourceType: "replicant",
        resourceId: demoIds.replicantAtlas,
        effect: "allow",
        reason: "Synthetic demo access",
        createdBy: demoIds.owner,
        createdAt: t.created,
        expiresAt: null,
        revokedAt: null,
      },
    ];
    for (const grant of grants) repositories.accessGrants.create(grant);

    const welcome: Message = {
      id: demoIds.messageWelcome,
      channelId: demoIds.channelGeneral,
      replyToId: null,
      authorKind: "user",
      authorUserId: demoIds.owner,
      authorReplicantId: null,
      content: "Welcome to the offline ReplicantOS demo workspace.",
      editedAt: null,
      deletedAt: null,
      createdAt: t.messageOne,
    };
    const statusMessage: Message = {
      id: demoIds.messageStatus,
      channelId: demoIds.channelGeneral,
      replyToId: demoIds.messageWelcome,
      authorKind: "replicant",
      authorUserId: null,
      authorReplicantId: demoIds.replicantAtlas,
      content:
        "The launch checklist is ready. Reference: https://docs.example.invalid/runbook",
      editedAt: null,
      deletedAt: null,
      createdAt: t.messageTwo,
    };
    repositories.messages.create(welcome);
    repositories.messages.create(statusMessage);

    const project: Project = {
      id: demoIds.project,
      workspaceId: demoIds.workspace,
      slug: "public-launch",
      name: "Public Launch",
      description: "Synthetic project data for product demonstrations.",
      createdAt: t.created,
      updatedAt: DEMO_NOW,
    };
    repositories.projects.create(project);

    const reviewTask: Task = {
      id: demoIds.taskReady,
      workspaceId: demoIds.workspace,
      projectId: demoIds.project,
      title: "Review harness health report",
      notes: "Confirm every adapter reports its real capabilities.",
      status: "ready",
      priority: "high",
      dueAt: t.due,
      assigneeUserId: null,
      assigneeReplicantId: demoIds.replicantAtlas,
      createdBy: demoIds.owner,
      createdAt: t.created,
      updatedAt: DEMO_NOW,
      completedAt: null,
    };
    const verifiedTask: Task = {
      ...reviewTask,
      id: demoIds.taskDone,
      title: "Verify synthetic demo privacy gate",
      notes: "The deterministic fixture contains no live workspace data.",
      status: "done",
      priority: "normal",
      dueAt: null,
      assigneeReplicantId: null,
      assigneeUserId: demoIds.member,
      completedAt: t.runFinish,
    };
    repositories.tasks.create(reviewTask);
    repositories.tasks.create(verifiedTask);

    const schedule: Schedule = {
      id: demoIds.schedule,
      workspaceId: demoIds.workspace,
      name: "Weekday harness health check",
      description:
        "Runs a capability and authentication check without network access in demo mode.",
      cronExpression: "0 9 * * 1-5",
      timezone: "Etc/UTC",
      status: "enabled",
      replicantId: demoIds.replicantAtlas,
      channelId: demoIds.channelOps,
      taskId: null,
      harnessOverride: "codex",
      modelOverride: null,
      effortOverride: "medium",
      prompt:
        "Run the local harness doctor checks and summarize capability status.",
      retryPolicy: {
        maxAttempts: 2,
        initialDelayMs: 60_000,
        multiplier: 2,
        maxDelayMs: 300_000,
      },
      outcomeAssertions: { requiresSummary: true },
      nextRunAt: t.nextSchedule,
      lastRunAt: t.runStart,
      createdBy: demoIds.owner,
      createdAt: t.created,
      updatedAt: t.runStart,
    };
    repositories.schedules.create(schedule);

    const run: Run = {
      id: demoIds.run,
      workspaceId: demoIds.workspace,
      replicantId: demoIds.replicantAtlas,
      channelId: demoIds.channelOps,
      taskId: demoIds.taskDone,
      scheduleId: demoIds.schedule,
      parentRunId: null,
      trigger: "schedule",
      status: "succeeded",
      harness: "codex",
      model: "demo-model",
      effort: "medium",
      harnessSessionKey: "demo-session-001",
      requestedBy: demoIds.service,
      createdAt: t.runStart,
      startedAt: t.runStart,
      finishedAt: t.runFinish,
      inputTokens: 420,
      outputTokens: 180,
      costMicros: 0,
      errorCode: null,
      errorMessage: null,
    };
    repositories.runs.create(run);

    const approval: Approval = {
      id: demoIds.approval,
      workspaceId: demoIds.workspace,
      runId: null,
      requestedBy: demoIds.member,
      action: "Publish generated launch note",
      actionDigest: "a".repeat(64),
      payload: { destination: "https://social.example.invalid/preview" },
      status: "pending",
      expiresAt: t.approvalExpiry,
      decidedBy: null,
      decidedAt: null,
      consumedAt: null,
      createdAt: DEMO_NOW,
    };
    repositories.approvals.create(approval);

    const notification: Notification = {
      id: demoIds.notification,
      workspaceId: demoIds.workspace,
      recipientUserId: demoIds.member,
      kind: "task-ready",
      title: "Harness health report is ready",
      body: "Review the synthetic report before the next scheduled check.",
      resourceType: "task",
      resourceId: demoIds.taskReady,
      createdAt: DEMO_NOW,
      readAt: null,
    };
    repositories.notifications.create(notification);

    const artifact: Artifact = {
      id: demoIds.artifact,
      workspaceId: demoIds.workspace,
      kind: "document",
      name: "Demo Runbook",
      mediaType: "text/markdown",
      relativePath: "documents/demo-runbook.md",
      byteSize: 55,
      sha256:
        "7e10a1acccc636854a21017bf076e0e81344127c9519aee09dee16b551c594fa",
      searchable: true,
      createdByUserId: null,
      createdByReplicantId: demoIds.replicantQuill,
      metadata: {
        source: "synthetic-demo",
        canonicalUrl: "https://docs.example.invalid/runbook",
      },
      createdAt: t.created,
      updatedAt: DEMO_NOW,
    };
    repositories.artifacts.create(artifact);

    const audit: AuditRecord = {
      id: demoIds.audit,
      workspaceId: demoIds.workspace,
      actorKind: "system",
      actorUserId: null,
      action: "demo.seeded",
      resourceType: "workspace",
      resourceId: demoIds.workspace,
      requestId: null,
      detail: { seedVersion: DEMO_SEED_VERSION, deterministic: true },
      createdAt: DEMO_NOW,
    };
    repositories.audit.append(audit);

    repositories.workspaces.setSetting(
      demoIds.workspace,
      "demo.baseUrl",
      "https://console.example.invalid",
      demoIds.owner,
      DEMO_NOW,
    );
    repositories.workspaces.setSetting(
      demoIds.workspace,
      "demo.seed.version",
      DEMO_SEED_VERSION,
      demoIds.owner,
      DEMO_NOW,
    );

    const foreignKeyFailures = connectionFor(database)
      .prepare("PRAGMA foreign_key_check")
      .all();
    if (foreignKeyFailures.length !== 0)
      throw new Error("Synthetic demo seed violates foreign keys");

    return {
      applied: true,
      version: DEMO_SEED_VERSION,
      workspaceId: demoIds.workspace,
    };
  });
}
