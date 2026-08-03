import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  EnqueueRuntimeRunInput,
  RuntimeRunProjectionRecord,
  SqliteRuntimeRepositories,
} from "@replicantos/db";
import {
  CwdPolicyError,
  HarnessRegistry,
  type ApprovedCwdResolver,
} from "@replicantos/harnesses";
import type {
  RunCoordinatorOptions,
  ScheduleCoordinatorOptions,
} from "@replicantos/runtime";
import { describe, expect, it, vi } from "vitest";

import {
  createRuntimeService,
  type RuntimeLoopTimer,
  type RuntimeRunCoordinator,
  type RuntimeScheduleCoordinator,
  type RuntimeServiceLogContext,
  type RuntimeShutdownWaiter,
  type RuntimeTimerHandle,
} from "./runtime-service.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

class ManualLoopTimer implements RuntimeLoopTimer {
  readonly #entries: Array<{
    active: boolean;
    callback: () => void;
    delayMs: number;
  }> = [];

  schedule(delayMs: number, callback: () => void): RuntimeTimerHandle {
    const entry = { active: true, callback, delayMs };
    this.#entries.push(entry);
    return {
      cancel() {
        entry.active = false;
      },
    };
  }

  get activeCount(): number {
    return this.#entries.filter((entry) => entry.active).length;
  }

  activeDelays(): number[] {
    return this.#entries
      .filter((entry) => entry.active)
      .map((entry) => entry.delayMs)
      .sort((left, right) => left - right);
  }

  fire(delayMs: number): boolean {
    const entry = this.#entries.find(
      (candidate) => candidate.active && candidate.delayMs === delayMs,
    );
    if (entry === undefined) return false;
    entry.active = false;
    entry.callback();
    return true;
  }
}

class DrainingShutdownWaiter implements RuntimeShutdownWaiter {
  readonly calls: number[] = [];

  async wait(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
    this.calls.push(timeoutMs);
    await operation;
    return true;
  }
}

function fakeRepositories(options?: {
  projection?: RuntimeRunProjectionRecord;
}): {
  enqueued: EnqueueRuntimeRunInput[];
  repositories: SqliteRuntimeRepositories;
} {
  const enqueued: EnqueueRuntimeRunInput[] = [];
  const runs = {
    enqueue(input: EnqueueRuntimeRunInput) {
      enqueued.push(input);
    },
    getProjection(runId: string) {
      return options?.projection?.runId === runId ? options.projection : null;
    },
  };
  return {
    enqueued,
    repositories: {
      approvals: {},
      runs,
      schedules: {},
    } as unknown as SqliteRuntimeRepositories,
  };
}

function fakeScheduleCoordinator(
  tick: RuntimeScheduleCoordinator["tick"] = async () => undefined,
): RuntimeScheduleCoordinator {
  return { tick: vi.fn(tick) };
}

function fakeRunCoordinator(
  overrides: Partial<RuntimeRunCoordinator> = {},
): RuntimeRunCoordinator {
  return {
    activeCount: 0,
    cancel: vi.fn(async () => "recorded" as const),
    poll: vi.fn(async () => undefined),
    respondToApproval: vi.fn(async () => "dispatched" as const),
    waitForIdle: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fixture(
  options: {
    runCoordinator?: RuntimeRunCoordinator;
    scheduleCoordinator?: RuntimeScheduleCoordinator;
    shutdownWaiter?: RuntimeShutdownWaiter;
    workerId?: string;
  } = {},
) {
  const repositoryFixture = fakeRepositories();
  const loopTimer = new ManualLoopTimer();
  const shutdownWaiter = options.shutdownWaiter ?? new DrainingShutdownWaiter();
  const scheduleCoordinator =
    options.scheduleCoordinator ?? fakeScheduleCoordinator();
  const runCoordinator = options.runCoordinator ?? fakeRunCoordinator();
  const service = createRuntimeService({
    workspaceRoot: path.join(tmpdir(), "replicantos-runtime-test-workspace"),
    repositories: repositoryFixture.repositories,
    harnesses: new HarnessRegistry(),
    factories: {
      createRunCoordinator: () => runCoordinator,
      createScheduleCoordinator: () => scheduleCoordinator,
    },
    loopTimer,
    shutdownWaiter,
    schedulePollIntervalMs: 100,
    runPollIntervalMs: 50,
    ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
  });
  return {
    ...repositoryFixture,
    loopTimer,
    runCoordinator,
    scheduleCoordinator,
    service,
    shutdownWaiter,
  };
}

describe("runtime service composition", () => {
  it("polls immediately and never overlaps a schedule poll", async () => {
    const firstTick = deferred();
    const secondTick = deferred();
    let calls = 0;
    let concurrent = 0;
    let maximumConcurrent = 0;
    const scheduleCoordinator = fakeScheduleCoordinator(async () => {
      calls += 1;
      const invocation = calls;
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      try {
        if (invocation === 1) await firstTick.promise;
        if (invocation === 2) await secondTick.promise;
      } finally {
        concurrent -= 1;
      }
    });
    const runtime = fixture({ scheduleCoordinator });

    const starting = runtime.service.start();
    const duplicateStart = runtime.service.start();
    await flushMicrotasks();

    expect(scheduleCoordinator.tick).toHaveBeenCalledTimes(1);
    expect(runtime.runCoordinator.poll).toHaveBeenCalledTimes(1);
    expect(runtime.loopTimer.activeDelays()).toEqual([50]);

    firstTick.resolve();
    await Promise.all([starting, duplicateStart]);
    expect(runtime.loopTimer.activeDelays()).toEqual([50, 100]);

    expect(runtime.loopTimer.fire(100)).toBe(true);
    await flushMicrotasks();
    expect(scheduleCoordinator.tick).toHaveBeenCalledTimes(2);
    expect(runtime.loopTimer.fire(100)).toBe(false);
    expect(maximumConcurrent).toBe(1);

    secondTick.resolve();
    await flushMicrotasks();
    expect(runtime.loopTimer.activeDelays()).toEqual([50, 100]);

    await runtime.service.stop();
    expect(runtime.loopTimer.activeCount).toBe(0);
  });

  it("starts, delegates its public facade, and stops idempotently", async () => {
    const projection: RuntimeRunProjectionRecord = {
      assistantText: "Synthetic result",
      cachedInputTokens: 3,
      cancellationRequestedAt: null,
      costMicros: 15,
      harnessSessionId: "session-synthetic",
      inputTokens: 10,
      outputTokens: 20,
      runId: "run-synthetic",
      status: "succeeded",
    };
    const repositoryFixture = fakeRepositories({ projection });
    const loopTimer = new ManualLoopTimer();
    const shutdownWaiter = new DrainingShutdownWaiter();
    const cancel = vi.fn(async () => "terminal" as const);
    const respondToApproval = vi.fn(async () => "dispatched" as const);
    const waitForIdle = vi.fn(async () => undefined);
    const runCoordinator = fakeRunCoordinator({
      cancel,
      respondToApproval,
      waitForIdle,
    });
    const service = createRuntimeService({
      workspaceRoot: path.join(tmpdir(), "replicantos-runtime-test-workspace"),
      repositories: repositoryFixture.repositories,
      harnesses: new HarnessRegistry(),
      factories: {
        createRunCoordinator: () => runCoordinator,
        createScheduleCoordinator: () => fakeScheduleCoordinator(),
      },
      loopTimer,
      shutdownWaiter,
      shutdownTimeoutMs: 400,
    });
    const enqueueInput = {
      execution: {
        cwd: path.join(tmpdir(), "synthetic-workspace"),
        prompt: "Perform a synthetic task",
        retryPolicy: { maxAttempts: 1 },
      },
      run: { id: "run-synthetic" },
    } as unknown as EnqueueRuntimeRunInput;

    await service.start();
    expect(service.started).toBe(true);
    expect(loopTimer.activeCount).toBe(2);

    service.enqueue(enqueueInput);
    expect(repositoryFixture.enqueued).toEqual([enqueueInput]);
    expect(service.getProjection("run-synthetic")).toEqual(projection);
    expect(service.getProjection("run-missing")).toBeNull();
    await expect(service.cancel("run-synthetic")).resolves.toBe("terminal");
    await expect(
      service.respondToApproval("run-synthetic", "approval-synthetic", {
        outcome: "allow",
      }),
    ).resolves.toBe("dispatched");
    expect(cancel).toHaveBeenCalledWith("run-synthetic");
    expect(respondToApproval).toHaveBeenCalledWith(
      "run-synthetic",
      "approval-synthetic",
      { outcome: "allow" },
    );
    await expect(service.doctors()).resolves.toEqual([]);
    expect(service.manifests()).toEqual([]);

    const stopped = await service.stop();
    const stoppedAgain = await service.stop();
    expect(stopped).toEqual({ activeRuns: 0, drained: true });
    expect(stoppedAgain).toEqual(stopped);
    expect(service.started).toBe(false);
    expect(waitForIdle).toHaveBeenCalledTimes(1);
    expect(shutdownWaiter.calls).toEqual([400]);
    expect(loopTimer.activeCount).toBe(0);
    await expect(service.start()).rejects.toThrow(
      "A stopped runtime service cannot be restarted",
    );
  });

  it("uses one approved cwd policy and gives it to every runtime consumer", async () => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "replicantos-runtime-policy-test-"),
    );
    const temporaryOutside = await mkdtemp(
      path.join(tmpdir(), "replicantos-runtime-outside-test-"),
    );
    try {
      const root = await realpath(temporaryRoot);
      const outside = await realpath(temporaryOutside);
      const inside = path.join(root, "replicant-synthetic");
      await mkdir(inside);
      const repositoryFixture = fakeRepositories();
      let harnessResolver: ApprovedCwdResolver | undefined;
      let coordinatorResolver: ApprovedCwdResolver | undefined;
      const service = createRuntimeService({
        workspaceRoot: root,
        repositories: repositoryFixture.repositories,
        factories: {
          createHarnesses(resolver) {
            harnessResolver = resolver;
            return new HarnessRegistry();
          },
          createRunCoordinator(options: RunCoordinatorOptions) {
            coordinatorResolver = options.cwdResolver;
            return fakeRunCoordinator();
          },
          createScheduleCoordinator(_options: ScheduleCoordinatorOptions) {
            return fakeScheduleCoordinator();
          },
        },
        loopTimer: new ManualLoopTimer(),
        shutdownWaiter: new DrainingShutdownWaiter(),
      });

      expect(harnessResolver).toBeDefined();
      expect(coordinatorResolver).toBe(harnessResolver);
      await expect(harnessResolver!.resolve(inside)).resolves.toBe(inside);
      await expect(harnessResolver!.resolve(outside)).rejects.toBeInstanceOf(
        CwdPolicyError,
      );
      await service.stop();

      const resolverCalls: string[] = [];
      const stopBeforeProbe = new CwdPolicyError("synthetic policy stop");
      const probeResolver: ApprovedCwdResolver = {
        async resolve(cwd) {
          resolverCalls.push(cwd);
          throw stopBeforeProbe;
        },
      };
      let defaultCoordinatorResolver: ApprovedCwdResolver | undefined;
      const defaultHarnessService = createRuntimeService({
        workspaceRoot: root,
        repositories: repositoryFixture.repositories,
        cwdResolver: probeResolver,
        factories: {
          createRunCoordinator(options) {
            defaultCoordinatorResolver = options.cwdResolver;
            return fakeRunCoordinator();
          },
          createScheduleCoordinator: () => fakeScheduleCoordinator(),
        },
        loopTimer: new ManualLoopTimer(),
        shutdownWaiter: new DrainingShutdownWaiter(),
      });

      expect(
        defaultHarnessService
          .manifests()
          .map((manifest) => manifest.id)
          .sort(),
      ).toEqual(["claude", "codex", "grok", "opencode"]);
      expect(defaultCoordinatorResolver).toBe(probeResolver);
      await expect(defaultHarnessService.doctors({ cwd: inside })).rejects.toBe(
        stopBeforeProbe,
      );
      expect(resolverCalls).toEqual([inside, inside, inside, inside]);
      await defaultHarnessService.stop();
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
      await rm(temporaryOutside, { force: true, recursive: true });
    }
  });

  it("logs coordinator failures without provider error details", async () => {
    const scheduleSecret = "schedule-secret-provider-payload";
    const runSecret = "run-secret-provider-payload";
    const callbackSecret = "callback-secret-provider-payload";
    const logs: Array<{
      context: RuntimeServiceLogContext;
      level: string;
      message: string;
    }> = [];
    let coordinatorError:
      | NonNullable<RunCoordinatorOptions["onCoordinatorError"]>
      | undefined;
    const repositoryFixture = fakeRepositories();
    const loopTimer = new ManualLoopTimer();
    const service = createRuntimeService({
      workspaceRoot: path.join(tmpdir(), "replicantos-runtime-test-workspace"),
      repositories: repositoryFixture.repositories,
      harnesses: new HarnessRegistry(),
      factories: {
        createRunCoordinator(options) {
          coordinatorError = options.onCoordinatorError;
          return fakeRunCoordinator({
            poll: vi.fn(async () => {
              throw new Error(runSecret);
            }),
          });
        },
        createScheduleCoordinator: () =>
          fakeScheduleCoordinator(async () => {
            throw new Error(scheduleSecret);
          }),
      },
      logger: {
        error(context, message) {
          logs.push({ context, level: "error", message });
        },
        info(context, message) {
          logs.push({ context, level: "info", message });
        },
        warn(context, message) {
          logs.push({ context, level: "warn", message });
        },
      },
      loopTimer,
      shutdownWaiter: new DrainingShutdownWaiter(),
    });

    await service.start();
    expect(coordinatorError).toBeDefined();
    coordinatorError!(new Error(callbackSecret), `../../${callbackSecret}`);

    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(scheduleSecret);
    expect(serialized).not.toContain(runSecret);
    expect(serialized).not.toContain(callbackSecret);
    expect(logs.map((entry) => entry.context.code)).toEqual(
      expect.arrayContaining([
        "runtime_run_coordination_failed",
        "runtime_run_poll_failed",
        "runtime_schedule_poll_failed",
        "runtime_started",
      ]),
    );
    expect(
      logs.find(
        (entry) => entry.context.code === "runtime_run_coordination_failed",
      )?.context,
    ).not.toHaveProperty("runId");

    await service.stop();
    expect(loopTimer.activeCount).toBe(0);
  });

  it("uses a stable process worker identity and bounds shutdown", async () => {
    const first = fixture();
    const second = fixture();
    expect(first.service.workerId).toBe(second.service.workerId);
    expect(first.service.workerId).toMatch(/^runtime-\d+-[a-f0-9-]{36}$/);
    await Promise.all([first.service.stop(), second.service.stop()]);

    const idle = deferred();
    const loopTimer = new ManualLoopTimer();
    const runCoordinator = fakeRunCoordinator({
      activeCount: 2,
      waitForIdle: vi.fn(() => idle.promise),
    });
    const shutdownWaiter: RuntimeShutdownWaiter = {
      wait: vi.fn(async () => false),
    };
    const repositoryFixture = fakeRepositories();
    const service = createRuntimeService({
      workspaceRoot: path.join(tmpdir(), "replicantos-runtime-test-workspace"),
      repositories: repositoryFixture.repositories,
      harnesses: new HarnessRegistry(),
      factories: {
        createRunCoordinator: () => runCoordinator,
        createScheduleCoordinator: () => fakeScheduleCoordinator(),
      },
      loopTimer,
      shutdownWaiter,
      shutdownTimeoutMs: 100,
    });

    await service.start();
    await expect(service.stop()).resolves.toEqual({
      activeRuns: 2,
      drained: false,
    });
    expect(loopTimer.activeCount).toBe(0);
    idle.resolve();
    await flushMicrotasks();
  });
});
