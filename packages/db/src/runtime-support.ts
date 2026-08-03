import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, win32 } from "node:path";

import type { RetryPolicy, RunExecutionClaim } from "@replicantos/runtime";

import type { ReplicantDatabase } from "./database.ts";

type HarnessId = RunExecutionClaim["harnessId"];

export type RuntimeIdKind =
  | "approval-dispatch"
  | "audit"
  | "event"
  | "execution"
  | "lease"
  | "message"
  | "run"
  | "schedule-claim";

export interface RuntimeCwdContext {
  workspaceId: string;
  replicantId: string;
  relativeWorkspacePath: string;
}

export interface SqliteRuntimeRepositoryOptions {
  resolveReplicantCwd(context: RuntimeCwdContext): string;
  idFactory?: (kind: RuntimeIdKind) => string;
}

export interface RuntimeRepositoryContext {
  database: ReplicantDatabase;
  resolveReplicantCwd(context: RuntimeCwdContext): string;
  id(kind: RuntimeIdKind): string;
}

const ID_PREFIX: Readonly<Record<RuntimeIdKind, string>> = Object.freeze({
  "approval-dispatch": "approval_dispatch",
  audit: "aud",
  event: "evt",
  execution: "execution",
  lease: "lease",
  message: "msg",
  run: "run",
  "schedule-claim": "schedule_claim",
});

const HARNESSES = new Set<HarnessId>(["claude", "codex", "grok", "opencode"]);

function defaultId(kind: RuntimeIdKind): string {
  return `${ID_PREFIX[kind]}_${randomUUID()}`;
}

export function createRuntimeRepositoryContext(
  database: ReplicantDatabase,
  options: SqliteRuntimeRepositoryOptions,
): RuntimeRepositoryContext {
  if (typeof options.resolveReplicantCwd !== "function") {
    throw new TypeError("resolveReplicantCwd is required");
  }
  const generate = options.idFactory ?? defaultId;
  return {
    database,
    resolveReplicantCwd: options.resolveReplicantCwd,
    id(kind) {
      return runtimeText(generate(kind), `${kind} identifier`, 500);
    },
  };
}

export function runtimeText(
  value: string,
  name: string,
  maximum = 10_000,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new TypeError(`${name} must be a nonempty bounded string`);
  }
  return value;
}

export function optionalRuntimeText(
  value: string | undefined,
  name: string,
  maximum = 10_000,
): string | null {
  return value === undefined ? null : runtimeText(value, name, maximum);
}

export function runtimeInstant(value: string, name: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError(`${name} must be a canonical ISO-8601 UTC instant`);
  }
  return value;
}

export function runtimeInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

export function runtimeHarness(value: string): HarnessId {
  if (!HARNESSES.has(value as HarnessId)) {
    throw new TypeError("run harness is not supported by the runtime contract");
  }
  return value as HarnessId;
}

export function runtimeCwd(value: string): string {
  const cwd = runtimeText(value, "run cwd", 4_096);
  if (!isAbsolute(cwd) && !win32.isAbsolute(cwd)) {
    throw new TypeError("run cwd must be absolute");
  }
  return cwd;
}

function normalizeJson(value: unknown, seen: Set<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("JSON numbers must be finite");
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError("Value is not JSON serializable");
  }
  if (seen.has(value))
    throw new TypeError("JSON values may not contain cycles");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => normalizeJson(entry, seen));
    }
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      const entry = input[key];
      if (entry === undefined) {
        throw new TypeError("JSON object values may not be undefined");
      }
      output[key] = normalizeJson(entry, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function stableJsonText(value: unknown): string {
  return JSON.stringify(normalizeJson(value, new Set()));
}

export function parseStoredJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

export function runtimeDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function scheduleOccurrenceIdentity(
  scheduleId: string,
  scheduledFor: string,
): string {
  return `occurrence_${runtimeDigest(`${scheduleId}\0${scheduledFor}`)}`;
}

export function parseRuntimeRetryPolicy(value: unknown): RetryPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("retry policy must be an object");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "initialDelayMs",
    "maxAttempts",
    "maxDelayMs",
    "multiplier",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new TypeError("retry policy contains an unsupported field");
  }
  const maxAttempts = runtimeInteger(
    input.maxAttempts ?? 1,
    "retry maxAttempts",
    1,
    10,
  );
  const initialDelayMs = runtimeInteger(
    input.initialDelayMs ?? 0,
    "retry initialDelayMs",
    0,
    7 * 24 * 60 * 60 * 1_000,
  );
  const maxDelayMs = runtimeInteger(
    input.maxDelayMs ?? 7 * 24 * 60 * 60 * 1_000,
    "retry maxDelayMs",
    0,
    7 * 24 * 60 * 60 * 1_000,
  );
  const multiplier = input.multiplier ?? 2;
  if (
    typeof multiplier !== "number" ||
    !Number.isFinite(multiplier) ||
    multiplier < 1 ||
    multiplier > 10
  ) {
    throw new RangeError("retry multiplier must be between 1 and 10");
  }
  if (maxDelayMs < initialDelayMs) {
    throw new RangeError("retry maxDelayMs must not precede initialDelayMs");
  }
  return { maxAttempts, initialDelayMs, multiplier, maxDelayMs };
}

export function retryPolicyText(value: RetryPolicy): string {
  return stableJsonText(parseRuntimeRetryPolicy(value));
}
