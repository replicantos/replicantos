import assert from "node:assert/strict";
import test from "node:test";

import { HarnessRegistry } from "@replicantos/harnesses";

import { RunCoordinator } from "../dist/index.js";

const occurredAt = "2026-01-01T12:00:00.000Z";
const clock = () => new Date(occurredAt);
const inertTimers = {
  every() {
    return { cancel() {} };
  },
};

class ManualTimers {
  entries = [];

  every(_intervalMs, callback) {
    const entry = { callback, canceled: false };
    this.entries.push(entry);
    return {
      cancel() {
        entry.canceled = true;
      },
    };
  }

  async fire() {
    await Promise.all(
      this.entries
        .filter((entry) => !entry.canceled)
        .map((entry) => entry.callback()),
    );
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function manifest() {
  return {
    id: "codex",
    displayName: "Synthetic Codex",
    description: "Deterministic synthetic harness used by runtime tests.",
    maturity: "stable",
    transport: "app-server-stdio",
    credentials: { mode: "host-native", storedByReplicantOS: false },
    capabilities: {
      approvals: true,
      cancellation: true,
      fileChanges: true,
      images: false,
      modelSelection: true,
      reasoningSummaries: true,
      sessionResume: true,
      streamingText: true,
      toolEvents: true,
      usage: true,
    },
  };
}

class SyntheticAdapter {
  manifest = manifest();
  mode;
  invocations = 0;
  startCalls = [];
  resumeCalls = [];
  cancelCalls = [];
  approvalCalls = [];
  states = new Map();
  active = 0;
  maxActive = 0;

  constructor(mode) {
    this.mode = mode;
  }

  async doctor() {
    return {
      harnessId: "codex",
      status: "ready",
      checkedAt: occurredAt,
      checks: [],
    };
  }

  start(input, sink) {
    this.startCalls.push(input);
    return this.#begin(input, sink, false);
  }

  resume(input, sink) {
    this.resumeCalls.push(input);
    return this.#begin(input, sink, true);
  }

  async #begin(input, sink, resumed) {
    this.invocations += 1;
    if (this.mode === "throw") {
      throw new Error("synthetic private provider failure detail");
    }
    const completion = deferred();
    const state = { input, sink, completion, sequence: 0, resumed };
    this.states.set(input.runId, state);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await this.#emit(state, { type: "run.state", state: "starting" });
    await this.#emit(state, {
      type: "session.bound",
      sessionId: resumed ? input.sessionId : `session_${input.runId}`,
    });
    await this.#emit(state, { type: "run.state", state: "running" });

    if (this.mode === "fail-once" && this.invocations === 1) {
      await this.#emit(state, {
        type: "run.failed",
        code: "synthetic_transient",
        message: "The synthetic provider is temporarily unavailable.",
        retryable: true,
      });
      this.#resolve(state, {
        runId: input.runId,
        status: "failed",
        errorCode: "synthetic_transient",
      });
    } else if (this.mode === "approval" || this.mode === "approval-throw") {
      await this.#emit(state, {
        type: "approval.requested",
        approvalId: `approval_${input.runId}`,
        kind: "tool",
        title: "Approve synthetic write",
        detail: "Write the synthetic report.",
        risk: "medium",
      });
    } else if (this.mode !== "pending") {
      await this.#succeed(state);
    }
    return { runId: input.runId, completion: completion.promise };
  }

  async cancel(runId) {
    this.cancelCalls.push(runId);
    const state = this.states.get(runId);
    if (!state) throw new Error("synthetic run is not active");
    await this.#emit(state, { type: "run.cancellation.requested" });
    await this.#emit(state, { type: "run.completed", status: "canceled" });
    this.#resolve(state, { runId, status: "canceled" });
  }

  async respondToApproval(approvalId, decision) {
    this.approvalCalls.push({ approvalId, decision });
    if (this.mode === "approval-throw") {
      throw new Error("synthetic ambiguous approval transport failure");
    }
    const runId = approvalId.replace(/^approval_/, "");
    const state = this.states.get(runId);
    if (!state) throw new Error("synthetic approval is not active");
    await this.#emit(state, { type: "run.state", state: "running" });
    await this.#succeed(state);
  }

  async #succeed(state) {
    await this.#emit(state, {
      type: "assistant.text.delta",
      text: "Synthetic answer.",
    });
    await this.#emit(state, {
      type: "usage.updated",
      inputTokens: 8,
      outputTokens: 5,
      cachedInputTokens: 2,
      costUsd: 0.000123,
    });
    await this.#emit(state, {
      type: "run.completed",
      status: "succeeded",
      sessionId: state.resumed
        ? state.input.sessionId
        : `session_${state.input.runId}`,
    });
    this.#resolve(state, {
      runId: state.input.runId,
      status: "succeeded",
      sessionId: state.resumed
        ? state.input.sessionId
        : `session_${state.input.runId}`,
    });
  }

  #resolve(state, result) {
    if (!this.states.has(state.input.runId)) return;
    this.states.delete(state.input.runId);
    this.active -= 1;
    state.completion.resolve(result);
  }

  async #emit(state, draft) {
    await state.sink({
      version: 1,
      runId: state.input.runId,
      sequence: state.sequence++,
      occurredAt,
      ...draft,
    });
  }
}

function runClaim(runId, overrides = {}) {
  return {
    leaseToken: `lease_${runId}_1`,
    executionId: `execution_${runId}_1`,
    runId,
    harnessId: "codex",
    mode: "start",
    attempt: 1,
    nextEventSequence: 0,
    retryPolicy: {
      maxAttempts: 1,
      initialDelayMs: 0,
      multiplier: 1,
      maxDelayMs: 0,
    },
    input: {
      prompt: "Run the synthetic task.",
      cwd: "/synthetic/workspace",
      approvalMode: "ask",
    },
    ...overrides,
  };
}

class SyntheticRunRepository {
  queue;
  claimCalls = 0;
  activeByLease = new Map();
  events = [];
  eventKeys = new Set();
  finishes = [];
  released = [];
  statuses = new Map();
  assistant = new Map();
  usage = new Map();
  sessions = new Map();
  approvals = new Map();
  cancelRequested = new Set();
  denyRenewals = false;
  failNextEventWrite = false;

  constructor(claims) {
    this.queue = [...claims];
  }

  async claimRunnableRuns(input) {
    this.claimCalls += 1;
    const claims = this.queue.splice(0, input.limit);
    for (const claim of claims) this.activeByLease.set(claim.leaseToken, claim);
    return claims;
  }

  async markRunStarting(input) {
    if (!this.activeByLease.has(input.leaseToken)) return false;
    this.statuses.set(input.runId, "starting");
    return true;
  }

  async renewRunLease(input) {
    const claim = this.activeByLease.get(input.leaseToken);
    if (claim && this.denyRenewals) {
      this.activeByLease.delete(input.leaseToken);
      return { renewed: false, cancelRequested: false };
    }
    return {
      renewed: Boolean(claim),
      cancelRequested: claim ? this.cancelRequested.has(claim.runId) : false,
    };
  }

  async recordRunEvent(input) {
    if (this.failNextEventWrite) {
      this.failNextEventWrite = false;
      throw new Error("synthetic persistence interruption");
    }
    if (!this.activeByLease.has(input.leaseToken)) return "stale";
    if (this.eventKeys.has(input.idempotencyKey)) return "duplicate";
    this.eventKeys.add(input.idempotencyKey);
    this.events.push(input);
    const projection = input.projection;
    if (projection.status) {
      this.statuses.set(input.event.runId, projection.status);
    }
    if (projection.assistantTextDelta) {
      this.assistant.set(
        input.event.runId,
        `${this.assistant.get(input.event.runId) ?? ""}${projection.assistantTextDelta}`,
      );
    }
    if (projection.usage) this.usage.set(input.event.runId, projection.usage);
    if (projection.harnessSessionId) {
      this.sessions.set(input.event.runId, projection.harnessSessionId);
    }
    if (projection.approvalRequest) {
      this.approvals.set(
        projection.approvalRequest.approvalId,
        projection.approvalRequest,
      );
    }
    return "recorded";
  }

  async finishRunExecution(input) {
    const claim = this.activeByLease.get(input.leaseToken);
    if (!claim) return "stale";
    this.activeByLease.delete(input.leaseToken);
    this.finishes.push(input);
    if (input.retry) {
      this.statuses.set(input.runId, "queued");
      this.queue.push({
        ...claim,
        leaseToken: `lease_${input.runId}_${input.retry.nextAttempt}`,
        executionId: `execution_${input.runId}_${input.retry.nextAttempt}`,
        attempt: input.retry.nextAttempt,
        nextEventSequence:
          Math.max(
            -1,
            ...this.events
              .filter((entry) => entry.event.runId === input.runId)
              .map((entry) => entry.event.sequence),
          ) + 1,
      });
      return "retry-scheduled";
    }
    this.statuses.set(input.runId, input.outcome);
    return "finished";
  }

  async releaseRunLease(input) {
    this.activeByLease.delete(input.leaseToken);
    this.released.push(input);
  }

  async requestRunCancellation(input) {
    if (this.statuses.get(input.runId) === "succeeded") {
      return { status: "terminal" };
    }
    this.cancelRequested.add(input.runId);
    return { status: "requested" };
  }
}

class SyntheticApprovalRepository {
  dispatches = new Map();
  completed = [];
  released = [];

  async claimDecisionDispatch(input) {
    if (this.completed.some((entry) => entry.approvalId === input.approvalId)) {
      return { status: "already-dispatched" };
    }
    const claim = {
      dispatchToken: `dispatch_${input.approvalId}`,
      runId: input.runId,
      approvalId: input.approvalId,
      decision: input.decision,
    };
    this.dispatches.set(claim.dispatchToken, claim);
    return { status: "dispatch", claim };
  }

  async completeDecisionDispatch(input) {
    const claim = this.dispatches.get(input.dispatchToken);
    if (!claim) return "stale";
    this.dispatches.delete(input.dispatchToken);
    this.completed.push(claim);
    return "completed";
  }

  async releaseDecisionDispatch(input) {
    this.dispatches.delete(input.dispatchToken);
    this.released.push(input);
  }
}

function runtime(adapter, runs, approvals, options = {}) {
  const resolvedCwds = [];
  const coordinator = new RunCoordinator({
    harnesses: new HarnessRegistry([adapter]),
    cwdResolver: {
      async resolve(cwd) {
        resolvedCwds.push(cwd);
        return `/approved${cwd}`;
      },
    },
    runs,
    approvals,
    leaseOwner: "runtime_worker",
    clock,
    timers: inertTimers,
    leaseDurationMs: 5_000,
    heartbeatIntervalMs: 1_000,
    maxConcurrentRuns: options.maxConcurrentRuns ?? 2,
    ...options,
  });
  return { coordinator, resolvedCwds };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for synthetic runtime state.");
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("normalized events atomically project state, usage, session, and assistant result", async () => {
  const adapter = new SyntheticAdapter("success");
  const runs = new SyntheticRunRepository([runClaim("run_success")]);
  const approvals = new SyntheticApprovalRepository();
  const { coordinator, resolvedCwds } = runtime(adapter, runs, approvals);
  assert.deepEqual(await coordinator.poll(), {
    claimed: 1,
    started: 1,
    released: 0,
  });
  await coordinator.waitForIdle();
  assert.equal(runs.statuses.get("run_success"), "succeeded");
  assert.equal(runs.assistant.get("run_success"), "Synthetic answer.");
  assert.deepEqual(runs.usage.get("run_success"), {
    inputTokens: 8,
    outputTokens: 5,
    cachedInputTokens: 2,
    costMicros: 123,
  });
  assert.equal(runs.sessions.get("run_success"), "session_run_success");
  assert.deepEqual(resolvedCwds, ["/synthetic/workspace"]);
  assert.equal(adapter.startCalls[0].cwd, "/approved/synthetic/workspace");
});

test("explicit concurrency limits hold capacity and cancellation tears down work", async () => {
  const adapter = new SyntheticAdapter("pending");
  const runs = new SyntheticRunRepository([
    runClaim("run_first"),
    runClaim("run_second"),
  ]);
  const approvals = new SyntheticApprovalRepository();
  const { coordinator } = runtime(adapter, runs, approvals, {
    maxConcurrentRuns: 1,
    perHarnessLimits: { codex: 1 },
  });
  assert.equal((await coordinator.poll()).started, 1);
  await waitFor(() => adapter.states.has("run_first"));
  assert.deepEqual(await coordinator.poll(), {
    claimed: 0,
    started: 0,
    released: 0,
  });
  assert.equal(await coordinator.cancel("run_first"), "recorded");
  await coordinator.waitForIdle();
  assert.equal(runs.statuses.get("run_first"), "canceled");
  assert.equal((await coordinator.poll()).started, 1);
  await waitFor(() => adapter.states.has("run_second"));
  await coordinator.cancel("run_second");
  await coordinator.waitForIdle();
  assert.equal(adapter.maxActive, 1);
  assert.deepEqual(adapter.cancelCalls, ["run_first", "run_second"]);
});

test("overlapping polls share one local capacity calculation", async () => {
  const adapter = new SyntheticAdapter("pending");
  const runs = new SyntheticRunRepository([
    runClaim("run_overlap_first"),
    runClaim("run_overlap_second"),
  ]);
  const approvals = new SyntheticApprovalRepository();
  const { coordinator } = runtime(adapter, runs, approvals, {
    maxConcurrentRuns: 1,
  });
  const [first, second] = await Promise.all([
    coordinator.poll(),
    coordinator.poll(),
  ]);
  assert.deepEqual(second, first);
  assert.equal(runs.claimCalls, 1);
  assert.equal(coordinator.activeCount, 1);
  await coordinator.cancel("run_overlap_first");
  await coordinator.waitForIdle();
});

test("heartbeat fencing loss cancels provider work without stale finalization", async () => {
  const adapter = new SyntheticAdapter("pending");
  const runs = new SyntheticRunRepository([runClaim("run_fenced")]);
  const approvals = new SyntheticApprovalRepository();
  const timers = new ManualTimers();
  const { coordinator } = runtime(adapter, runs, approvals, { timers });
  await coordinator.poll();
  await waitFor(() => adapter.states.has("run_fenced"));
  runs.denyRenewals = true;
  await timers.fire();
  await coordinator.waitForIdle();
  assert.deepEqual(adapter.cancelCalls, ["run_fenced"]);
  assert.equal(runs.finishes.length, 0);
  assert.equal(coordinator.activeCount, 0);
});

test("uncertain event persistence fences and cancels instead of forging a provider failure", async () => {
  const adapter = new SyntheticAdapter("pending");
  const runs = new SyntheticRunRepository([runClaim("run_persistence")]);
  runs.failNextEventWrite = true;
  const approvals = new SyntheticApprovalRepository();
  const errors = [];
  const { coordinator } = runtime(adapter, runs, approvals, {
    onCoordinatorError(error, runId) {
      errors.push({ error, runId });
    },
  });
  await coordinator.poll();
  await coordinator.waitForIdle();
  assert.deepEqual(adapter.cancelCalls, ["run_persistence"]);
  assert.equal(runs.finishes.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].runId, "run_persistence");
});

test("approval requests pause persistently and resume only after dispatched decisions", async () => {
  const adapter = new SyntheticAdapter("approval");
  const runs = new SyntheticRunRepository([runClaim("run_approval")]);
  const approvals = new SyntheticApprovalRepository();
  const { coordinator } = runtime(adapter, runs, approvals);
  await coordinator.poll();
  await waitFor(
    () => runs.statuses.get("run_approval") === "awaiting-approval",
  );
  assert.equal(
    await coordinator.respondToApproval(
      "run_approval",
      "approval_run_approval",
      { outcome: "allow", remember: false },
    ),
    "dispatched",
  );
  await coordinator.waitForIdle();
  assert.equal(runs.statuses.get("run_approval"), "succeeded");
  assert.equal(approvals.completed.length, 1);
  assert.deepEqual(adapter.approvalCalls[0], {
    approvalId: "approval_run_approval",
    decision: { outcome: "allow", remember: false },
  });
});

test("ambiguous approval adapter failures remain fail-closed", async () => {
  const adapter = new SyntheticAdapter("approval-throw");
  const runs = new SyntheticRunRepository([runClaim("run_approval_ambiguous")]);
  const approvals = new SyntheticApprovalRepository();
  const { coordinator } = runtime(adapter, runs, approvals);
  await coordinator.poll();
  await waitFor(
    () => runs.statuses.get("run_approval_ambiguous") === "awaiting-approval",
  );
  await assert.rejects(() =>
    coordinator.respondToApproval(
      "run_approval_ambiguous",
      "approval_run_approval_ambiguous",
      { outcome: "allow", remember: false },
    ),
  );
  assert.equal(approvals.released.length, 0);
  assert.equal(approvals.dispatches.size, 1);
  await coordinator.cancel("run_approval_ambiguous");
  await coordinator.waitForIdle();
});

test("retryable adapter failures schedule bounded backoff and later succeed", async () => {
  const adapter = new SyntheticAdapter("fail-once");
  const runs = new SyntheticRunRepository([
    runClaim("run_retry", {
      retryPolicy: {
        maxAttempts: 2,
        initialDelayMs: 2_000,
        multiplier: 2,
        maxDelayMs: 10_000,
      },
    }),
  ]);
  const approvals = new SyntheticApprovalRepository();
  const { coordinator } = runtime(adapter, runs, approvals);
  await coordinator.poll();
  await coordinator.waitForIdle();
  assert.equal(runs.statuses.get("run_retry"), "queued");
  assert.deepEqual(runs.finishes[0].retry, {
    nextAttempt: 2,
    notBefore: "2026-01-01T12:00:02.000Z",
  });
  await coordinator.poll();
  await coordinator.waitForIdle();
  assert.equal(runs.statuses.get("run_retry"), "succeeded");
  assert.equal(adapter.invocations, 2);
  assert.equal(runs.finishes.length, 2);
});

test("restart recovery uses persisted session resume and rebases event sequences", async () => {
  const adapter = new SyntheticAdapter("success");
  const runs = new SyntheticRunRepository([
    runClaim("run_resume", {
      mode: "resume",
      sessionId: "session_before_restart",
      nextEventSequence: 7,
    }),
  ]);
  const approvals = new SyntheticApprovalRepository();
  const { coordinator } = runtime(adapter, runs, approvals);
  await coordinator.poll();
  await coordinator.waitForIdle();
  assert.equal(adapter.resumeCalls.length, 1);
  assert.equal(adapter.resumeCalls[0].sessionId, "session_before_restart");
  assert.equal(runs.events[0].event.sequence, 7);
  assert.equal(runs.statuses.get("run_resume"), "succeeded");
});

test("adapter startup failures become safe terminal failures without raw details", async () => {
  const adapter = new SyntheticAdapter("throw");
  const runs = new SyntheticRunRepository([runClaim("run_failure")]);
  const approvals = new SyntheticApprovalRepository();
  const errors = [];
  const { coordinator } = runtime(adapter, runs, approvals, {
    onCoordinatorError: (error) => errors.push(error),
  });
  await coordinator.poll();
  await coordinator.waitForIdle();
  assert.equal(runs.statuses.get("run_failure"), "failed");
  assert.equal(runs.finishes[0].errorCode, "harness_execution_failed");
  assert.equal(runs.finishes[0].errorMessage, "The harness execution failed.");
  assert.equal(
    JSON.stringify(runs.finishes).includes("private provider"),
    false,
  );
  assert.deepEqual(errors, []);
});
