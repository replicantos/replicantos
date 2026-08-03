import { createHash } from "node:crypto";

import type { Run } from "@replicantos/core";
import type {
  ClaimRunnableRunsInput,
  FinishRunExecutionInput,
  PersistRunEventInput,
  RetryPolicy,
  RunExecutionClaim,
  RunRepositoryPort,
} from "@replicantos/runtime";

import { connectionFor } from "./database.ts";
import {
  optionalRuntimeText,
  parseRuntimeRetryPolicy,
  runtimeCwd,
  runtimeDigest,
  runtimeHarness,
  runtimeInstant,
  runtimeInteger,
  runtimeText,
  stableJsonText,
  type RuntimeRepositoryContext,
} from "./runtime-support.ts";

const TERMINAL_STATUSES = new Set(["canceled", "failed", "succeeded"]);

export interface RuntimeExecutionInput {
  prompt: string;
  cwd: string;
  systemPrompt?: string;
  approvalMode?: "ask" | "plan";
  retryPolicy: RetryPolicy;
  notBefore?: string;
}

export interface EnqueueRuntimeRunInput {
  run: Run;
  execution: RuntimeExecutionInput;
}

export interface QueuedRuntimeRunRecord {
  id: string;
  workspaceId: string;
  replicantId: string;
  channelId: string | null;
  taskId: string | null;
  scheduleId: string | null;
  parentRunId: string | null;
  trigger: "manual" | "message" | "retry" | "schedule" | "task";
  harness: string;
  model: string | null;
  effort: string | null;
  requestedBy: string | null;
  harnessSessionKey: string | null;
  createdAt: string;
  execution: RuntimeExecutionInput;
}

export interface RuntimeRunProjectionRecord {
  runId: string;
  status: string;
  harnessSessionId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  costMicros: number | null;
  assistantText: string;
  cancellationRequestedAt: string | null;
}

function executionPolicyText(policy: RetryPolicy): string {
  return stableJsonText(parseRuntimeRetryPolicy(policy));
}

export function insertQueuedRuntimeRun(
  context: RuntimeRepositoryContext,
  input: QueuedRuntimeRunRecord,
): void {
  const createdAt = runtimeInstant(input.createdAt, "run createdAt");
  const notBefore = runtimeInstant(
    input.execution.notBefore ?? input.createdAt,
    "run notBefore",
  );
  const prompt = runtimeText(input.execution.prompt, "run prompt", 100_000);
  const cwd = runtimeCwd(input.execution.cwd);
  const systemPrompt = optionalRuntimeText(
    input.execution.systemPrompt,
    "run system prompt",
    100_000,
  );
  const harnessSessionKey =
    input.harnessSessionKey === null
      ? null
      : runtimeText(input.harnessSessionKey, "harness session id", 2_000);
  if (
    input.execution.approvalMode !== undefined &&
    input.execution.approvalMode !== "ask" &&
    input.execution.approvalMode !== "plan"
  ) {
    throw new TypeError("run approval mode is invalid");
  }
  const retryPolicy = executionPolicyText(input.execution.retryPolicy);
  const connection = connectionFor(context.database);
  connection
    .prepare(
      `INSERT INTO runs(
        id, workspace_id, replicant_id, channel_id, task_id, schedule_id, parent_run_id,
        trigger_type, status, harness, model, effort, harness_session_key, requested_by,
        created_at, started_at, finished_at, input_tokens, output_tokens, cost_micros,
        error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
    )
    .run(
      runtimeText(input.id, "run id", 500),
      runtimeText(input.workspaceId, "workspace id", 500),
      runtimeText(input.replicantId, "replicant id", 500),
      input.channelId,
      input.taskId,
      input.scheduleId,
      input.parentRunId,
      input.trigger,
      runtimeHarness(input.harness),
      input.model,
      input.effort,
      harnessSessionKey,
      input.requestedBy,
      createdAt,
    );
  connection
    .prepare(
      `INSERT INTO runtime_run_controls(
        run_id, prompt, cwd, system_prompt, approval_mode, retry_policy_json,
        attempt, not_before, cancellation_requested_at, assistant_text,
        cached_input_tokens, last_failure_retryable, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, '', NULL, 0, ?, ?)`,
    )
    .run(
      input.id,
      prompt,
      cwd,
      systemPrompt,
      input.execution.approvalMode ?? null,
      retryPolicy,
      notBefore,
      createdAt,
      createdAt,
    );
}

function claimLimits(input: ClaimRunnableRunsInput): {
  now: string;
  leaseUntil: string;
  limit: number;
  globalLimit: number;
  perHarness: ReadonlyMap<string, number>;
} {
  const now = runtimeInstant(input.now, "claim now");
  const leaseUntil = runtimeInstant(input.leaseUntil, "claim leaseUntil");
  if (leaseUntil <= now)
    throw new RangeError("claim leaseUntil must follow now");
  const limit = runtimeInteger(input.limit, "claim limit", 1, 256);
  const globalLimit = runtimeInteger(
    input.globalLimit,
    "global concurrency limit",
    1,
    256,
  );
  const perHarness = new Map<string, number>();
  for (const [harness, value] of Object.entries(input.perHarnessLimits)) {
    runtimeHarness(harness);
    perHarness.set(
      harness,
      runtimeInteger(value, `${harness} concurrency limit`, 1, globalLimit),
    );
  }
  return { now, leaseUntil, limit, globalLimit, perHarness };
}

function activeExecution(
  context: RuntimeRepositoryContext,
  input: {
    leaseToken: string;
    executionId: string;
    runId: string;
    now: string;
  },
): Record<string, unknown> | undefined {
  return connectionFor(context.database)
    .prepare(
      `SELECT e.*, c.retry_policy_json, c.attempt AS control_attempt
       FROM runtime_run_executions e
       JOIN runtime_run_controls c ON c.run_id = e.run_id
       WHERE e.lease_token = ? AND e.execution_id = ? AND e.run_id = ?
         AND e.status = 'active' AND e.lease_until > ?`,
    )
    .get(input.leaseToken, input.executionId, input.runId, input.now) as
    | Record<string, unknown>
    | undefined;
}

export class SqliteRuntimeRunRepository implements RunRepositoryPort {
  constructor(private readonly context: RuntimeRepositoryContext) {}

  enqueue(input: EnqueueRuntimeRunInput): void {
    if (
      input.run.status !== "queued" ||
      input.run.startedAt !== null ||
      input.run.finishedAt !== null
    ) {
      throw new TypeError(
        "runtime runs must be enqueued in a pristine queued state",
      );
    }
    this.context.database.transaction(() => {
      insertQueuedRuntimeRun(this.context, {
        id: input.run.id,
        workspaceId: input.run.workspaceId,
        replicantId: input.run.replicantId,
        channelId: input.run.channelId,
        taskId: input.run.taskId,
        scheduleId: input.run.scheduleId,
        parentRunId: input.run.parentRunId,
        trigger: input.run.trigger,
        harness: input.run.harness,
        model: input.run.model,
        effort: input.run.effort,
        requestedBy: input.run.requestedBy,
        harnessSessionKey: input.run.harnessSessionKey,
        createdAt: input.run.createdAt,
        execution: input.execution,
      });
    });
  }

  async claimRunnableRuns(
    input: ClaimRunnableRunsInput,
  ): Promise<readonly RunExecutionClaim[]> {
    const leaseOwner = runtimeText(input.leaseOwner, "lease owner", 500);
    const limits = claimLimits(input);
    return this.context.database.transaction(() => {
      const connection = connectionFor(this.context.database);
      const activeRows = connection
        .prepare(
          `SELECT r.harness, COUNT(*) AS count
           FROM runtime_run_executions e
           JOIN runs r ON r.id = e.run_id
           WHERE e.status = 'active' AND e.lease_until > ?
           GROUP BY r.harness`,
        )
        .all(limits.now) as Array<{ harness: string; count: number }>;
      const activeByHarness = new Map(
        activeRows.map((row) => [row.harness, row.count]),
      );
      let activeGlobal = activeRows.reduce((sum, row) => sum + row.count, 0);
      const maximumClaims = Math.min(
        limits.limit,
        Math.max(0, limits.globalLimit - activeGlobal),
      );
      if (maximumClaims === 0) return [];

      const candidates = connection
        .prepare(
          `SELECT
             r.id, r.harness, r.model, r.effort, r.harness_session_key,
             r.status, r.created_at, c.prompt, c.cwd, c.system_prompt,
             c.approval_mode, c.retry_policy_json, c.attempt, c.not_before
           FROM runs r
           JOIN runtime_run_controls c ON c.run_id = r.id
           WHERE c.cancellation_requested_at IS NULL
             AND (c.not_before IS NULL OR c.not_before <= ?)
             AND NOT EXISTS (
               SELECT 1 FROM runtime_run_executions live
               WHERE live.run_id = r.id AND live.status = 'active' AND live.lease_until > ?
             )
             AND (
               r.status = 'queued' OR
               (r.status IN ('starting', 'running') AND r.harness_session_key IS NOT NULL)
             )
           ORDER BY c.not_before, r.created_at, r.id`,
        )
        .all(limits.now, limits.now) as Array<Record<string, unknown>>;

      const claims: RunExecutionClaim[] = [];
      for (const row of candidates) {
        if (
          claims.length >= maximumClaims ||
          activeGlobal >= limits.globalLimit
        ) {
          break;
        }
        const harnessId = runtimeHarness(row.harness as string);
        const harnessCount = activeByHarness.get(harnessId) ?? 0;
        const harnessLimit =
          limits.perHarness.get(harnessId) ?? limits.globalLimit;
        if (harnessCount >= harnessLimit) continue;

        const runId = row.id as string;
        connection
          .prepare(
            `UPDATE runtime_run_executions
             SET status = 'abandoned', finished_at = ?, finish_code = 'lease_expired'
             WHERE run_id = ? AND status = 'active' AND lease_until <= ?`,
          )
          .run(limits.now, runId, limits.now);
        const sessionId = row.harness_session_key as string | null;
        const mode = sessionId === null ? "start" : "resume";
        if (row.status !== "queued" && mode !== "resume") continue;
        const executionId = this.context.id("execution");
        const leaseToken = this.context.id("lease");
        connection
          .prepare(
            `INSERT INTO runtime_run_executions(
              execution_id, run_id, attempt, mode, lease_token, lease_owner,
              claimed_at, lease_until, status, finished_at, finish_code
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL)`,
          )
          .run(
            executionId,
            runId,
            row.attempt as number,
            mode,
            leaseToken,
            leaseOwner,
            limits.now,
            limits.leaseUntil,
          );
        const sequenceRow = connection
          .prepare(
            "SELECT COALESCE(MAX(sequence), -1) + 1 AS next_sequence FROM run_events WHERE run_id = ?",
          )
          .get(runId) as { next_sequence: number };
        const retryPolicy = parseRuntimeRetryPolicy(
          JSON.parse(row.retry_policy_json as string) as unknown,
        );
        claims.push({
          leaseToken,
          executionId,
          runId,
          harnessId,
          mode,
          ...(sessionId === null ? {} : { sessionId }),
          attempt: row.attempt as number,
          nextEventSequence: sequenceRow.next_sequence,
          retryPolicy,
          input: {
            prompt: row.prompt as string,
            cwd: row.cwd as string,
            ...(row.model === null ? {} : { model: row.model as string }),
            ...(row.effort === null
              ? {}
              : { reasoningEffort: row.effort as string }),
            ...(row.system_prompt === null
              ? {}
              : { systemPrompt: row.system_prompt as string }),
            ...(row.approval_mode === null
              ? {}
              : { approvalMode: row.approval_mode as "ask" | "plan" }),
          },
        });
        activeByHarness.set(harnessId, harnessCount + 1);
        activeGlobal += 1;
      }
      return claims;
    });
  }

  async markRunStarting(input: {
    leaseToken: string;
    runId: string;
    startedAt: string;
  }): Promise<boolean> {
    const leaseToken = runtimeText(input.leaseToken, "lease token", 500);
    const runId = runtimeText(input.runId, "run id", 500);
    const startedAt = runtimeInstant(input.startedAt, "run startedAt");
    const now = runtimeInstant(this.context.database.clock(), "database clock");
    return this.context.database.transaction(() => {
      const connection = connectionFor(this.context.database);
      const result = connection
        .prepare(
          `UPDATE runs
           SET status = 'starting', started_at = COALESCE(started_at, ?), finished_at = NULL
           WHERE id = ? AND status IN ('queued', 'starting', 'running')
             AND EXISTS (
               SELECT 1 FROM runtime_run_executions e
               WHERE e.run_id = runs.id AND e.lease_token = ?
                 AND e.status = 'active' AND e.lease_until > ?
             )`,
        )
        .run(startedAt, runId, leaseToken, now);
      if (result.changes === 1) {
        connection
          .prepare(
            "UPDATE runtime_run_controls SET updated_at = ? WHERE run_id = ?",
          )
          .run(startedAt, runId);
      }
      return result.changes === 1;
    });
  }

  async renewRunLease(input: {
    leaseToken: string;
    now: string;
    leaseUntil: string;
  }): Promise<{ renewed: boolean; cancelRequested: boolean }> {
    const token = runtimeText(input.leaseToken, "lease token", 500);
    const now = runtimeInstant(input.now, "lease renewal now");
    const leaseUntil = runtimeInstant(
      input.leaseUntil,
      "lease renewal leaseUntil",
    );
    if (leaseUntil <= now) {
      throw new RangeError("renewed leaseUntil must follow now");
    }
    return this.context.database.transaction(() => {
      const connection = connectionFor(this.context.database);
      const result = connection
        .prepare(
          `UPDATE runtime_run_executions
           SET lease_until = ?
           WHERE lease_token = ? AND status = 'active' AND lease_until > ?`,
        )
        .run(leaseUntil, token, now);
      if (result.changes !== 1) {
        return { renewed: false, cancelRequested: false };
      }
      const row = connection
        .prepare(
          `SELECT c.cancellation_requested_at
           FROM runtime_run_executions e
           JOIN runtime_run_controls c ON c.run_id = e.run_id
           WHERE e.lease_token = ?`,
        )
        .get(token) as { cancellation_requested_at: string | null };
      return {
        renewed: true,
        cancelRequested: row.cancellation_requested_at !== null,
      };
    });
  }

  async recordRunEvent(
    input: PersistRunEventInput,
  ): Promise<"duplicate" | "recorded" | "stale"> {
    const leaseToken = runtimeText(input.leaseToken, "lease token", 500);
    const executionId = runtimeText(input.executionId, "execution id", 500);
    const idempotencyKey = runtimeText(
      input.idempotencyKey,
      "event idempotency key",
      1_000,
    );
    const runId = runtimeText(input.event.runId, "event run id", 500);
    const occurredAt = runtimeInstant(
      input.event.occurredAt,
      "event occurredAt",
    );
    runtimeInteger(
      input.event.sequence,
      "event sequence",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const eventJson = stableJsonText(input.event);
    const eventDigest = runtimeDigest(
      stableJsonText({ event: input.event, projection: input.projection }),
    );
    const now = runtimeInstant(this.context.database.clock(), "database clock");

    return this.context.database.transaction(() => {
      const connection = connectionFor(this.context.database);
      if (
        activeExecution(this.context, {
          leaseToken,
          executionId,
          runId,
          now,
        }) === undefined
      ) {
        return "stale";
      }
      const duplicate = connection
        .prepare(
          `SELECT execution_id, run_id, event_digest
           FROM runtime_run_event_keys WHERE idempotency_key = ?`,
        )
        .get(idempotencyKey) as
        | { execution_id: string; run_id: string; event_digest: string }
        | undefined;
      if (duplicate !== undefined) {
        if (
          duplicate.execution_id !== executionId ||
          duplicate.run_id !== runId ||
          duplicate.event_digest !== eventDigest
        ) {
          throw new Error(
            "Event idempotency key was reused with different content",
          );
        }
        return "duplicate";
      }

      const eventId = this.context.id("event");
      connection
        .prepare(
          `INSERT INTO run_events(id, run_id, sequence, type, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          eventId,
          runId,
          input.event.sequence,
          runtimeText(input.event.type, "event type", 120),
          eventJson,
          occurredAt,
        );
      connection
        .prepare(
          `INSERT INTO runtime_run_event_keys(
            idempotency_key, execution_id, run_id, event_id, event_digest, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          idempotencyKey,
          executionId,
          runId,
          eventId,
          eventDigest,
          occurredAt,
        );

      if (input.projection.status !== undefined) {
        const current = connection
          .prepare("SELECT status FROM runs WHERE id = ?")
          .get(runId) as { status: string };
        if (
          TERMINAL_STATUSES.has(current.status) &&
          current.status !== input.projection.status
        ) {
          throw new Error("A normalized event cannot regress a terminal run");
        }
        const terminal = TERMINAL_STATUSES.has(input.projection.status);
        connection
          .prepare("UPDATE runs SET status = ?, finished_at = ? WHERE id = ?")
          .run(input.projection.status, terminal ? occurredAt : null, runId);
      }
      if (input.projection.harnessSessionId !== undefined) {
        connection
          .prepare("UPDATE runs SET harness_session_key = ? WHERE id = ?")
          .run(
            runtimeText(
              input.projection.harnessSessionId,
              "harness session id",
              2_000,
            ),
            runId,
          );
      }
      if (input.projection.usage !== undefined) {
        const usage = input.projection.usage;
        const inputTokens = runtimeInteger(
          usage.inputTokens,
          "input tokens",
          0,
          Number.MAX_SAFE_INTEGER,
        );
        const outputTokens = runtimeInteger(
          usage.outputTokens,
          "output tokens",
          0,
          Number.MAX_SAFE_INTEGER,
        );
        const costMicros =
          usage.costMicros === undefined
            ? null
            : runtimeInteger(
                usage.costMicros,
                "cost micros",
                0,
                Number.MAX_SAFE_INTEGER,
              );
        connection
          .prepare(
            `UPDATE runs SET input_tokens = ?, output_tokens = ?,
               cost_micros = COALESCE(?, cost_micros)
             WHERE id = ?`,
          )
          .run(inputTokens, outputTokens, costMicros, runId);
        if (usage.cachedInputTokens !== undefined) {
          connection
            .prepare(
              "UPDATE runtime_run_controls SET cached_input_tokens = ? WHERE run_id = ?",
            )
            .run(
              runtimeInteger(
                usage.cachedInputTokens,
                "cached input tokens",
                0,
                Number.MAX_SAFE_INTEGER,
              ),
              runId,
            );
        }
      }
      if (input.projection.assistantTextDelta !== undefined) {
        const assistantTextDelta = runtimeText(
          input.projection.assistantTextDelta,
          "assistant text delta",
          100_000,
        );
        connection
          .prepare(
            `UPDATE runtime_run_controls
             SET assistant_text = substr(assistant_text || ?, 1, 100000)
             WHERE run_id = ?`,
          )
          .run(assistantTextDelta, runId);
      }
      if (input.projection.failure !== undefined) {
        connection
          .prepare(
            `UPDATE runs SET error_code = ?, error_message = ? WHERE id = ?`,
          )
          .run(
            runtimeText(input.projection.failure.code, "failure code", 200),
            runtimeText(
              input.projection.failure.message,
              "failure message",
              2_000,
            ),
            runId,
          );
        connection
          .prepare(
            `UPDATE runtime_run_controls SET last_failure_retryable = ?
             WHERE run_id = ?`,
          )
          .run(input.projection.failure.retryable ? 1 : 0, runId);
      }
      if (input.projection.approvalRequest !== undefined) {
        const approval = input.projection.approvalRequest;
        const approvalId = runtimeText(
          approval.approvalId,
          "approval id",
          1_000,
        );
        const requestJson = runtimeText(
          stableJsonText(approval),
          "approval request",
          100_000,
        );
        const approvalTitle = runtimeText(
          approval.title,
          "approval title",
          500,
        );
        const existing = connection
          .prepare(
            "SELECT run_id, request_json FROM runtime_run_approvals WHERE approval_id = ?",
          )
          .get(approvalId) as
          | { run_id: string; request_json: string }
          | undefined;
        if (existing === undefined) {
          const run = connection
            .prepare("SELECT workspace_id, requested_by FROM runs WHERE id = ?")
            .get(runId) as
            | { workspace_id: string; requested_by: string | null }
            | undefined;
          if (run === undefined) throw new Error("Approval run disappeared");
          const expiresAt = new Date(
            Date.parse(occurredAt) + 24 * 60 * 60 * 1_000,
          ).toISOString();
          connection
            .prepare(
              `INSERT INTO runtime_run_approvals(
                approval_id, run_id, request_json, status, decision_json,
                dispatch_token, lease_owner, lease_until, completed_at,
                last_error_code, created_at, updated_at
              ) VALUES (?, ?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
            )
            .run(approvalId, runId, requestJson, occurredAt, occurredAt);
          connection
            .prepare(
              `INSERT INTO approvals(
                id, workspace_id, run_id, requested_by, action, action_digest,
                payload_json, status, expires_at, decided_by, decided_at,
                consumed_at, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, ?)`,
            )
            .run(
              approvalId,
              run.workspace_id,
              runId,
              run.requested_by,
              approvalTitle,
              createHash("sha256").update(requestJson).digest("hex"),
              requestJson,
              expiresAt,
              occurredAt,
            );
          connection
            .prepare(
              `INSERT INTO audit_log(
                id, workspace_id, actor_kind, actor_user_id, action,
                resource_type, resource_id, request_id, detail_json,
                created_at
              ) VALUES (?, ?, 'system', NULL, 'runtime.approval.requested',
                'approval', ?, NULL, ?, ?)`,
            )
            .run(
              this.context.id("audit"),
              run.workspace_id,
              approvalId,
              stableJsonText({ runId }),
              occurredAt,
            );
        } else if (
          existing.run_id !== runId ||
          existing.request_json !== requestJson
        ) {
          throw new Error("Approval id was reused with different content");
        }
      }
      connection
        .prepare(
          "UPDATE runtime_run_controls SET updated_at = ? WHERE run_id = ?",
        )
        .run(occurredAt, runId);
      return "recorded";
    });
  }

  async finishRunExecution(
    input: FinishRunExecutionInput,
  ): Promise<"finished" | "retry-scheduled" | "stale"> {
    const leaseToken = runtimeText(input.leaseToken, "lease token", 500);
    const executionId = runtimeText(input.executionId, "execution id", 500);
    const runId = runtimeText(input.runId, "run id", 500);
    const finishedAt = runtimeInstant(input.finishedAt, "run finishedAt");
    const now = runtimeInstant(this.context.database.clock(), "database clock");
    const sessionId = optionalRuntimeText(
      input.sessionId,
      "harness session id",
      2_000,
    );

    return this.context.database.transaction(() => {
      const connection = connectionFor(this.context.database);
      const execution = activeExecution(this.context, {
        leaseToken,
        executionId,
        runId,
        now,
      });
      if (execution === undefined) return "stale";

      if (input.retry !== undefined) {
        if (input.outcome !== "failed") {
          throw new TypeError("Only failed executions may schedule a retry");
        }
        const nextAttempt = runtimeInteger(
          input.retry.nextAttempt,
          "retry nextAttempt",
          2,
          10,
        );
        const currentAttempt = execution.control_attempt as number;
        if (nextAttempt !== currentAttempt + 1) {
          throw new Error(
            "Retry attempt must increment the persisted attempt once",
          );
        }
        const policy = parseRuntimeRetryPolicy(
          JSON.parse(execution.retry_policy_json as string) as unknown,
        );
        if (nextAttempt > policy.maxAttempts) {
          throw new Error("Retry attempt exceeds the persisted retry policy");
        }
        const notBefore = runtimeInstant(
          input.retry.notBefore,
          "retry notBefore",
        );
        if (notBefore < finishedAt) {
          throw new RangeError("retry notBefore must not precede finishedAt");
        }
        connection
          .prepare(
            `UPDATE runs SET status = 'queued', finished_at = NULL,
               harness_session_key = COALESCE(?, harness_session_key),
               error_code = ?, error_message = ?
             WHERE id = ?`,
          )
          .run(
            sessionId,
            input.errorCode ?? null,
            input.errorMessage ?? null,
            runId,
          );
        connection
          .prepare(
            `UPDATE runtime_run_controls
             SET attempt = ?, not_before = ?, updated_at = ? WHERE run_id = ?`,
          )
          .run(nextAttempt, notBefore, finishedAt, runId);
        connection
          .prepare(
            `UPDATE runtime_run_executions
             SET status = 'retry-scheduled', finished_at = ?, finish_code = ?
             WHERE execution_id = ? AND lease_token = ? AND status = 'active'`,
          )
          .run(
            finishedAt,
            input.errorCode ?? "retry_scheduled",
            executionId,
            leaseToken,
          );
        return "retry-scheduled";
      }

      connection
        .prepare(
          `UPDATE runs SET status = ?, finished_at = ?,
             harness_session_key = COALESCE(?, harness_session_key),
             error_code = ?, error_message = ?
           WHERE id = ?`,
        )
        .run(
          input.outcome,
          finishedAt,
          sessionId,
          input.outcome === "failed" ? (input.errorCode ?? null) : null,
          input.outcome === "failed" ? (input.errorMessage ?? null) : null,
          runId,
        );
      const result = connection
        .prepare(
          `UPDATE runtime_run_executions
           SET status = 'finished', finished_at = ?, finish_code = ?
           WHERE execution_id = ? AND lease_token = ? AND status = 'active'`,
        )
        .run(finishedAt, input.outcome, executionId, leaseToken);
      if (result.changes !== 1) {
        throw new Error("Execution lease changed during finalization");
      }
      connection
        .prepare(
          "UPDATE runtime_run_controls SET updated_at = ? WHERE run_id = ?",
        )
        .run(finishedAt, runId);
      if (input.outcome === "succeeded") {
        const delivery = connection
          .prepare(
            `SELECT r.channel_id, r.replicant_id, r.workspace_id,
               c.assistant_text
             FROM runs r
             JOIN runtime_run_controls c ON c.run_id = r.id
             WHERE r.id = ?`,
          )
          .get(runId) as
          | {
              channel_id: string | null;
              replicant_id: string;
              workspace_id: string;
              assistant_text: string;
            }
          | undefined;
        if (
          delivery !== undefined &&
          delivery.channel_id !== null &&
          delivery.assistant_text.trim() !== ""
        ) {
          const existingDelivery = connection
            .prepare(
              "SELECT 1 FROM runtime_run_message_deliveries WHERE run_id = ?",
            )
            .get(runId);
          if (existingDelivery === undefined) {
            const messageId = this.context.id("message");
            connection
              .prepare(
                `INSERT INTO messages(
                  id, channel_id, reply_to_id, author_kind, author_user_id,
                  author_replicant_id, content, edited_at, deleted_at, created_at
                ) VALUES (?, ?, NULL, 'replicant', NULL, ?, ?, NULL, NULL, ?)`,
              )
              .run(
                messageId,
                delivery.channel_id,
                delivery.replicant_id,
                delivery.assistant_text,
                finishedAt,
              );
            connection
              .prepare(
                `INSERT INTO runtime_run_message_deliveries(
                  run_id, message_id, delivered_at
                ) VALUES (?, ?, ?)`,
              )
              .run(runId, messageId, finishedAt);
            connection
              .prepare(
                `INSERT INTO audit_log(
                  id, workspace_id, actor_kind, actor_user_id, action,
                  resource_type, resource_id, request_id, detail_json,
                  created_at
                ) VALUES (?, ?, 'system', NULL, 'runtime.message.delivered',
                  'message', ?, NULL, ?, ?)`,
              )
              .run(
                this.context.id("audit"),
                delivery.workspace_id,
                messageId,
                stableJsonText({ runId }),
                finishedAt,
              );
          }
        }
      }
      return "finished";
    });
  }

  async releaseRunLease(input: {
    leaseToken: string;
    releasedAt: string;
    reasonCode: string;
  }): Promise<void> {
    const leaseToken = runtimeText(input.leaseToken, "lease token", 500);
    const releasedAt = runtimeInstant(input.releasedAt, "lease releasedAt");
    const reasonCode = runtimeText(
      input.reasonCode,
      "lease release reason",
      200,
    );
    connectionFor(this.context.database)
      .prepare(
        `UPDATE runtime_run_executions
         SET status = 'released', finished_at = ?, finish_code = ?
         WHERE lease_token = ? AND status = 'active'`,
      )
      .run(releasedAt, reasonCode, leaseToken);
  }

  async requestRunCancellation(input: {
    runId: string;
    requestedAt: string;
  }): Promise<{
    status: "already-requested" | "not-found" | "requested" | "terminal";
  }> {
    const runId = runtimeText(input.runId, "run id", 500);
    const requestedAt = runtimeInstant(
      input.requestedAt,
      "cancellation requestedAt",
    );
    return this.context.database.transaction(() => {
      const connection = connectionFor(this.context.database);
      const row = connection
        .prepare(
          `SELECT r.status, c.run_id AS control_run_id, c.cancellation_requested_at
           FROM runs r
           LEFT JOIN runtime_run_controls c ON c.run_id = r.id
           WHERE r.id = ?`,
        )
        .get(runId) as
        | {
            status: string;
            control_run_id: string | null;
            cancellation_requested_at: string | null;
          }
        | undefined;
      if (row === undefined || row.control_run_id === null) {
        return { status: "not-found" };
      }
      if (TERMINAL_STATUSES.has(row.status)) return { status: "terminal" };
      if (row.cancellation_requested_at !== null) {
        return { status: "already-requested" };
      }
      connection
        .prepare(
          `UPDATE runtime_run_controls
           SET cancellation_requested_at = ?, updated_at = ? WHERE run_id = ?`,
        )
        .run(requestedAt, requestedAt, runId);
      if (row.status === "queued") {
        const live = connection
          .prepare(
            `SELECT 1 FROM runtime_run_executions
             WHERE run_id = ? AND status = 'active' AND lease_until > ? LIMIT 1`,
          )
          .get(runId, requestedAt);
        if (live === undefined) {
          connection
            .prepare(
              "UPDATE runs SET status = 'canceled', finished_at = ? WHERE id = ?",
            )
            .run(requestedAt, runId);
        }
      }
      return { status: "requested" };
    });
  }

  getProjection(runIdValue: string): RuntimeRunProjectionRecord | null {
    const runId = runtimeText(runIdValue, "run id", 500);
    const row = connectionFor(this.context.database)
      .prepare(
        `SELECT r.id, r.status, r.harness_session_key, r.input_tokens,
           r.output_tokens, r.cost_micros, c.cached_input_tokens,
           c.assistant_text, c.cancellation_requested_at
         FROM runs r
         JOIN runtime_run_controls c ON c.run_id = r.id
         WHERE r.id = ?`,
      )
      .get(runId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      runId: row.id as string,
      status: row.status as string,
      harnessSessionId: row.harness_session_key as string | null,
      inputTokens: row.input_tokens as number | null,
      outputTokens: row.output_tokens as number | null,
      cachedInputTokens: row.cached_input_tokens as number | null,
      costMicros: row.cost_micros as number | null,
      assistantText: row.assistant_text as string,
      cancellationRequestedAt: row.cancellation_requested_at as string | null,
    };
  }
}
