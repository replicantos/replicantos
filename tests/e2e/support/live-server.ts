import { basename, dirname } from "node:path";

import { createApp } from "../../../apps/server/src/app.js";
import { loadServerConfig } from "../../../apps/server/src/config.js";
import {
  createProductionDependencies,
  type ServerDependencies,
} from "../../../apps/server/src/dependencies.js";
import { createRuntimeService } from "../../../apps/server/src/runtime-service.js";
import {
  CLAUDE_MANIFEST,
  CODEX_MANIFEST,
  GROK_MANIFEST,
  OPENCODE_MANIFEST,
} from "../../../packages/harnesses/dist/adapters/manifests.js";
import { HarnessRegistry } from "../../../packages/harnesses/dist/registry.js";
import {
  createHarnessEvent,
  type ApprovalDecision,
  type DoctorResult,
  type HarnessAdapter,
  type HarnessEventDraft,
  type HarnessEventSink,
  type HarnessManifest,
  type ResumeInput,
  type RunCompletion,
  type RunHandle,
  type RunInput,
} from "../../../packages/protocol/src/harness.js";

interface ActiveFakeRun {
  approvalId?: string;
  completion: Promise<RunCompletion>;
  emit(draft: HarnessEventDraft): Promise<void>;
  finish(status: "canceled" | "succeeded"): Promise<void>;
  resolve(completion: RunCompletion): void;
  runId: string;
  sessionId: string;
}

const manifests = [
  CODEX_MANIFEST,
  CLAUDE_MANIFEST,
  OPENCODE_MANIFEST,
  GROK_MANIFEST,
] as const;

function visiblePrompt(prompt: string): string {
  const triggerMarker = "User (trigger): ";
  const triggerIndex = prompt.lastIndexOf(triggerMarker);
  return (
    triggerIndex === -1
      ? prompt
      : prompt.slice(triggerIndex + triggerMarker.length)
  ).trim();
}

class DeterministicHarnessAdapter implements HarnessAdapter {
  readonly manifest: HarnessManifest;
  readonly #active = new Map<string, ActiveFakeRun>();
  readonly #approvals = new Map<string, ActiveFakeRun>();

  constructor(manifest: HarnessManifest) {
    this.manifest = manifest;
  }

  async doctor(): Promise<DoctorResult> {
    return {
      harnessId: this.manifest.id,
      status: "ready",
      checkedAt: "2026-08-02T12:00:00.000Z",
      checks: [
        {
          id: "e2e-fake-adapter",
          status: "pass",
          message: "Deterministic E2E adapter is active.",
        },
      ],
    };
  }

  start(input: RunInput, events: HarnessEventSink): Promise<RunHandle> {
    const replicantSlug = basename(dirname(input.cwd))
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]/gu, "-");
    return this.#run(
      input,
      events,
      `e2e-${this.manifest.id}-${replicantSlug}-session`,
      false,
    );
  }

  resume(input: ResumeInput, events: HarnessEventSink): Promise<RunHandle> {
    return this.#run(input, events, input.sessionId, true);
  }

  async cancel(runId: string): Promise<void> {
    const active = this.#active.get(runId);
    if (!active) return;
    await active.emit({ type: "run.cancellation.requested" });
    await active.finish("canceled");
  }

  async cancelAll(): Promise<void> {
    await Promise.all(
      [...this.#active.keys()].map((runId) => this.cancel(runId)),
    );
  }

  async respondToApproval(
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const active = this.#approvals.get(approvalId);
    if (!active) throw new Error("Synthetic approval is not active.");
    this.#approvals.delete(approvalId);
    if (decision.outcome === "deny") {
      await active.finish("canceled");
      return;
    }
    await active.emit({
      type: "assistant.text.delta",
      text: "Synthetic approval accepted.",
    });
    await active.emit({
      type: "usage.updated",
      inputTokens: 21,
      outputTokens: 8,
    });
    await active.finish("succeeded");
  }

  async #run(
    input: RunInput,
    events: HarnessEventSink,
    sessionId: string,
    resumed: boolean,
  ): Promise<RunHandle> {
    let sequence = 0;
    let resolveCompletion!: (completion: RunCompletion) => void;
    const completion = new Promise<RunCompletion>((resolve) => {
      resolveCompletion = resolve;
    });
    const emit = async (draft: HarnessEventDraft) => {
      await events(
        createHarnessEvent(
          input.runId,
          sequence,
          new Date(Date.UTC(2030, 0, 1, 0, 0, sequence)).toISOString(),
          draft,
        ),
      );
      sequence += 1;
    };
    const active: ActiveFakeRun = {
      completion,
      emit,
      runId: input.runId,
      sessionId,
      resolve: resolveCompletion,
      finish: async (status) => {
        if (!this.#active.has(input.runId)) return;
        await emit({ type: "run.completed", status, sessionId });
        this.#active.delete(input.runId);
        if (active.approvalId) this.#approvals.delete(active.approvalId);
        resolveCompletion({ runId: input.runId, status, sessionId });
      },
    };
    this.#active.set(input.runId, active);

    await emit({ type: "run.state", state: "running" });
    await emit({ type: "session.bound", sessionId });

    if (input.prompt.includes("[await-approval]")) {
      const approvalId = `approval-e2e-${input.runId}`;
      active.approvalId = approvalId;
      this.#approvals.set(approvalId, active);
      await emit({
        type: "approval.requested",
        approvalId,
        kind: "tool",
        title: "Synthetic release action",
        detail: "Allow the deterministic E2E adapter to finish this run.",
        risk: "low",
      });
      return { runId: input.runId, completion };
    }

    if (input.prompt.includes("[await-cancel]")) {
      await emit({
        type: "assistant.text.delta",
        text: "Synthetic run is waiting for cancellation.",
      });
      return { runId: input.runId, completion };
    }

    const mode = resumed ? "resumed" : "started";
    await emit({
      type: "assistant.text.delta",
      text: `Synthetic ${this.manifest.displayName} ${mode} reply: `,
    });
    await emit({
      type: "assistant.text.delta",
      text: visiblePrompt(input.prompt),
    });
    await emit({
      type: "usage.updated",
      inputTokens: 34,
      outputTokens: 13,
      cachedInputTokens: resumed ? 5 : 0,
    });
    await active.finish("succeeded");
    return { runId: input.runId, completion };
  }
}

if (
  process.env.NODE_ENV !== "test" ||
  process.env.REPLICANTOS_E2E_FAKE_HARNESSES !== "true"
) {
  throw new Error(
    "The deterministic E2E server requires NODE_ENV=test and explicit fake harnesses.",
  );
}

const config = loadServerConfig();
const productionDependencies = await createProductionDependencies(config);
if (
  productionDependencies.database === null ||
  productionDependencies.files === null
) {
  await productionDependencies.close();
  throw new Error("Production database and safe file services are required.");
}
if (productionDependencies.runtime?.started) {
  await productionDependencies.close();
  throw new Error("The host-provider runtime must remain stopped in E2E.");
}

const adapters = manifests.map(
  (manifest) => new DeterministicHarnessAdapter(manifest),
);
const harnesses = new HarnessRegistry(adapters);
const runtime = createRuntimeService({
  database: productionDependencies.database,
  harnesses,
  runPollIntervalMs: 50,
  schedulePollIntervalMs: 100,
  shutdownTimeoutMs: 5_000,
  workerId: "e2e-fake-runtime",
  workspaceRoot: productionDependencies.files.roots.workspace,
});
let dependenciesClosed = false;
const dependencies: ServerDependencies = {
  ...productionDependencies,
  runtime,
  async close() {
    if (dependenciesClosed) return;
    dependenciesClosed = true;
    await Promise.all(adapters.map((adapter) => adapter.cancelAll()));
    await runtime.stop();
    await productionDependencies.close();
  },
};

const app = await createApp(config, dependencies);
await runtime.start();

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  await app.close();
  throw error;
}
