import assert from "node:assert/strict";
import test from "node:test";

import { ScheduleCoordinator } from "../dist/index.js";

const fixedClock = () => new Date("2026-01-01T12:05:00.000Z");

function dueClaim() {
  return {
    claimToken: "claim_demo",
    scheduledFor: "2026-01-01T12:00:00.000Z",
    schedule: {
      id: "schedule_demo",
      workspaceId: "workspace_demo",
      replicantId: "replicant_demo",
      channelId: null,
      taskId: null,
      cronExpression: "0 * * * *",
      timezone: "UTC",
      harnessOverride: "codex",
      modelOverride: null,
      effortOverride: null,
      prompt: "Produce the synthetic status report.",
      retryPolicy: {
        maxAttempts: 2,
        initialDelayMs: 1_000,
        multiplier: 2,
        maxDelayMs: 5_000,
      },
    },
  };
}

class SyntheticScheduleClaims {
  claim = dueClaim();
  leased = false;
  completed = false;
  failNextCompletion = false;
  completionInputs = [];
  claimCalls = 0;

  async claimDueSchedules() {
    this.claimCalls += 1;
    if (this.completed || this.leased) return [];
    this.leased = true;
    return [this.claim];
  }

  async completeScheduleClaim(input) {
    this.completionInputs.push(input);
    if (this.failNextCompletion) {
      this.failNextCompletion = false;
      throw new Error("synthetic completion interruption");
    }
    if (!this.leased) return "stale";
    this.leased = false;
    this.completed = true;
    return "completed";
  }

  async releaseScheduleClaim() {
    this.leased = false;
  }
}

class SyntheticScheduledRuns {
  byKey = new Map();
  calls = 0;

  async ensureScheduledRun(input) {
    this.calls += 1;
    const existing = this.byKey.get(input.idempotencyKey);
    if (existing) return { runId: existing, created: false };
    const runId = `run_${this.byKey.size + 1}`;
    this.byKey.set(input.idempotencyKey, runId);
    return { runId, created: true };
  }
}

function coordinator(claims, runs, leaseOwner) {
  return new ScheduleCoordinator({
    claims,
    runs,
    leaseOwner,
    clock: fixedClock,
    maxClaimsPerTick: 4,
    maxConcurrentClaims: 2,
  });
}

test("atomic due claims deduplicate concurrent scheduler ticks", async () => {
  const claims = new SyntheticScheduleClaims();
  const runs = new SyntheticScheduledRuns();
  const first = coordinator(claims, runs, "scheduler_a");
  const second = coordinator(claims, runs, "scheduler_b");
  const results = await Promise.all([first.tick(), second.tick()]);
  assert.equal(
    results.reduce((sum, value) => sum + value.claimed, 0),
    1,
  );
  assert.equal(
    results.reduce((sum, value) => sum + value.createdRuns, 0),
    1,
  );
  assert.equal(runs.byKey.size, 1);
  assert.equal(claims.completed, true);
  assert.equal(
    claims.completionInputs[0].nextRunAt,
    "2026-01-01T13:00:00.000Z",
  );
});

test("overlapping ticks share one bounded local claim pass", async () => {
  const claims = new SyntheticScheduleClaims();
  const runs = new SyntheticScheduledRuns();
  const scheduler = coordinator(claims, runs, "scheduler_singleton");
  const [first, second] = await Promise.all([
    scheduler.tick(),
    scheduler.tick(),
  ]);
  assert.deepEqual(second, first);
  assert.equal(claims.claimCalls, 1);
  assert.equal(runs.byKey.size, 1);
});

test("restart after run creation reclaims the occurrence without duplicating", async () => {
  const claims = new SyntheticScheduleClaims();
  const runs = new SyntheticScheduledRuns();
  claims.failNextCompletion = true;
  const interrupted = await coordinator(
    claims,
    runs,
    "scheduler_before_restart",
  ).tick();
  assert.equal(interrupted.createdRuns, 1);
  assert.equal(interrupted.releasedClaims, 1);
  assert.equal(interrupted.errors.length, 1);

  const recovered = await coordinator(
    claims,
    runs,
    "scheduler_after_restart",
  ).tick();
  assert.equal(recovered.existingRuns, 1);
  assert.equal(recovered.completedClaims, 1);
  assert.equal(runs.byKey.size, 1);
  assert.equal(runs.calls, 2);
});
