import assert from "node:assert/strict";
import test from "node:test";

import {
  CronExpressionError,
  nextCronOccurrence,
  parseCronExpression,
  parseRetryPolicy,
  retryDelayMs,
} from "../dist/index.js";

test("cron calculation is exclusive, deterministic, and timezone aware", () => {
  assert.equal(
    nextCronOccurrence(
      "*/15 9-10 * * 1-5",
      "America/Chicago",
      "2026-01-05T15:00:00.000Z",
    ).toISOString(),
    "2026-01-05T15:15:00.000Z",
  );
  assert.equal(
    nextCronOccurrence(
      "0 9 * * *",
      "Asia/Tokyo",
      "2026-01-01T00:00:00.000Z",
    ).toISOString(),
    "2026-01-02T00:00:00.000Z",
  );
});

test("spring-forward gaps are skipped and fall-back repeats are preserved", () => {
  assert.equal(
    nextCronOccurrence(
      "30 2 * * *",
      "America/New_York",
      "2026-03-07T08:00:00.000Z",
    ).toISOString(),
    "2026-03-09T06:30:00.000Z",
  );
  assert.equal(
    nextCronOccurrence(
      "30 1 * * *",
      "America/New_York",
      "2026-11-01T05:30:00.000Z",
    ).toISOString(),
    "2026-11-01T06:30:00.000Z",
  );
  // Even after a later wall minute in the first 01:00 hour, the repeated
  // 01:30 instant remains the next real occurrence.
  assert.equal(
    nextCronOccurrence(
      "30 1 * * *",
      "America/New_York",
      "2026-11-01T05:45:00.000Z",
    ).toISOString(),
    "2026-11-01T06:30:00.000Z",
  );
});

test("cron parsing rejects unsupported or unsafe forms", () => {
  assert.doesNotThrow(() => parseCronExpression("0 0 1 * 0"));
  assert.throws(() => parseCronExpression("0 0 * *"), CronExpressionError);
  assert.throws(() => parseCronExpression("0 0 * JAN *"), CronExpressionError);
  assert.throws(
    () => nextCronOccurrence("0 0 * * *", "Not/AZone", new Date()),
    CronExpressionError,
  );
  assert.throws(
    () =>
      nextCronOccurrence("0 0 * * *", "UTC", new Date(), {
        maxSearchMinutes: Number.MAX_SAFE_INTEGER,
      }),
    CronExpressionError,
  );
});

test("retry backoff is bounded and counts the initial attempt", () => {
  const policy = parseRetryPolicy({
    maxAttempts: 4,
    initialDelayMs: 1_000,
    multiplier: 3,
    maxDelayMs: 5_000,
  });
  assert.equal(retryDelayMs(policy, 1), 1_000);
  assert.equal(retryDelayMs(policy, 2), 3_000);
  assert.equal(retryDelayMs(policy, 3), 5_000);
  assert.equal(retryDelayMs(policy, 4), null);
  assert.throws(() =>
    parseRetryPolicy({
      maxAttempts: 100,
      initialDelayMs: 1,
      maxDelayMs: 1,
    }),
  );
  assert.throws(() =>
    parseRetryPolicy({
      maxAttempts: 2,
      initialDelayMs: 1,
      maxDelayMs: 2,
      multipler: 2,
    }),
  );
});
