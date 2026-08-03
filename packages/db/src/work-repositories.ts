import type {
  ChannelId,
  IsoTimestamp,
  Project,
  ProjectId,
  ReplicantId,
  Run,
  RunEvent,
  RunId,
  RunStatus,
  Schedule,
  ScheduleId,
  Task,
  TaskId,
  TaskStatus,
  WorkspaceId,
} from "@replicantos/core";
import { parseCronExpression, parseRetryPolicy } from "@replicantos/runtime";

import { connectionFor, type ReplicantDatabase } from "./database.ts";
import {
  cappedLimit,
  jsonText,
  optionalText,
  parseJson,
  requiredText,
} from "./validation.ts";

function mapProject(row: Record<string, unknown>): Project {
  return {
    id: row.id as ProjectId,
    workspaceId: row.workspace_id as WorkspaceId,
    slug: row.slug as string,
    name: row.name as string,
    description: row.description as string | null,
    createdAt: row.created_at as IsoTimestamp,
    updatedAt: row.updated_at as IsoTimestamp,
  };
}

function mapTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as TaskId,
    workspaceId: row.workspace_id as WorkspaceId,
    projectId: row.project_id as Task["projectId"],
    title: row.title as string,
    notes: row.notes as string | null,
    status: row.status as TaskStatus,
    priority: row.priority as Task["priority"],
    dueAt: row.due_at as IsoTimestamp | null,
    assigneeUserId: row.assignee_user_id as Task["assigneeUserId"],
    assigneeReplicantId:
      row.assignee_replicant_id as Task["assigneeReplicantId"],
    createdBy: row.created_by as Task["createdBy"],
    createdAt: row.created_at as IsoTimestamp,
    updatedAt: row.updated_at as IsoTimestamp,
    completedAt: row.completed_at as IsoTimestamp | null,
  };
}

function mapSchedule(row: Record<string, unknown>): Schedule {
  return {
    id: row.id as ScheduleId,
    workspaceId: row.workspace_id as WorkspaceId,
    name: row.name as string,
    description: row.description as string | null,
    cronExpression: row.cron_expression as string,
    timezone: row.timezone as string,
    status: row.status as Schedule["status"],
    replicantId: row.replicant_id as Schedule["replicantId"],
    channelId: row.channel_id as Schedule["channelId"],
    taskId: row.task_id as TaskId | null,
    harnessOverride: row.harness_override as string | null,
    modelOverride: row.model_override as string | null,
    effortOverride: row.effort_override as string | null,
    prompt: row.prompt as string,
    retryPolicy: parseJson(row.retry_policy_json as string),
    outcomeAssertions: parseJson(row.outcome_assertions_json as string),
    nextRunAt: row.next_run_at as IsoTimestamp | null,
    lastRunAt: row.last_run_at as IsoTimestamp | null,
    createdBy: row.created_by as Schedule["createdBy"],
    createdAt: row.created_at as IsoTimestamp,
    updatedAt: row.updated_at as IsoTimestamp,
  };
}

function mapRun(row: Record<string, unknown>): Run {
  return {
    id: row.id as RunId,
    workspaceId: row.workspace_id as WorkspaceId,
    replicantId: row.replicant_id as Run["replicantId"],
    channelId: row.channel_id as Run["channelId"],
    taskId: row.task_id as TaskId | null,
    scheduleId: row.schedule_id as ScheduleId | null,
    parentRunId: row.parent_run_id as RunId | null,
    trigger: row.trigger_type as Run["trigger"],
    status: row.status as RunStatus,
    harness: row.harness as string,
    model: row.model as string | null,
    effort: row.effort as string | null,
    harnessSessionKey: row.harness_session_key as string | null,
    requestedBy: row.requested_by as Run["requestedBy"],
    createdAt: row.created_at as IsoTimestamp,
    startedAt: row.started_at as IsoTimestamp | null,
    finishedAt: row.finished_at as IsoTimestamp | null,
    inputTokens: row.input_tokens as number | null,
    outputTokens: row.output_tokens as number | null,
    costMicros: row.cost_micros as number | null,
    errorCode: row.error_code as string | null,
    errorMessage: row.error_message as string | null,
  };
}

export class ProjectRepository {
  constructor(private readonly database: ReplicantDatabase) {}

  create(project: Project): Project {
    connectionFor(this.database)
      .prepare(
        `INSERT INTO projects(id, workspace_id, slug, name, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        project.workspaceId,
        requiredText(project.slug, "project slug", 64),
        requiredText(project.name, "project name", 120),
        optionalText(project.description, "project description", 2_000),
        project.createdAt,
        project.updatedAt,
      );
    return project;
  }

  list(workspaceId: WorkspaceId): Project[] {
    const rows = connectionFor(this.database)
      .prepare(
        "SELECT * FROM projects WHERE workspace_id = ? ORDER BY name COLLATE NOCASE",
      )
      .all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map(mapProject);
  }
}

export class TaskRepository {
  constructor(private readonly database: ReplicantDatabase) {}

  create(task: Task): Task {
    connectionFor(this.database)
      .prepare(
        `INSERT INTO tasks(
          id, workspace_id, project_id, title, notes, status, priority, due_at,
          assignee_user_id, assignee_replicant_id, created_by, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.workspaceId,
        task.projectId,
        requiredText(task.title, "task title", 500),
        optionalText(task.notes, "task notes", 50_000),
        task.status,
        task.priority,
        task.dueAt,
        task.assigneeUserId,
        task.assigneeReplicantId,
        task.createdBy,
        task.createdAt,
        task.updatedAt,
        task.completedAt,
      );
    return task;
  }

  get(id: TaskId): Task | null {
    const row = connectionFor(this.database)
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? null : mapTask(row);
  }

  list(
    workspaceId: WorkspaceId,
    options: {
      status?: TaskStatus;
      projectId?: ProjectId;
      limit?: number;
    } = {},
  ): Task[] {
    const rows = connectionFor(this.database)
      .prepare(
        `SELECT * FROM tasks
         WHERE workspace_id = ?
           AND (? IS NULL OR status = ?)
           AND (? IS NULL OR project_id = ?)
         ORDER BY
           CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
           due_at IS NULL, due_at, created_at
         LIMIT ?`,
      )
      .all(
        workspaceId,
        options.status ?? null,
        options.status ?? null,
        options.projectId ?? null,
        options.projectId ?? null,
        cappedLimit(options.limit),
      ) as Array<Record<string, unknown>>;
    return rows.map(mapTask);
  }

  setStatus(id: TaskId, status: TaskStatus, now: IsoTimestamp): Task {
    const completedAt = status === "done" ? now : null;
    const result = connectionFor(this.database)
      .prepare(
        "UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, completedAt, now, id);
    if (result.changes !== 1) throw new Error("Task not found");
    const task = this.get(id);
    if (task === null) throw new Error("Task disappeared during update");
    return task;
  }
}

function validateCronExpression(value: string): string {
  const expression = requiredText(value, "cron expression", 200);
  parseCronExpression(expression);
  return expression;
}

function validateTimezone(value: string): string {
  const timezone = requiredText(value, "timezone", 100);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
  } catch {
    throw new TypeError("timezone must be a supported IANA timezone");
  }
  return timezone;
}

export class ScheduleRepository {
  constructor(private readonly database: ReplicantDatabase) {}

  create(schedule: Schedule): Schedule {
    connectionFor(this.database)
      .prepare(
        `INSERT INTO schedules(
          id, workspace_id, name, description, cron_expression, timezone, status,
          replicant_id, channel_id, task_id, harness_override, model_override, effort_override,
          prompt, retry_policy_json, outcome_assertions_json, next_run_at, last_run_at,
          created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        schedule.id,
        schedule.workspaceId,
        requiredText(schedule.name, "schedule name", 160),
        optionalText(schedule.description, "schedule description", 2_000),
        validateCronExpression(schedule.cronExpression),
        validateTimezone(schedule.timezone),
        schedule.status,
        schedule.replicantId,
        schedule.channelId,
        schedule.taskId,
        schedule.harnessOverride,
        schedule.modelOverride,
        schedule.effortOverride,
        requiredText(schedule.prompt, "schedule prompt", 100_000),
        jsonText({ ...parseRetryPolicy(schedule.retryPolicy) }),
        jsonText(schedule.outcomeAssertions),
        schedule.nextRunAt,
        schedule.lastRunAt,
        schedule.createdBy,
        schedule.createdAt,
        schedule.updatedAt,
      );
    return schedule;
  }

  get(id: ScheduleId): Schedule | null {
    const row = connectionFor(this.database)
      .prepare("SELECT * FROM schedules WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? null : mapSchedule(row);
  }

  listDue(now: IsoTimestamp, limit?: number): Schedule[] {
    const rows = connectionFor(this.database)
      .prepare(
        `SELECT * FROM schedules
         WHERE status = 'enabled' AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at, id LIMIT ?`,
      )
      .all(now, cappedLimit(limit, 25, 100)) as Array<Record<string, unknown>>;
    return rows.map(mapSchedule);
  }

  list(workspaceId: WorkspaceId, limit?: number): Schedule[] {
    const rows = connectionFor(this.database)
      .prepare(
        `SELECT * FROM schedules WHERE workspace_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(workspaceId, cappedLimit(limit, 100, 200)) as Array<
      Record<string, unknown>
    >;
    return rows.map(mapSchedule);
  }

  recordRun(
    id: ScheduleId,
    ranAt: IsoTimestamp,
    nextRunAt: IsoTimestamp | null,
  ): Schedule {
    const result = connectionFor(this.database)
      .prepare(
        "UPDATE schedules SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(ranAt, nextRunAt, ranAt, id);
    if (result.changes !== 1) throw new Error("Schedule not found");
    const schedule = this.get(id);
    if (schedule === null)
      throw new Error("Schedule disappeared during update");
    return schedule;
  }
}

const allowedRunTransitions: Readonly<Record<RunStatus, readonly RunStatus[]>> =
  {
    queued: ["starting", "canceled"],
    starting: ["running", "failed", "canceled"],
    running: ["awaiting-approval", "succeeded", "failed", "canceled"],
    "awaiting-approval": ["running", "failed", "canceled"],
    succeeded: [],
    failed: [],
    canceled: [],
  };

export interface RunTransition {
  status: RunStatus;
  at: IsoTimestamp;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costMicros?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export class RunRepository {
  constructor(private readonly database: ReplicantDatabase) {}

  create(run: Run): Run {
    connectionFor(this.database)
      .prepare(
        `INSERT INTO runs(
          id, workspace_id, replicant_id, channel_id, task_id, schedule_id, parent_run_id,
          trigger_type, status, harness, model, effort, harness_session_key, requested_by,
          created_at, started_at, finished_at, input_tokens, output_tokens, cost_micros,
          error_code, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.workspaceId,
        run.replicantId,
        run.channelId,
        run.taskId,
        run.scheduleId,
        run.parentRunId,
        run.trigger,
        run.status,
        requiredText(run.harness, "harness", 80),
        run.model,
        run.effort,
        run.harnessSessionKey,
        run.requestedBy,
        run.createdAt,
        run.startedAt,
        run.finishedAt,
        run.inputTokens,
        run.outputTokens,
        run.costMicros,
        run.errorCode,
        run.errorMessage,
      );
    return run;
  }

  get(id: RunId): Run | null {
    const row = connectionFor(this.database)
      .prepare("SELECT * FROM runs WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? null : mapRun(row);
  }

  findLatestSession(
    workspaceId: WorkspaceId,
    replicantId: ReplicantId,
    channelId: ChannelId | null,
    harness: string,
  ): { runId: RunId; sessionId: string } | null {
    const row = connectionFor(this.database)
      .prepare(
        `SELECT id, harness_session_key FROM runs
         WHERE workspace_id = ? AND replicant_id = ? AND channel_id IS ?
           AND harness = ? AND status = 'succeeded'
           AND harness_session_key IS NOT NULL
         ORDER BY finished_at DESC, created_at DESC, id DESC LIMIT 1`,
      )
      .get(workspaceId, replicantId, channelId, harness) as
      | { id: RunId; harness_session_key: string }
      | undefined;
    return row === undefined
      ? null
      : { runId: row.id, sessionId: row.harness_session_key };
  }

  list(workspaceId: WorkspaceId, limit?: number): Run[] {
    const rows = connectionFor(this.database)
      .prepare(
        `SELECT * FROM runs WHERE workspace_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(workspaceId, cappedLimit(limit)) as Array<Record<string, unknown>>;
    return rows.map(mapRun);
  }

  transition(id: RunId, transition: RunTransition): Run {
    return this.database.transaction(() => {
      const run = this.get(id);
      if (run === null) throw new Error("Run not found");
      if (!allowedRunTransitions[run.status].includes(transition.status)) {
        throw new Error(
          `Invalid run transition from ${run.status} to ${transition.status}`,
        );
      }
      const terminal = ["succeeded", "failed", "canceled"].includes(
        transition.status,
      );
      const startedAt =
        run.startedAt ??
        (transition.status === "starting" || transition.status === "running"
          ? transition.at
          : null);
      connectionFor(this.database)
        .prepare(
          `UPDATE runs SET
             status = ?, started_at = ?, finished_at = ?,
             input_tokens = ?, output_tokens = ?, cost_micros = ?,
             error_code = ?, error_message = ?
           WHERE id = ?`,
        )
        .run(
          transition.status,
          startedAt,
          terminal ? transition.at : null,
          transition.inputTokens ?? run.inputTokens,
          transition.outputTokens ?? run.outputTokens,
          transition.costMicros ?? run.costMicros,
          transition.errorCode ?? run.errorCode,
          transition.errorMessage ?? run.errorMessage,
          id,
        );
      const updated = this.get(id);
      if (updated === null) throw new Error("Run disappeared during update");
      return updated;
    });
  }

  appendEvent(event: RunEvent): RunEvent {
    connectionFor(this.database)
      .prepare(
        `INSERT INTO run_events(id, run_id, sequence, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.runId,
        event.sequence,
        requiredText(event.type, "event type", 120),
        jsonText(event.payload),
        event.createdAt,
      );
    return event;
  }

  listEvents(runId: RunId, afterSequence = -1, limit?: number): RunEvent[] {
    if (!Number.isInteger(afterSequence) || afterSequence < -1) {
      throw new RangeError(
        "afterSequence must be an integer greater than or equal to -1",
      );
    }
    const rows = connectionFor(this.database)
      .prepare(
        `SELECT * FROM run_events WHERE run_id = ? AND sequence > ?
         ORDER BY sequence LIMIT ?`,
      )
      .all(runId, afterSequence, cappedLimit(limit, 100, 500)) as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      id: row.id as RunEvent["id"],
      runId: row.run_id as RunId,
      sequence: row.sequence as number,
      type: row.type as string,
      payload: parseJson(row.payload_json as string),
      createdAt: row.created_at as IsoTimestamp,
    }));
  }

  listActive(workspaceId: WorkspaceId, limit?: number): Run[] {
    const rows = connectionFor(this.database)
      .prepare(
        `SELECT * FROM runs
         WHERE workspace_id = ? AND status IN ('queued', 'starting', 'running', 'awaiting-approval')
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(workspaceId, cappedLimit(limit)) as Array<Record<string, unknown>>;
    return rows.map(mapRun);
  }
}
