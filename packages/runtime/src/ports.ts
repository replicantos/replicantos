import type {
  ApprovedCwdResolver,
  HarnessRegistry,
} from "@replicantos/harnesses";
import type {
  ApprovalDecision,
  HarnessEvent,
  HarnessId,
  RunApprovalMode,
  RunTerminalStatus,
} from "@replicantos/protocol/harness";
import type { RunStatus } from "@replicantos/protocol";

import type { RetryPolicy } from "./retry.js";

export type RuntimeClock = () => Date;

export interface IntervalHandle {
  cancel(): void;
}

export interface IntervalScheduler {
  every(
    intervalMs: number,
    callback: () => Promise<void> | void,
  ): IntervalHandle;
}

export interface ScheduleSnapshot {
  id: string;
  workspaceId: string;
  replicantId: string;
  channelId: string | null;
  taskId: string | null;
  cronExpression: string;
  timezone: string;
  harnessOverride: HarnessId | null;
  modelOverride: string | null;
  effortOverride: string | null;
  prompt: string;
  retryPolicy: RetryPolicy;
}

export interface DueScheduleClaim {
  /** Opaque fencing token for compare-and-set completion/release. */
  claimToken: string;
  /** The due instant remains stable when an expired claim is reclaimed. */
  scheduledFor: string;
  schedule: ScheduleSnapshot;
}

export interface ClaimDueSchedulesInput {
  now: string;
  leaseOwner: string;
  leaseUntil: string;
  limit: number;
}

export interface CompleteScheduleClaimInput {
  claimToken: string;
  completedAt: string;
  nextRunAt: string;
  runId: string;
}

export interface ReleaseScheduleClaimInput {
  claimToken: string;
  releasedAt: string;
  errorCode: string;
}

/**
 * The database implementation must claim due rows atomically, permit only one
 * live lease per schedule occurrence, reclaim expired leases, and fence every
 * completion/release by claimToken.
 */
export interface ScheduleClaimRepositoryPort {
  claimDueSchedules(
    input: ClaimDueSchedulesInput,
  ): Promise<readonly DueScheduleClaim[]>;
  completeScheduleClaim(
    input: CompleteScheduleClaimInput,
  ): Promise<"completed" | "stale">;
  releaseScheduleClaim(input: ReleaseScheduleClaimInput): Promise<void>;
}

export interface EnsureScheduledRunInput {
  idempotencyKey: string;
  scheduledFor: string;
  schedule: ScheduleSnapshot;
}

/** The database must enforce a unique constraint on idempotencyKey. */
export interface ScheduledRunRepositoryPort {
  ensureScheduledRun(
    input: EnsureScheduledRunInput,
  ): Promise<{ runId: string; created: boolean }>;
}

export interface RunExecutionInput {
  prompt: string;
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  systemPrompt?: string;
  approvalMode?: RunApprovalMode;
}

export interface RunExecutionClaim {
  leaseToken: string;
  /** Unique for each provider invocation, including a recovered resume. */
  executionId: string;
  runId: string;
  harnessId: HarnessId;
  mode: "resume" | "start";
  sessionId?: string;
  attempt: number;
  nextEventSequence: number;
  retryPolicy: RetryPolicy;
  input: RunExecutionInput;
}

export interface ClaimRunnableRunsInput {
  now: string;
  leaseOwner: string;
  leaseUntil: string;
  limit: number;
  /** Repository implementations enforce these limits across all live leases. */
  globalLimit: number;
  perHarnessLimits: Readonly<Partial<Record<HarnessId, number>>>;
}

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costMicros?: number;
}

export interface ApprovalRequestProjection {
  approvalId: string;
  kind: "question" | "tool";
  title: string;
  detail: string;
  risk: "high" | "low" | "medium";
  options?: readonly {
    id: string;
    label: string;
    kind: "allow" | "deny";
  }[];
  questions?: readonly {
    id: string;
    question: string;
    multiSelect: boolean;
    options: readonly { label: string; description: string }[];
  }[];
}

/** Materialized atomically with its normalized event. */
export interface RunEventProjection {
  status?: RunStatus;
  harnessSessionId?: string;
  usage?: UsageSnapshot;
  assistantTextDelta?: string;
  approvalRequest?: ApprovalRequestProjection;
  failure?: { code: string; message: string; retryable: boolean };
}

export interface PersistRunEventInput {
  leaseToken: string;
  executionId: string;
  /** Stable across a retry of the same persistence call. */
  idempotencyKey: string;
  event: HarnessEvent;
  projection: RunEventProjection;
}

export interface RunRetryDirective {
  nextAttempt: number;
  notBefore: string;
}

export interface FinishRunExecutionInput {
  leaseToken: string;
  runId: string;
  executionId: string;
  finishedAt: string;
  outcome: RunTerminalStatus;
  sessionId?: string;
  errorCode?: string;
  errorMessage?: string;
  retry?: RunRetryDirective;
}

export interface RequestRunCancellationResult {
  status: "already-requested" | "not-found" | "requested" | "terminal";
}

export interface RenewRunLeaseResult {
  renewed: boolean;
  cancelRequested: boolean;
}

/**
 * This port is the restart boundary. Claims and transitions are fenced by
 * leaseToken. recordRunEvent must atomically append the normalized event and
 * apply its projection, deduplicating by idempotencyKey. A recovered claim uses
 * mode=resume only when its persisted session is safe to resume. It must not
 * issue mode=start after a prior provider invocation became ambiguous; that
 * case stays fail-closed for reconciliation rather than risking duplicate work.
 * claimRunnableRuns also excludes cancellations and retry rows whose notBefore
 * instant is still in the future, and enforces the supplied limits atomically
 * across live leases.
 */
export interface RunRepositoryPort {
  claimRunnableRuns(
    input: ClaimRunnableRunsInput,
  ): Promise<readonly RunExecutionClaim[]>;
  markRunStarting(input: {
    leaseToken: string;
    runId: string;
    startedAt: string;
  }): Promise<boolean>;
  renewRunLease(input: {
    leaseToken: string;
    now: string;
    leaseUntil: string;
  }): Promise<RenewRunLeaseResult>;
  recordRunEvent(
    input: PersistRunEventInput,
  ): Promise<"duplicate" | "recorded" | "stale">;
  finishRunExecution(
    input: FinishRunExecutionInput,
  ): Promise<"finished" | "retry-scheduled" | "stale">;
  releaseRunLease(input: {
    leaseToken: string;
    releasedAt: string;
    reasonCode: string;
  }): Promise<void>;
  requestRunCancellation(input: {
    runId: string;
    requestedAt: string;
  }): Promise<RequestRunCancellationResult>;
}

export interface ApprovalDispatchClaim {
  dispatchToken: string;
  runId: string;
  approvalId: string;
  decision: ApprovalDecision;
}

export type ClaimApprovalDecisionResult =
  | { status: "dispatch"; claim: ApprovalDispatchClaim }
  | { status: "already-dispatched" | "not-found" | "not-pending" };

/**
 * claimDecisionDispatch atomically records/leases a decision. Completion must
 * atomically mark it dispatched and return its run from awaiting-approval to
 * running only when the run is still awaiting that approval (it must never
 * regress a terminal state). A dispatch lease is released only when no provider
 * side effect was delivered; ambiguous crash recovery remains fail-closed for
 * server review.
 */
export interface ApprovalRepositoryPort {
  claimDecisionDispatch(input: {
    runId: string;
    approvalId: string;
    decision: ApprovalDecision;
    leaseOwner: string;
    now: string;
    leaseUntil: string;
  }): Promise<ClaimApprovalDecisionResult>;
  completeDecisionDispatch(input: {
    dispatchToken: string;
    completedAt: string;
  }): Promise<"completed" | "stale">;
  releaseDecisionDispatch(input: {
    dispatchToken: string;
    releasedAt: string;
    errorCode: string;
  }): Promise<void>;
}

export interface RuntimeDependencies {
  harnesses: HarnessRegistry;
  cwdResolver: ApprovedCwdResolver;
  runs: RunRepositoryPort;
  approvals: ApprovalRepositoryPort;
}
