import {
  buildReplicantSystemPrompt,
  type ClaimDueSchedulesInput,
  type CompleteScheduleClaimInput,
  type DueScheduleClaim,
  type EnsureScheduledRunInput,
  type ScheduleClaimRepositoryPort,
  type ScheduleSnapshot,
  type ScheduledRunRepositoryPort,
} from "@replicantos/runtime";

import { connectionFor } from "./database.ts";
import { insertQueuedRuntimeRun } from "./runtime-run-repository.ts";
import {
  parseRuntimeRetryPolicy,
  parseStoredJson,
  runtimeCwd,
  runtimeHarness,
  runtimeInstant,
  runtimeInteger,
  runtimeText,
  scheduleOccurrenceIdentity,
  stableJsonText,
  type RuntimeRepositoryContext,
} from "./runtime-support.ts";

function scheduleSnapshot(row: Record<string, unknown>): ScheduleSnapshot {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    replicantId: row.replicant_id as string,
    channelId: row.channel_id as string | null,
    taskId: row.task_id as string | null,
    cronExpression: row.cron_expression as string,
    timezone: row.timezone as string,
    harnessOverride:
      row.harness_override === null
        ? null
        : runtimeHarness(row.harness_override as string),
    modelOverride: row.model_override as string | null,
    effortOverride: row.effort_override as string | null,
    prompt: row.prompt as string,
    retryPolicy: parseRuntimeRetryPolicy(
      parseStoredJson(row.retry_policy_json as string),
    ),
  };
}

export class SqliteRuntimeScheduleRepository
  implements ScheduleClaimRepositoryPort, ScheduledRunRepositoryPort
{
  constructor(private readonly context: RuntimeRepositoryContext) {}

  async claimDueSchedules(
    input: ClaimDueSchedulesInput,
  ): Promise<readonly DueScheduleClaim[]> {
    const now = runtimeInstant(input.now, "schedule claim now");
    const leaseUntil = runtimeInstant(
      input.leaseUntil,
      "schedule claim leaseUntil",
    );
    if (leaseUntil <= now) {
      throw new RangeError("schedule claim leaseUntil must follow now");
    }
    const owner = runtimeText(input.leaseOwner, "schedule lease owner", 500);
    const limit = runtimeInteger(input.limit, "schedule claim limit", 1, 1_000);

    return this.context.database.transaction(() => {
      const connection = connectionFor(this.context.database);
      const schedules = connection
        .prepare(
          `SELECT s.*
           FROM schedules s
           LEFT JOIN runtime_schedule_occurrences o
             ON o.schedule_id = s.id AND o.scheduled_for = s.next_run_at
           WHERE s.status = 'enabled' AND s.next_run_at IS NOT NULL
             AND s.next_run_at <= ?
             AND (
               o.occurrence_key IS NULL OR
               (o.status = 'pending' AND (o.claim_token IS NULL OR o.lease_until <= ?))
             )
           ORDER BY s.next_run_at, s.id
           LIMIT ?`,
        )
        .all(now, now, limit) as Array<Record<string, unknown>>;

      const claims: DueScheduleClaim[] = [];
      for (const row of schedules) {
        const scheduledFor = runtimeInstant(
          row.next_run_at as string,
          "schedule nextRunAt",
        );
        const occurrenceKey = scheduleOccurrenceIdentity(
          row.id as string,
          scheduledFor,
        );
        connection
          .prepare(
            `INSERT OR IGNORE INTO runtime_schedule_occurrences(
              occurrence_key, schedule_id, scheduled_for, status, claim_token,
              lease_owner, lease_until, run_id, last_error_code, created_at,
              updated_at, completed_at
            ) VALUES (?, ?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
          )
          .run(occurrenceKey, row.id as string, scheduledFor, now, now);
        const claimToken = this.context.id("schedule-claim");
        const claimed = connection
          .prepare(
            `UPDATE runtime_schedule_occurrences
             SET claim_token = ?, lease_owner = ?, lease_until = ?, updated_at = ?
             WHERE occurrence_key = ? AND status = 'pending'
               AND (claim_token IS NULL OR lease_until <= ?)`,
          )
          .run(claimToken, owner, leaseUntil, now, occurrenceKey, now);
        if (claimed.changes !== 1) continue;
        claims.push({
          claimToken,
          scheduledFor,
          schedule: scheduleSnapshot(row),
        });
      }
      return claims;
    });
  }

  async completeScheduleClaim(
    input: CompleteScheduleClaimInput,
  ): Promise<"completed" | "stale"> {
    const claimToken = runtimeText(
      input.claimToken,
      "schedule claim token",
      500,
    );
    const completedAt = runtimeInstant(
      input.completedAt,
      "schedule claim completedAt",
    );
    const nextRunAt = runtimeInstant(input.nextRunAt, "schedule nextRunAt");
    const runId = runtimeText(input.runId, "scheduled run id", 500);

    return this.context.database.transaction(() => {
      const connection = connectionFor(this.context.database);
      const occurrence = connection
        .prepare(
          `SELECT schedule_id, scheduled_for, lease_until
           FROM runtime_schedule_occurrences
           WHERE claim_token = ? AND status = 'pending'`,
        )
        .get(claimToken) as
        | { schedule_id: string; scheduled_for: string; lease_until: string }
        | undefined;
      if (
        occurrence === undefined ||
        occurrence.lease_until <= completedAt ||
        nextRunAt <= occurrence.scheduled_for
      ) {
        return "stale";
      }
      const scheduledRun = connection
        .prepare(
          `SELECT 1 FROM runtime_scheduled_run_keys
           WHERE schedule_id = ? AND scheduled_for = ? AND run_id = ?`,
        )
        .get(occurrence.schedule_id, occurrence.scheduled_for, runId);
      if (scheduledRun === undefined) return "stale";
      const schedule = connection
        .prepare(
          `UPDATE schedules
           SET last_run_at = ?, next_run_at = ?, updated_at = ?
           WHERE id = ? AND next_run_at = ?`,
        )
        .run(
          occurrence.scheduled_for,
          nextRunAt,
          completedAt,
          occurrence.schedule_id,
          occurrence.scheduled_for,
        );
      if (schedule.changes !== 1) return "stale";
      const completed = connection
        .prepare(
          `UPDATE runtime_schedule_occurrences
           SET status = 'completed', run_id = ?, completed_at = ?, updated_at = ?,
             claim_token = NULL, lease_owner = NULL, lease_until = NULL,
             last_error_code = NULL
           WHERE claim_token = ? AND status = 'pending'`,
        )
        .run(runId, completedAt, completedAt, claimToken);
      if (completed.changes !== 1) {
        throw new Error("Schedule claim changed during completion");
      }
      return "completed";
    });
  }

  async releaseScheduleClaim(input: {
    claimToken: string;
    releasedAt: string;
    errorCode: string;
  }): Promise<void> {
    const claimToken = runtimeText(
      input.claimToken,
      "schedule claim token",
      500,
    );
    const releasedAt = runtimeInstant(
      input.releasedAt,
      "schedule claim releasedAt",
    );
    const errorCode = runtimeText(
      input.errorCode,
      "schedule claim error code",
      200,
    );
    connectionFor(this.context.database)
      .prepare(
        `UPDATE runtime_schedule_occurrences
         SET claim_token = NULL, lease_owner = NULL, lease_until = NULL,
           last_error_code = ?, updated_at = ?
         WHERE claim_token = ? AND status = 'pending'`,
      )
      .run(errorCode, releasedAt, claimToken);
  }

  async ensureScheduledRun(
    input: EnsureScheduledRunInput,
  ): Promise<{ runId: string; created: boolean }> {
    const idempotencyKey = runtimeText(
      input.idempotencyKey,
      "scheduled run idempotency key",
      1_000,
    );
    const scheduledFor = runtimeInstant(
      input.scheduledFor,
      "scheduled run scheduledFor",
    );
    const scheduleId = runtimeText(input.schedule.id, "schedule id", 500);

    return this.context.database.transaction(() => {
      const connection = connectionFor(this.context.database);
      const existing = connection
        .prepare(
          `SELECT schedule_id, scheduled_for, run_id
           FROM runtime_scheduled_run_keys WHERE idempotency_key = ?`,
        )
        .get(idempotencyKey) as
        | { schedule_id: string; scheduled_for: string; run_id: string }
        | undefined;
      if (existing !== undefined) {
        if (
          existing.schedule_id !== scheduleId ||
          existing.scheduled_for !== scheduledFor
        ) {
          throw new Error(
            "Scheduled run idempotency key was reused for another occurrence",
          );
        }
        return { runId: existing.run_id, created: false };
      }
      const occurrenceMapping = connection
        .prepare(
          `SELECT idempotency_key, run_id FROM runtime_scheduled_run_keys
           WHERE schedule_id = ? AND scheduled_for = ?`,
        )
        .get(scheduleId, scheduledFor) as
        | { idempotency_key: string; run_id: string }
        | undefined;
      if (occurrenceMapping !== undefined) {
        if (occurrenceMapping.idempotency_key !== idempotencyKey) {
          throw new Error(
            "Schedule occurrence has a different idempotency key",
          );
        }
        return { runId: occurrenceMapping.run_id, created: false };
      }
      const occurrence = connection
        .prepare(
          `SELECT status FROM runtime_schedule_occurrences
           WHERE schedule_id = ? AND scheduled_for = ?`,
        )
        .get(scheduleId, scheduledFor) as { status: string } | undefined;
      if (occurrence?.status !== "pending") {
        throw new Error(
          "Scheduled run does not have a pending claimed occurrence",
        );
      }
      const row = connection
        .prepare(
          `SELECT s.workspace_id, s.replicant_id, s.created_by,
             r.default_harness, r.default_model, r.name, r.persona,
             r.relative_workspace_path, r.relative_memory_path
           FROM schedules s
           JOIN replicants r ON r.id = s.replicant_id
           WHERE s.id = ?`,
        )
        .get(scheduleId) as Record<string, unknown> | undefined;
      if (row === undefined) throw new Error("Schedule no longer exists");
      if (
        row.workspace_id !== input.schedule.workspaceId ||
        row.replicant_id !== input.schedule.replicantId
      ) {
        throw new Error("Claimed schedule snapshot does not match persistence");
      }
      const harness = runtimeHarness(
        input.schedule.harnessOverride ?? (row.default_harness as string),
      );
      const cwd = runtimeCwd(
        this.context.resolveReplicantCwd({
          workspaceId: row.workspace_id as string,
          replicantId: row.replicant_id as string,
          relativeWorkspacePath: row.relative_workspace_path as string,
        }),
      );
      const runId = this.context.id("run");
      const createdAt = runtimeInstant(
        this.context.database.clock(),
        "database clock",
      );
      const systemPrompt = buildReplicantSystemPrompt({
        name: row.name as string,
        persona: row.persona as string,
        relativeWorkspacePath: row.relative_workspace_path as string,
        relativeMemoryPath: row.relative_memory_path as string,
      });
      insertQueuedRuntimeRun(this.context, {
        id: runId,
        workspaceId: input.schedule.workspaceId,
        replicantId: input.schedule.replicantId,
        channelId: input.schedule.channelId,
        taskId: input.schedule.taskId,
        scheduleId,
        parentRunId: null,
        trigger: "schedule",
        harness,
        model:
          input.schedule.modelOverride ?? (row.default_model as string | null),
        effort: input.schedule.effortOverride,
        requestedBy: row.created_by as string,
        harnessSessionKey: null,
        createdAt,
        execution: {
          prompt: input.schedule.prompt,
          cwd,
          systemPrompt,
          approvalMode: "ask",
          retryPolicy: input.schedule.retryPolicy,
          notBefore: scheduledFor,
        },
      });
      connection
        .prepare(
          `INSERT INTO runtime_scheduled_run_keys(
            idempotency_key, schedule_id, scheduled_for, run_id, created_at
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(idempotencyKey, scheduleId, scheduledFor, runId, createdAt);
      connection
        .prepare(
          `INSERT INTO audit_log(
            id, workspace_id, actor_kind, actor_user_id, action,
            resource_type, resource_id, request_id, detail_json, created_at
          ) VALUES (?, ?, 'system', NULL, 'schedule.run.queued', 'run', ?,
            NULL, ?, ?)`,
        )
        .run(
          this.context.id("audit"),
          input.schedule.workspaceId,
          runId,
          stableJsonText({ scheduleId, scheduledFor }),
          createdAt,
        );
      return { runId, created: true };
    });
  }
}
