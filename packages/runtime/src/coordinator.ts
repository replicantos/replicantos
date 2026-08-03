import type {
  ApprovedCwdResolver,
  HarnessRegistry,
} from "@replicantos/harnesses";
import type {
  ApprovalDecision,
  HarnessAdapter,
  HarnessEvent,
  HarnessId,
  RunCompletion,
} from "@replicantos/protocol/harness";

import type {
  ApprovalRepositoryPort,
  IntervalHandle,
  IntervalScheduler,
  RunEventProjection,
  RunExecutionClaim,
  RunRepositoryPort,
  RuntimeClock,
} from "./ports.js";
import { retryDelayMs } from "./retry.js";
import { RuntimeContractError } from "./scheduler.js";
import { nodeIntervalScheduler } from "./timer.js";

const MIN_LEASE_MS = 2_000;
const MAX_LEASE_MS = 10 * 60 * 1_000;

export interface RunCoordinatorOptions {
  harnesses: HarnessRegistry;
  cwdResolver: ApprovedCwdResolver;
  runs: RunRepositoryPort;
  approvals: ApprovalRepositoryPort;
  leaseOwner: string;
  clock?: RuntimeClock;
  timers?: IntervalScheduler;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  maxConcurrentRuns: number;
  perHarnessLimits?: Readonly<Partial<Record<HarnessId, number>>>;
  isRetryableError?: (error: unknown, claim: RunExecutionClaim) => boolean;
  onCoordinatorError?: (error: unknown, runId: string) => void;
}

export interface RunPollResult {
  claimed: number;
  started: number;
  released: number;
}

export type ApprovalDispatchResult = "already-dispatched" | "dispatched";

export class ApprovalDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalDispatchError";
  }
}

interface ActiveRun {
  claim: RunExecutionClaim;
  adapter?: HarnessAdapter;
  providerStarted: boolean;
  task?: Promise<void>;
  heartbeat?: IntervalHandle;
  heartbeatRunning: boolean;
  eventTail: Promise<void>;
  leaseLost: boolean;
  finished: boolean;
  cancelRequested: boolean;
  cancelSent: boolean;
  retryableFailure: boolean;
  lastFailureCode?: string;
  lastFailureMessage?: string;
  sessionId?: string;
  pendingApprovals: Set<string>;
}

function boundedInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RuntimeContractError(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function clockDate(clock: RuntimeClock): Date {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RuntimeContractError("clock must return a valid Date.");
  }
  return value;
}

function normalizedErrorCode(error: unknown, fallback: string): string {
  const name = error instanceof Error ? error.name : fallback;
  const value = name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .toLowerCase()
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return value && value !== "error" ? value : fallback;
}

function safeFailureMessage(errorCode: string): string {
  if (errorCode === "cwd_policy_error") {
    return "The run working directory was rejected by policy.";
  }
  if (errorCode === "harness_unavailable") {
    return "The configured harness is unavailable.";
  }
  return "The harness execution failed.";
}

function nonnegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RuntimeContractError(
      `${name} must be a nonnegative safe integer.`,
    );
  }
  return value;
}

function eventProjection(event: HarnessEvent): RunEventProjection {
  switch (event.type) {
    case "run.state":
      return { status: event.state };
    case "session.bound":
      return { harnessSessionId: event.sessionId };
    case "assistant.text.delta":
      return { assistantTextDelta: event.text };
    case "usage.updated": {
      const inputTokens = nonnegativeSafeInteger(
        event.inputTokens,
        "usage.inputTokens",
      );
      const outputTokens = nonnegativeSafeInteger(
        event.outputTokens,
        "usage.outputTokens",
      );
      const cachedInputTokens =
        event.cachedInputTokens === undefined
          ? undefined
          : nonnegativeSafeInteger(
              event.cachedInputTokens,
              "usage.cachedInputTokens",
            );
      if (
        event.costUsd !== undefined &&
        (!Number.isFinite(event.costUsd) || event.costUsd < 0)
      ) {
        throw new RuntimeContractError(
          "usage.costUsd must be a nonnegative finite number.",
        );
      }
      const costMicros =
        event.costUsd === undefined
          ? undefined
          : Math.round(event.costUsd * 1_000_000);
      if (costMicros !== undefined && !Number.isSafeInteger(costMicros)) {
        throw new RuntimeContractError(
          "usage.costUsd exceeds the supported range.",
        );
      }
      return {
        usage: {
          inputTokens,
          outputTokens,
          ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
          ...(costMicros === undefined ? {} : { costMicros }),
        },
      };
    }
    case "approval.requested":
      return {
        status: "awaiting-approval",
        approvalRequest: {
          approvalId: event.approvalId,
          kind: event.kind,
          title: event.title,
          detail: event.detail,
          risk: event.risk,
          ...(event.options === undefined ? {} : { options: event.options }),
          ...(event.questions === undefined
            ? {}
            : { questions: event.questions }),
        },
      };
    case "run.completed":
      return { status: event.status };
    case "run.failed":
      return {
        status: "failed",
        failure: {
          code: event.code,
          message: event.message,
          retryable: event.retryable,
        },
      };
    case "assistant.reasoning.summary":
    case "file.changed":
    case "plan.updated":
    case "run.cancellation.requested":
    case "tool.completed":
    case "tool.progress":
    case "tool.started":
    case "warning":
      return {};
  }
}

function runEventIdempotencyKey(
  executionId: string,
  sourceSequence: number,
): string {
  return `execution/${encodeURIComponent(executionId)}/event/${sourceSequence}`;
}

export class RunCoordinator {
  readonly #harnesses: HarnessRegistry;
  readonly #cwdResolver: ApprovedCwdResolver;
  readonly #runs: RunRepositoryPort;
  readonly #approvals: ApprovalRepositoryPort;
  readonly #leaseOwner: string;
  readonly #clock: RuntimeClock;
  readonly #timers: IntervalScheduler;
  readonly #leaseDurationMs: number;
  readonly #heartbeatIntervalMs: number;
  readonly #maxConcurrentRuns: number;
  readonly #perHarnessLimits: Readonly<Partial<Record<HarnessId, number>>>;
  readonly #isRetryableError: (
    error: unknown,
    claim: RunExecutionClaim,
  ) => boolean;
  readonly #onCoordinatorError: (error: unknown, runId: string) => void;
  readonly #active = new Map<string, ActiveRun>();
  #pollInFlight: Promise<RunPollResult> | undefined;

  constructor(options: RunCoordinatorOptions) {
    if (!options.leaseOwner.trim()) {
      throw new RuntimeContractError("leaseOwner is required.");
    }
    this.#harnesses = options.harnesses;
    this.#cwdResolver = options.cwdResolver;
    this.#runs = options.runs;
    this.#approvals = options.approvals;
    this.#leaseOwner = options.leaseOwner;
    this.#clock = options.clock ?? (() => new Date());
    this.#timers = options.timers ?? nodeIntervalScheduler;
    this.#maxConcurrentRuns = boundedInteger(
      options.maxConcurrentRuns,
      "maxConcurrentRuns",
      1,
      256,
    );
    this.#leaseDurationMs = boundedInteger(
      options.leaseDurationMs ?? 30_000,
      "leaseDurationMs",
      MIN_LEASE_MS,
      MAX_LEASE_MS,
    );
    this.#heartbeatIntervalMs = boundedInteger(
      options.heartbeatIntervalMs ?? 10_000,
      "heartbeatIntervalMs",
      250,
      this.#leaseDurationMs - 1,
    );
    const limits: Partial<Record<HarnessId, number>> = {};
    for (const [harnessId, limit] of Object.entries(
      options.perHarnessLimits ?? {},
    )) {
      limits[harnessId as HarnessId] = boundedInteger(
        limit,
        `perHarnessLimits.${harnessId}`,
        1,
        this.#maxConcurrentRuns,
      );
    }
    this.#perHarnessLimits = Object.freeze(limits);
    this.#isRetryableError = options.isRetryableError ?? (() => false);
    this.#onCoordinatorError = options.onCoordinatorError ?? (() => undefined);
  }

  get activeCount(): number {
    return this.#active.size;
  }

  async poll(): Promise<RunPollResult> {
    if (this.#pollInFlight) return this.#pollInFlight;
    const operation = this.#pollOnce();
    this.#pollInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.#pollInFlight === operation) this.#pollInFlight = undefined;
    }
  }

  async #pollOnce(): Promise<RunPollResult> {
    const capacity = this.#maxConcurrentRuns - this.#active.size;
    if (capacity <= 0) return { claimed: 0, started: 0, released: 0 };
    const pollNow = clockDate(this.#clock);
    const claims = await this.#runs.claimRunnableRuns({
      now: pollNow.toISOString(),
      leaseOwner: this.#leaseOwner,
      leaseUntil: new Date(
        pollNow.getTime() + this.#leaseDurationMs,
      ).toISOString(),
      limit: capacity,
      globalLimit: this.#maxConcurrentRuns,
      perHarnessLimits: this.#perHarnessLimits,
    });
    if (claims.length > capacity) {
      throw new RuntimeContractError(
        "claimRunnableRuns returned more claims than requested.",
      );
    }
    let started = 0;
    let released = 0;
    for (const claim of claims) {
      const harnessLimit =
        this.#perHarnessLimits[claim.harnessId] ?? this.#maxConcurrentRuns;
      const activeForHarness = [...this.#active.values()].filter(
        (active) => active.claim.harnessId === claim.harnessId,
      ).length;
      if (this.#active.has(claim.runId) || activeForHarness >= harnessLimit) {
        await this.#runs.releaseRunLease({
          leaseToken: claim.leaseToken,
          releasedAt: clockDate(this.#clock).toISOString(),
          reasonCode: "local_concurrency_limit",
        });
        released += 1;
        continue;
      }
      const active: ActiveRun = {
        claim,
        providerStarted: false,
        heartbeatRunning: false,
        eventTail: Promise.resolve(),
        leaseLost: false,
        finished: false,
        cancelRequested: false,
        cancelSent: false,
        retryableFailure: false,
        ...(claim.sessionId === undefined
          ? {}
          : { sessionId: claim.sessionId }),
        pendingApprovals: new Set(),
      };
      this.#active.set(claim.runId, active);
      active.task = this.#execute(active)
        .catch((error) => this.#reportError(error, claim.runId))
        .finally(() => {
          active.finished = true;
          active.heartbeat?.cancel();
          this.#active.delete(claim.runId);
        });
      started += 1;
    }
    return { claimed: claims.length, started, released };
  }

  async waitForIdle(): Promise<void> {
    while (this.#active.size > 0) {
      await Promise.allSettled(
        [...this.#active.values()]
          .map((active) => active.task)
          .filter((task): task is Promise<void> => task !== undefined),
      );
    }
  }

  async cancel(runId: string): Promise<"not-found" | "recorded" | "terminal"> {
    const persisted = await this.#runs.requestRunCancellation({
      runId,
      requestedAt: clockDate(this.#clock).toISOString(),
    });
    if (persisted.status === "not-found") return "not-found";
    if (persisted.status === "terminal") return "terminal";
    const active = this.#active.get(runId);
    if (active) await this.#sendCancellation(active);
    return "recorded";
  }

  async respondToApproval(
    runId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<ApprovalDispatchResult> {
    const decisionNow = clockDate(this.#clock);
    const dispatch = await this.#approvals.claimDecisionDispatch({
      runId,
      approvalId,
      decision,
      leaseOwner: this.#leaseOwner,
      now: decisionNow.toISOString(),
      leaseUntil: new Date(
        decisionNow.getTime() + this.#leaseDurationMs,
      ).toISOString(),
    });
    if (dispatch.status === "already-dispatched") return "already-dispatched";
    if (dispatch.status !== "dispatch") {
      throw new ApprovalDispatchError(
        `Approval decision cannot be dispatched (${dispatch.status}).`,
      );
    }
    const { claim } = dispatch;
    const active = this.#active.get(claim.runId);
    let providerSideEffectPossible = false;
    try {
      if (
        claim.runId !== runId ||
        claim.approvalId !== approvalId ||
        !active ||
        active.leaseLost ||
        !active.providerStarted ||
        !active.pendingApprovals.has(claim.approvalId) ||
        typeof active.adapter?.respondToApproval !== "function"
      ) {
        throw new ApprovalDispatchError(
          "The approval's harness execution is not active.",
        );
      }
      // Once the external call begins, a rejection can no longer prove that
      // the provider did not receive the decision. Recovery stays fail-closed.
      providerSideEffectPossible = true;
      await active.adapter.respondToApproval(claim.approvalId, claim.decision);
      const completion = await this.#approvals.completeDecisionDispatch({
        dispatchToken: claim.dispatchToken,
        completedAt: clockDate(this.#clock).toISOString(),
      });
      if (completion !== "completed") {
        throw new ApprovalDispatchError(
          "The approval dispatch completion was fenced as stale.",
        );
      }
      active.pendingApprovals.delete(claim.approvalId);
      return "dispatched";
    } catch (error) {
      if (!providerSideEffectPossible) {
        await this.#approvals.releaseDecisionDispatch({
          dispatchToken: claim.dispatchToken,
          releasedAt: clockDate(this.#clock).toISOString(),
          errorCode: normalizedErrorCode(error, "approval_dispatch_failed"),
        });
      }
      throw error;
    }
  }

  async #execute(active: ActiveRun): Promise<void> {
    const { claim } = active;
    let completion: RunCompletion | undefined;
    let retryableOverride = false;
    const marked = await this.#runs.markRunStarting({
      leaseToken: claim.leaseToken,
      runId: claim.runId,
      startedAt: clockDate(this.#clock).toISOString(),
    });
    if (!marked) {
      active.leaseLost = true;
      return;
    }
    active.heartbeat = this.#timers.every(this.#heartbeatIntervalMs, () =>
      this.#heartbeat(active),
    );
    try {
      const cwd = await this.#cwdResolver.resolve(claim.input.cwd);
      if (active.leaseLost) return;
      try {
        active.adapter = this.#harnesses.get(claim.harnessId);
      } catch {
        const unavailable = new Error("Configured harness unavailable.");
        unavailable.name = "HarnessUnavailable";
        throw unavailable;
      }
      const input = {
        runId: claim.runId,
        prompt: claim.input.prompt,
        cwd,
        ...(claim.input.model === undefined
          ? {}
          : { model: claim.input.model }),
        ...(claim.input.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: claim.input.reasoningEffort }),
        ...(claim.input.systemPrompt === undefined
          ? {}
          : { systemPrompt: claim.input.systemPrompt }),
        ...(claim.input.approvalMode === undefined
          ? {}
          : { approvalMode: claim.input.approvalMode }),
      };
      const eventSink = (event: HarnessEvent): Promise<void> => {
        const write = active.eventTail.then(() =>
          this.#persistEvent(active, event),
        );
        active.eventTail = write;
        return write;
      };
      if (claim.mode === "resume" && !claim.sessionId?.trim()) {
        throw new RuntimeContractError("A resume claim requires a sessionId.");
      }
      const handle =
        claim.mode === "resume"
          ? await active.adapter.resume(
              { ...input, sessionId: claim.sessionId as string },
              eventSink,
            )
          : await active.adapter.start(input, eventSink);
      if (handle.runId !== claim.runId) {
        throw new RuntimeContractError(
          "Harness returned a handle for a different run.",
        );
      }
      active.providerStarted = true;
      if (active.cancelRequested) await this.#sendCancellation(active);
      completion = await handle.completion;
      await active.eventTail;
    } catch (error) {
      if (active.leaseLost) return;
      const code = normalizedErrorCode(error, "harness_execution_failed");
      completion = {
        runId: claim.runId,
        status: "failed",
        errorCode: code,
      };
      retryableOverride = this.#isRetryableError(error, claim);
    }
    if (completion && !active.leaseLost) {
      await this.#finish(active, completion, retryableOverride);
    }
  }

  async #persistEvent(active: ActiveRun, source: HarnessEvent): Promise<void> {
    const { claim } = active;
    if (active.leaseLost) return;
    if (source.runId !== claim.runId) {
      throw new RuntimeContractError(
        "Harness event runId does not match its claim.",
      );
    }
    if (!Number.isSafeInteger(source.sequence) || source.sequence < 0) {
      throw new RuntimeContractError("Harness event sequence is invalid.");
    }
    const sequence = claim.nextEventSequence + source.sequence;
    if (!Number.isSafeInteger(sequence)) {
      throw new RuntimeContractError("Persisted event sequence overflowed.");
    }
    const event = { ...source, sequence } as HarnessEvent;
    const projection = eventProjection(event);
    let persisted: "duplicate" | "recorded" | "stale";
    try {
      persisted = await this.#runs.recordRunEvent({
        leaseToken: claim.leaseToken,
        executionId: claim.executionId,
        idempotencyKey: runEventIdempotencyKey(
          claim.executionId,
          source.sequence,
        ),
        event,
        projection,
      });
    } catch (error) {
      // An unknown write outcome is a fencing failure, not a provider failure.
      active.leaseLost = true;
      this.#reportError(error, claim.runId);
      void Promise.resolve().then(() =>
        this.#sendCancellation(active).catch(() => undefined),
      );
      return;
    }
    if (persisted === "stale") {
      active.leaseLost = true;
      // Do not reject the sink: adapters commonly emit a cancellation event
      // before interrupting their provider. Rejecting here could prevent the
      // actual interrupt. Fence further writes and cancel after this sink turn.
      void Promise.resolve().then(() =>
        this.#sendCancellation(active).catch(() => undefined),
      );
      return;
    }
    if (event.type === "session.bound") active.sessionId = event.sessionId;
    if (event.type === "approval.requested") {
      active.pendingApprovals.add(event.approvalId);
    }
    if (event.type === "run.failed") {
      active.retryableFailure ||= event.retryable;
      active.lastFailureCode = event.code;
      active.lastFailureMessage = event.message;
    }
  }

  async #finish(
    active: ActiveRun,
    completion: RunCompletion,
    retryableOverride = false,
  ): Promise<void> {
    const { claim } = active;
    if (completion.runId !== claim.runId) {
      throw new RuntimeContractError(
        "Harness completion runId does not match its claim.",
      );
    }
    if (
      !(["canceled", "failed", "succeeded"] as const).includes(
        completion.status,
      )
    ) {
      throw new RuntimeContractError("Harness completion status is invalid.");
    }
    const finishedAt = clockDate(this.#clock);
    const retryable = active.retryableFailure || retryableOverride;
    const delay =
      completion.status === "failed" && retryable
        ? retryDelayMs(claim.retryPolicy, claim.attempt)
        : null;
    const errorCode =
      completion.errorCode ??
      active.lastFailureCode ??
      "harness_execution_failed";
    const result = await this.#runs.finishRunExecution({
      leaseToken: claim.leaseToken,
      runId: claim.runId,
      executionId: claim.executionId,
      finishedAt: finishedAt.toISOString(),
      outcome: completion.status,
      ...((active.sessionId ?? completion.sessionId)
        ? { sessionId: active.sessionId ?? completion.sessionId }
        : {}),
      ...(completion.status === "failed"
        ? {
            errorCode,
            errorMessage:
              active.lastFailureMessage ?? safeFailureMessage(errorCode),
          }
        : {}),
      ...(delay === null
        ? {}
        : {
            retry: {
              nextAttempt: claim.attempt + 1,
              notBefore: new Date(finishedAt.getTime() + delay).toISOString(),
            },
          }),
    });
    if (result === "stale") active.leaseLost = true;
  }

  async #heartbeat(active: ActiveRun): Promise<void> {
    if (active.finished || active.leaseLost || active.heartbeatRunning) return;
    active.heartbeatRunning = true;
    try {
      const heartbeatAt = clockDate(this.#clock);
      const renewal = await this.#runs.renewRunLease({
        leaseToken: active.claim.leaseToken,
        now: heartbeatAt.toISOString(),
        leaseUntil: new Date(
          heartbeatAt.getTime() + this.#leaseDurationMs,
        ).toISOString(),
      });
      if (!renewal.renewed) {
        active.leaseLost = true;
        await this.#sendCancellation(active);
        return;
      }
      if (renewal.cancelRequested) await this.#sendCancellation(active);
    } catch {
      // Continuing after an uncertain renewal risks split-brain execution.
      active.leaseLost = true;
      await this.#sendCancellation(active).catch(() => undefined);
    } finally {
      active.heartbeatRunning = false;
    }
  }

  async #sendCancellation(active: ActiveRun): Promise<void> {
    active.cancelRequested = true;
    if (
      active.cancelSent ||
      !active.providerStarted ||
      active.adapter === undefined
    ) {
      return;
    }
    active.cancelSent = true;
    try {
      await active.adapter.cancel(active.claim.runId);
    } catch (error) {
      active.cancelSent = false;
      throw error;
    }
  }

  #reportError(error: unknown, runId: string): void {
    try {
      this.#onCoordinatorError(error, runId);
    } catch {
      // Observability hooks must never break run cleanup or create rejections.
    }
  }
}
