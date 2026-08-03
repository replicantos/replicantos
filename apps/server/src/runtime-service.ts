import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  createRuntimeRepositories,
  type EnqueueRuntimeRunInput,
  type ReplicantDatabase,
  type RuntimeRunProjectionRecord,
  type SqliteRuntimeRepositories,
} from "@replicantos/db";
import {
  createApprovedRootCwdResolver,
  createDefaultHarnessRegistry,
  type ApprovedCwdResolver,
  type HarnessRegistry,
} from "@replicantos/harnesses";
import type {
  ApprovalDecision,
  DoctorContext,
  DoctorResult,
  HarnessId,
  HarnessManifest,
} from "@replicantos/protocol/harness";
import {
  RunCoordinator,
  ScheduleCoordinator,
  type ApprovalDispatchResult,
  type RunCoordinatorOptions,
  type RunPollResult,
  type ScheduleCoordinatorOptions,
  type ScheduleTickResult,
} from "@replicantos/runtime";

const PROCESS_WORKER_ID = `runtime-${process.pid}-${randomUUID()}`;
const DEFAULT_SCHEDULE_POLL_MS = 5_000;
const DEFAULT_RUN_POLL_MS = 500;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;

export interface RuntimeServiceLogContext {
  code: string;
  runId?: string;
  workerId?: string;
}

export interface RuntimeServiceLogger {
  info?(context: RuntimeServiceLogContext, message: string): void;
  warn?(context: RuntimeServiceLogContext, message: string): void;
  error?(context: RuntimeServiceLogContext, message: string): void;
}

export interface RuntimeTimerHandle {
  cancel(): void;
}

export interface RuntimeLoopTimer {
  schedule(delayMs: number, callback: () => void): RuntimeTimerHandle;
}

export interface RuntimeShutdownWaiter {
  wait(operation: Promise<void>, timeoutMs: number): Promise<boolean>;
}

export interface RuntimeScheduleCoordinator {
  tick(): Promise<ScheduleTickResult | void>;
}

export interface RuntimeRunCoordinator {
  readonly activeCount: number;
  poll(): Promise<RunPollResult | void>;
  waitForIdle(): Promise<void>;
  cancel(runId: string): Promise<"not-found" | "recorded" | "terminal">;
  respondToApproval(
    runId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<ApprovalDispatchResult>;
}

export interface RuntimeServiceFactories {
  createHarnesses?(cwdResolver: ApprovedCwdResolver): HarnessRegistry;
  createScheduleCoordinator?(
    options: ScheduleCoordinatorOptions,
  ): RuntimeScheduleCoordinator;
  createRunCoordinator?(options: RunCoordinatorOptions): RuntimeRunCoordinator;
}

export interface CreateRuntimeServiceOptions {
  workspaceRoot: string;
  database?: ReplicantDatabase;
  repositories?: SqliteRuntimeRepositories;
  harnesses?: HarnessRegistry;
  cwdResolver?: ApprovedCwdResolver;
  factories?: RuntimeServiceFactories;
  logger?: RuntimeServiceLogger;
  loopTimer?: RuntimeLoopTimer;
  shutdownWaiter?: RuntimeShutdownWaiter;
  workerId?: string;
  clock?: () => Date;
  schedulePollIntervalMs?: number;
  runPollIntervalMs?: number;
  shutdownTimeoutMs?: number;
  maxScheduleClaimsPerTick?: number;
  maxConcurrentScheduleClaims?: number;
  maxConcurrentRuns?: number;
  perHarnessLimits?: Readonly<Partial<Record<HarnessId, number>>>;
  runLeaseDurationMs?: number;
  runHeartbeatIntervalMs?: number;
  scheduleLeaseDurationMs?: number;
  isRetryableError?: RunCoordinatorOptions["isRetryableError"];
}

export interface RuntimeStopResult {
  drained: boolean;
  activeRuns: number;
}

export interface RuntimeService {
  readonly workerId: string;
  readonly started: boolean;
  start(): Promise<void>;
  stop(): Promise<RuntimeStopResult>;
  enqueue(input: EnqueueRuntimeRunInput): void;
  cancel(runId: string): Promise<"not-found" | "recorded" | "terminal">;
  respondToApproval(
    runId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<ApprovalDispatchResult>;
  doctors(context?: DoctorContext): Promise<readonly DoctorResult[]>;
  manifests(): readonly HarnessManifest[];
  getProjection(runId: string): RuntimeRunProjectionRecord | null;
}

function boundedInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function validClock(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("runtime clock must return a valid Date");
  }
  return value;
}

function safeLog(
  logger: RuntimeServiceLogger,
  level: "error" | "info" | "warn",
  context: RuntimeServiceLogContext,
  message: string,
): void {
  try {
    logger[level]?.(context, message);
  } catch {
    // Observability hooks must not affect scheduler or shutdown behavior.
  }
}

function publicRunId(value: string): string | undefined {
  return /^[a-zA-Z0-9_-]{1,200}$/.test(value) ? value : undefined;
}

const nodeLoopTimer: RuntimeLoopTimer = Object.freeze({
  schedule(delayMs: number, callback: () => void) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
});

const nodeShutdownWaiter: RuntimeShutdownWaiter = Object.freeze({
  wait(operation: Promise<void>, timeoutMs: number) {
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
      void operation.then(
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  },
});

class NonOverlappingPollLoop {
  readonly #intervalMs: number;
  readonly #timer: RuntimeLoopTimer;
  readonly #task: () => Promise<void>;
  readonly #onError: () => void;
  #running = false;
  #timerHandle: RuntimeTimerHandle | undefined;
  #inFlight: Promise<void> | undefined;

  constructor(options: {
    intervalMs: number;
    timer: RuntimeLoopTimer;
    task: () => Promise<void>;
    onError: () => void;
  }) {
    this.#intervalMs = options.intervalMs;
    this.#timer = options.timer;
    this.#task = options.task;
    this.#onError = options.onError;
  }

  start(): Promise<void> {
    if (!this.#running) this.#running = true;
    return this.#run();
  }

  stop(): Promise<void> {
    this.#running = false;
    this.#timerHandle?.cancel();
    this.#timerHandle = undefined;
    return this.#inFlight ?? Promise.resolve();
  }

  #schedule(): void {
    if (!this.#running || this.#timerHandle !== undefined) return;
    this.#timerHandle = this.#timer.schedule(this.#intervalMs, () => {
      this.#timerHandle = undefined;
      void this.#run();
    });
  }

  #run(): Promise<void> {
    if (!this.#running) return Promise.resolve();
    if (this.#inFlight) return this.#inFlight;
    const operation = (async () => {
      try {
        await this.#task();
      } catch {
        try {
          this.#onError();
        } catch {
          // Poll failures and observability failures are contained by the loop.
        }
      }
    })();
    this.#inFlight = operation;
    void operation.then(() => {
      if (this.#inFlight === operation) this.#inFlight = undefined;
      this.#schedule();
    });
    return operation;
  }
}

function workspaceCwd(workspaceRoot: string, relativePath: string): string {
  if (
    !relativePath ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath)
  ) {
    throw new TypeError("Replicant workspace path must be relative");
  }
  const segments = relativePath.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new TypeError("Replicant workspace path contains traversal");
  }
  const candidate = path.resolve(workspaceRoot, ...segments);
  const relationship = path.relative(workspaceRoot, candidate);
  if (
    relationship === ".." ||
    relationship.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relationship)
  ) {
    throw new TypeError("Replicant workspace path escapes its configured root");
  }
  return candidate;
}

function defaultHarnesses(
  cwdResolver: ApprovedCwdResolver,
  clock: () => Date,
): HarnessRegistry {
  const harnessClock = () => validClock(clock).toISOString();
  return createDefaultHarnessRegistry({
    claude: { cwdResolver, clock: harnessClock },
    codex: { cwdResolver, clock: harnessClock },
    grok: { cwdResolver, clock: harnessClock },
    opencode: { cwdResolver, clock: harnessClock },
  });
}

class RuntimeServiceImplementation implements RuntimeService {
  readonly workerId: string;
  readonly #repositories: SqliteRuntimeRepositories;
  readonly #harnesses: HarnessRegistry;
  readonly #runCoordinator: RuntimeRunCoordinator;
  readonly #scheduleLoop: NonOverlappingPollLoop;
  readonly #runLoop: NonOverlappingPollLoop;
  readonly #shutdownWaiter: RuntimeShutdownWaiter;
  readonly #shutdownTimeoutMs: number;
  readonly #logger: RuntimeServiceLogger;
  #state: "idle" | "running" | "stopped" | "stopping" = "idle";
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<RuntimeStopResult> | undefined;

  constructor(options: {
    workerId: string;
    repositories: SqliteRuntimeRepositories;
    harnesses: HarnessRegistry;
    scheduleCoordinator: RuntimeScheduleCoordinator;
    runCoordinator: RuntimeRunCoordinator;
    loopTimer: RuntimeLoopTimer;
    schedulePollIntervalMs: number;
    runPollIntervalMs: number;
    shutdownWaiter: RuntimeShutdownWaiter;
    shutdownTimeoutMs: number;
    logger: RuntimeServiceLogger;
  }) {
    this.workerId = options.workerId;
    this.#repositories = options.repositories;
    this.#harnesses = options.harnesses;
    this.#runCoordinator = options.runCoordinator;
    this.#shutdownWaiter = options.shutdownWaiter;
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs;
    this.#logger = options.logger;
    this.#scheduleLoop = new NonOverlappingPollLoop({
      intervalMs: options.schedulePollIntervalMs,
      timer: options.loopTimer,
      task: async () => {
        const result = await options.scheduleCoordinator.tick();
        if (result && result.errors.length > 0) {
          safeLog(
            this.#logger,
            "error",
            { code: "runtime_schedule_claim_failed" },
            "A scheduled occurrence could not be persisted.",
          );
        }
      },
      onError: () =>
        safeLog(
          this.#logger,
          "error",
          { code: "runtime_schedule_poll_failed" },
          "The runtime schedule poll failed.",
        ),
    });
    this.#runLoop = new NonOverlappingPollLoop({
      intervalMs: options.runPollIntervalMs,
      timer: options.loopTimer,
      task: async () => {
        await options.runCoordinator.poll();
      },
      onError: () =>
        safeLog(
          this.#logger,
          "error",
          { code: "runtime_run_poll_failed" },
          "The runtime run poll failed.",
        ),
    });
  }

  get started(): boolean {
    return this.#state === "running";
  }

  async start(): Promise<void> {
    if (this.#state === "stopped" || this.#state === "stopping") {
      throw new Error("A stopped runtime service cannot be restarted");
    }
    if (this.#startPromise) return this.#startPromise;
    this.#state = "running";
    safeLog(
      this.#logger,
      "info",
      { code: "runtime_started", workerId: this.workerId },
      "The runtime coordinator started.",
    );
    this.#startPromise = Promise.all([
      this.#scheduleLoop.start(),
      this.#runLoop.start(),
    ]).then(() => undefined);
    return this.#startPromise;
  }

  stop(): Promise<RuntimeStopResult> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#state = "stopping";
    const scheduleStopped = this.#scheduleLoop.stop();
    const runStopped = this.#runLoop.stop();
    const drain = Promise.all([scheduleStopped, runStopped])
      .then(async () => this.#runCoordinator.waitForIdle())
      .then(() => undefined);
    this.#stopPromise = this.#shutdownWaiter
      .wait(drain, this.#shutdownTimeoutMs)
      .then(
        (drained) => {
          this.#state = "stopped";
          const activeRuns = this.#runCoordinator.activeCount;
          safeLog(
            this.#logger,
            drained ? "info" : "warn",
            {
              code: drained ? "runtime_stopped" : "runtime_shutdown_timed_out",
              workerId: this.workerId,
            },
            drained
              ? "The runtime coordinator stopped."
              : "The runtime coordinator exceeded its shutdown deadline.",
          );
          return { drained, activeRuns };
        },
        () => {
          this.#state = "stopped";
          safeLog(
            this.#logger,
            "error",
            { code: "runtime_shutdown_failed", workerId: this.workerId },
            "The runtime coordinator shutdown failed.",
          );
          return {
            drained: false,
            activeRuns: this.#runCoordinator.activeCount,
          };
        },
      );
    return this.#stopPromise;
  }

  enqueue(input: EnqueueRuntimeRunInput): void {
    this.#repositories.runs.enqueue(input);
  }

  cancel(runId: string): Promise<"not-found" | "recorded" | "terminal"> {
    return this.#runCoordinator.cancel(runId);
  }

  respondToApproval(
    runId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<ApprovalDispatchResult> {
    return this.#runCoordinator.respondToApproval(runId, approvalId, decision);
  }

  doctors(context: DoctorContext = {}): Promise<readonly DoctorResult[]> {
    return this.#harnesses.doctorAll(context);
  }

  manifests(): readonly HarnessManifest[] {
    return this.#harnesses.list();
  }

  getProjection(runId: string): RuntimeRunProjectionRecord | null {
    return this.#repositories.runs.getProjection(runId);
  }
}

export function createRuntimeService(
  options: CreateRuntimeServiceOptions,
): RuntimeService {
  if (!path.isAbsolute(options.workspaceRoot)) {
    throw new TypeError("workspaceRoot must be absolute");
  }
  const clock = options.clock ?? (() => new Date());
  validClock(clock);
  const workerId =
    options.workerId === undefined
      ? PROCESS_WORKER_ID
      : options.workerId.trim();
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(workerId)) {
    throw new TypeError("workerId must be a bounded public identifier");
  }
  const schedulePollIntervalMs = boundedInteger(
    options.schedulePollIntervalMs ?? DEFAULT_SCHEDULE_POLL_MS,
    "schedulePollIntervalMs",
    100,
    60 * 60 * 1_000,
  );
  const runPollIntervalMs = boundedInteger(
    options.runPollIntervalMs ?? DEFAULT_RUN_POLL_MS,
    "runPollIntervalMs",
    50,
    60 * 1_000,
  );
  const shutdownTimeoutMs = boundedInteger(
    options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    "shutdownTimeoutMs",
    100,
    2 * 60 * 1_000,
  );
  const logger = options.logger ?? {};
  const cwdResolver =
    options.cwdResolver ??
    createApprovedRootCwdResolver({ approvedRoots: [options.workspaceRoot] });
  const harnesses =
    options.harnesses ??
    options.factories?.createHarnesses?.(cwdResolver) ??
    defaultHarnesses(cwdResolver, clock);
  const repositories =
    options.repositories ??
    (options.database
      ? createRuntimeRepositories(options.database, {
          resolveReplicantCwd({ relativeWorkspacePath }) {
            return workspaceCwd(options.workspaceRoot, relativeWorkspacePath);
          },
        })
      : undefined);
  if (repositories === undefined) {
    throw new TypeError("database or runtime repositories are required");
  }

  const scheduleOptions: ScheduleCoordinatorOptions = {
    claims: repositories.schedules,
    runs: repositories.schedules,
    leaseOwner: `${workerId}:schedule`,
    clock,
    leaseDurationMs: options.scheduleLeaseDurationMs ?? 30_000,
    maxClaimsPerTick: options.maxScheduleClaimsPerTick ?? 32,
    maxConcurrentClaims: options.maxConcurrentScheduleClaims ?? 4,
  };
  const scheduleCoordinator =
    options.factories?.createScheduleCoordinator?.(scheduleOptions) ??
    new ScheduleCoordinator(scheduleOptions);
  const runOptions: RunCoordinatorOptions = {
    harnesses,
    cwdResolver,
    runs: repositories.runs,
    approvals: repositories.approvals,
    leaseOwner: `${workerId}:run`,
    clock,
    leaseDurationMs: options.runLeaseDurationMs ?? 30_000,
    heartbeatIntervalMs: options.runHeartbeatIntervalMs ?? 10_000,
    maxConcurrentRuns: options.maxConcurrentRuns ?? 4,
    perHarnessLimits: options.perHarnessLimits ?? {},
    ...(options.isRetryableError === undefined
      ? {}
      : { isRetryableError: options.isRetryableError }),
    onCoordinatorError(_error, runId) {
      const visibleRunId = publicRunId(runId);
      safeLog(
        logger,
        "error",
        {
          code: "runtime_run_coordination_failed",
          ...(visibleRunId === undefined ? {} : { runId: visibleRunId }),
        },
        "A runtime run could not be coordinated.",
      );
    },
  };
  const runCoordinator =
    options.factories?.createRunCoordinator?.(runOptions) ??
    new RunCoordinator(runOptions);

  return new RuntimeServiceImplementation({
    workerId,
    repositories,
    harnesses,
    scheduleCoordinator,
    runCoordinator,
    loopTimer: options.loopTimer ?? nodeLoopTimer,
    schedulePollIntervalMs,
    runPollIntervalMs,
    shutdownWaiter: options.shutdownWaiter ?? nodeShutdownWaiter,
    shutdownTimeoutMs,
    logger,
  });
}
