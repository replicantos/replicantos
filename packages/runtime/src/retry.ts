export interface RetryPolicy {
  /** Includes the initial execution. */
  maxAttempts: number;
  initialDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
}

export const RETRY_LIMITS = Object.freeze({
  maxAttempts: 10,
  maxDelayMs: 7 * 24 * 60 * 60 * 1_000,
  maxMultiplier: 10,
});

export const NO_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  maxAttempts: 1,
  initialDelayMs: 0,
  multiplier: 1,
  maxDelayMs: 0,
});

function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new RetryPolicyError(`${name} must be a safe integer.`);
  }
  return value as number;
}

function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RetryPolicyError(`${name} must be a finite number.`);
  }
  return value;
}

export class RetryPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryPolicyError";
  }
}

export function parseRetryPolicy(value: unknown): RetryPolicy {
  if (value === undefined || value === null) return { ...NO_RETRY_POLICY };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new RetryPolicyError("retryPolicy must be an object.");
  }
  const input = value as Record<string, unknown>;
  const supportedKeys = new Set([
    "initialDelayMs",
    "maxAttempts",
    "maxDelayMs",
    "multiplier",
  ]);
  const unknownKey = Object.keys(input).find((key) => !supportedKeys.has(key));
  if (unknownKey !== undefined) {
    throw new RetryPolicyError(`retryPolicy.${unknownKey} is not supported.`);
  }
  const policy: RetryPolicy = {
    maxAttempts: integer(input.maxAttempts ?? 1, "maxAttempts"),
    initialDelayMs: integer(input.initialDelayMs ?? 0, "initialDelayMs"),
    multiplier: finite(input.multiplier ?? 2, "multiplier"),
    maxDelayMs: integer(
      input.maxDelayMs ?? RETRY_LIMITS.maxDelayMs,
      "maxDelayMs",
    ),
  };
  if (policy.maxAttempts < 1 || policy.maxAttempts > RETRY_LIMITS.maxAttempts) {
    throw new RetryPolicyError(
      `maxAttempts must be between 1 and ${RETRY_LIMITS.maxAttempts}.`,
    );
  }
  if (
    policy.initialDelayMs < 0 ||
    policy.initialDelayMs > RETRY_LIMITS.maxDelayMs
  ) {
    throw new RetryPolicyError(
      "initialDelayMs is outside the supported range.",
    );
  }
  if (policy.multiplier < 1 || policy.multiplier > RETRY_LIMITS.maxMultiplier) {
    throw new RetryPolicyError(
      `multiplier must be between 1 and ${RETRY_LIMITS.maxMultiplier}.`,
    );
  }
  if (policy.maxDelayMs < 0 || policy.maxDelayMs > RETRY_LIMITS.maxDelayMs) {
    throw new RetryPolicyError("maxDelayMs is outside the supported range.");
  }
  if (policy.maxDelayMs < policy.initialDelayMs) {
    throw new RetryPolicyError(
      "maxDelayMs must be greater than or equal to initialDelayMs.",
    );
  }
  return policy;
}

/** Returns null when the failed attempt exhausted the policy. */
export function retryDelayMs(
  policyValue: RetryPolicy,
  failedAttempt: number,
): number | null {
  const policy = parseRetryPolicy(policyValue);
  const attempt = integer(failedAttempt, "failedAttempt");
  if (attempt < 1) {
    throw new RetryPolicyError("failedAttempt must be at least 1.");
  }
  if (attempt >= policy.maxAttempts) return null;
  const exponential =
    policy.initialDelayMs * Math.pow(policy.multiplier, attempt - 1);
  return Math.min(policy.maxDelayMs, Math.round(exponential));
}
