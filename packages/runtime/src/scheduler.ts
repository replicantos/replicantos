import { MAX_CRON_SEARCH_MINUTES, nextCronOccurrence } from "./cron.js";
import type {
  DueScheduleClaim,
  RuntimeClock,
  ScheduleClaimRepositoryPort,
  ScheduledRunRepositoryPort,
} from "./ports.js";

const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 10 * 60 * 1_000;

export interface ScheduleCoordinatorOptions {
  claims: ScheduleClaimRepositoryPort;
  runs: ScheduledRunRepositoryPort;
  leaseOwner: string;
  clock?: RuntimeClock;
  leaseDurationMs?: number;
  maxClaimsPerTick?: number;
  maxConcurrentClaims?: number;
  maxCronSearchMinutes?: number;
}

export interface ScheduleTickError {
  scheduleId: string;
  errorCode: string;
}

export interface ScheduleTickResult {
  claimed: number;
  createdRuns: number;
  existingRuns: number;
  completedClaims: number;
  staleClaims: number;
  releasedClaims: number;
  errors: readonly ScheduleTickError[];
}

export class RuntimeContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeContractError";
  }
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

function now(clock: RuntimeClock): Date {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RuntimeContractError("clock must return a valid Date.");
  }
  return value;
}

function errorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : "schedule_tick_failed";
  const normalized = name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .toLowerCase()
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized && normalized !== "error"
    ? normalized
    : "schedule_tick_failed";
}

export function scheduleOccurrenceKey(
  scheduleId: string,
  scheduledFor: string,
): string {
  if (!scheduleId.trim())
    throw new RuntimeContractError("scheduleId is required.");
  const instant = new Date(scheduledFor);
  if (!Number.isFinite(instant.getTime())) {
    throw new RuntimeContractError("scheduledFor must be a valid instant.");
  }
  return `schedule/${encodeURIComponent(scheduleId)}/${instant.toISOString()}`;
}

async function parallelForEach<T>(
  values: readonly T[],
  concurrency: number,
  callback: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < values.length) {
      const index = cursor++;
      const value = values[index];
      if (value !== undefined) await callback(value);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker),
  );
}

export class ScheduleCoordinator {
  readonly #claims: ScheduleClaimRepositoryPort;
  readonly #runs: ScheduledRunRepositoryPort;
  readonly #leaseOwner: string;
  readonly #clock: RuntimeClock;
  readonly #leaseDurationMs: number;
  readonly #maxClaimsPerTick: number;
  readonly #maxConcurrentClaims: number;
  readonly #maxCronSearchMinutes: number | undefined;
  #tickInFlight: Promise<ScheduleTickResult> | undefined;

  constructor(options: ScheduleCoordinatorOptions) {
    if (!options.leaseOwner.trim()) {
      throw new RuntimeContractError("leaseOwner is required.");
    }
    this.#claims = options.claims;
    this.#runs = options.runs;
    this.#leaseOwner = options.leaseOwner;
    this.#clock = options.clock ?? (() => new Date());
    this.#leaseDurationMs = boundedInteger(
      options.leaseDurationMs ?? 30_000,
      "leaseDurationMs",
      MIN_LEASE_MS,
      MAX_LEASE_MS,
    );
    this.#maxClaimsPerTick = boundedInteger(
      options.maxClaimsPerTick ?? 32,
      "maxClaimsPerTick",
      1,
      1_000,
    );
    this.#maxConcurrentClaims = boundedInteger(
      options.maxConcurrentClaims ?? 4,
      "maxConcurrentClaims",
      1,
      64,
    );
    if (options.maxCronSearchMinutes !== undefined) {
      boundedInteger(
        options.maxCronSearchMinutes,
        "maxCronSearchMinutes",
        1,
        MAX_CRON_SEARCH_MINUTES,
      );
    }
    this.#maxCronSearchMinutes = options.maxCronSearchMinutes;
  }

  async tick(): Promise<ScheduleTickResult> {
    if (this.#tickInFlight) return this.#tickInFlight;
    const operation = this.#tickOnce();
    this.#tickInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.#tickInFlight === operation) this.#tickInFlight = undefined;
    }
  }

  async #tickOnce(): Promise<ScheduleTickResult> {
    const tickNow = now(this.#clock);
    const claims = await this.#claims.claimDueSchedules({
      now: tickNow.toISOString(),
      leaseOwner: this.#leaseOwner,
      leaseUntil: new Date(
        tickNow.getTime() + this.#leaseDurationMs,
      ).toISOString(),
      limit: this.#maxClaimsPerTick,
    });
    if (claims.length > this.#maxClaimsPerTick) {
      throw new RuntimeContractError(
        "claimDueSchedules returned more claims than requested.",
      );
    }
    const result: {
      claimed: number;
      createdRuns: number;
      existingRuns: number;
      completedClaims: number;
      staleClaims: number;
      releasedClaims: number;
      errors: ScheduleTickError[];
    } = {
      claimed: claims.length,
      createdRuns: 0,
      existingRuns: 0,
      completedClaims: 0,
      staleClaims: 0,
      releasedClaims: 0,
      errors: [],
    };

    await parallelForEach(claims, this.#maxConcurrentClaims, async (claim) => {
      await this.#processClaim(claim, result);
    });
    return result;
  }

  async #processClaim(
    claim: DueScheduleClaim,
    result: {
      createdRuns: number;
      existingRuns: number;
      completedClaims: number;
      staleClaims: number;
      releasedClaims: number;
      errors: ScheduleTickError[];
    },
  ): Promise<void> {
    try {
      const nextRunAt = nextCronOccurrence(
        claim.schedule.cronExpression,
        claim.schedule.timezone,
        claim.scheduledFor,
        this.#maxCronSearchMinutes === undefined
          ? {}
          : { maxSearchMinutes: this.#maxCronSearchMinutes },
      ).toISOString();
      const run = await this.#runs.ensureScheduledRun({
        idempotencyKey: scheduleOccurrenceKey(
          claim.schedule.id,
          claim.scheduledFor,
        ),
        scheduledFor: new Date(claim.scheduledFor).toISOString(),
        schedule: claim.schedule,
      });
      if (!run.runId.trim()) {
        throw new RuntimeContractError(
          "ensureScheduledRun returned an empty runId.",
        );
      }
      if (run.created) result.createdRuns += 1;
      else result.existingRuns += 1;
      const completion = await this.#claims.completeScheduleClaim({
        claimToken: claim.claimToken,
        completedAt: now(this.#clock).toISOString(),
        nextRunAt,
        runId: run.runId,
      });
      if (completion === "completed") result.completedClaims += 1;
      else result.staleClaims += 1;
    } catch (error) {
      const code = errorCode(error);
      result.errors.push({ scheduleId: claim.schedule.id, errorCode: code });
      try {
        await this.#claims.releaseScheduleClaim({
          claimToken: claim.claimToken,
          releasedAt: now(this.#clock).toISOString(),
          errorCode: code,
        });
        result.releasedClaims += 1;
      } catch (releaseError) {
        result.errors.push({
          scheduleId: claim.schedule.id,
          errorCode: errorCode(releaseError),
        });
      }
    }
  }
}
