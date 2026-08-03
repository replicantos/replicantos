import {
  publicErrorMessage,
  type ApprovalDecision,
  type DoctorContext,
  type DoctorResult,
  type HarnessAdapter,
  type HarnessEventSink,
  type HarnessManifest,
  type ResumeInput,
  type RunCompletion,
  type RunHandle,
  type RunInput,
} from "@replicantos/protocol/harness";
import type { JsonObject, JsonValue } from "@replicantos/protocol";

import { deferred, type Deferred } from "../runtime/deferred.js";
import {
  rejectUnconfiguredCwdResolver,
  type ApprovedCwdResolver,
} from "../runtime/cwd.js";
import { executableDoctor } from "../runtime/doctor.js";
import {
  buildChildEnvironment,
  createSecretRedactor,
  type ChildEnvironment,
} from "../runtime/environment.js";
import { NormalizedEventWriter, type Clock } from "../runtime/events.js";
import {
  createProcessJsonRpcPeer,
  type JsonRpcPeer,
  type JsonRpcPeerFactory,
  type JsonRpcRequest,
} from "../runtime/json-rpc.js";
import { array, compactPublicText, record, string } from "../runtime/json.js";
import { toWorkspacePath } from "../runtime/path.js";
import {
  probeExecutable,
  type ProbeExecutable,
} from "../runtime/process-doctor.js";
import { ActiveRunRegistry } from "../runtime/run-registry.js";
import { errorCode, validateRunInput } from "../runtime/validation.js";
import { parseAcpSessionUpdate } from "./acp-parser.js";

export interface AcpAdapterOptions {
  command: string;
  args: readonly string[];
  manifest: HarnessManifest;
  preferredAuthMethods?: readonly string[];
  providerEnvironmentKeys?: readonly string[];
  versionArgs?: readonly string[];
  clock?: Clock;
  cwdResolver?: ApprovedCwdResolver;
  environment?: NodeJS.ProcessEnv;
  additionalEnvKeys?: readonly string[];
  peerFactory?: JsonRpcPeerFactory;
  probe?: ProbeExecutable;
  requestTimeoutMs?: number;
  cancellationGraceMs?: number;
}

interface PendingAcpApproval {
  state: AcpRunState;
  request: JsonRpcRequest;
  response: Deferred<JsonValue>;
}

interface AcpRunState {
  input: RunInput;
  writer: NormalizedEventWriter;
  completion: Deferred<RunCompletion>;
  peer?: JsonRpcPeer;
  sessionId?: string;
  cancelRequested: boolean;
  cancellationTimer?: NodeJS.Timeout;
  terminal: boolean;
}

export class AcpAdapter implements HarnessAdapter {
  readonly manifest: HarnessManifest;
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #preferredAuthMethods: readonly string[];
  readonly #versionArgs: readonly string[];
  readonly #clock: Clock;
  readonly #cwdResolver: ApprovedCwdResolver;
  readonly #childEnvironment: ChildEnvironment;
  readonly #peerFactory: JsonRpcPeerFactory;
  readonly #probe: ProbeExecutable;
  readonly #requestTimeoutMs: number;
  readonly #cancellationGraceMs: number;
  readonly #runs: ActiveRunRegistry<AcpRunState>;
  readonly #approvals = new Map<string, PendingAcpApproval>();

  constructor(options: AcpAdapterOptions) {
    this.manifest = options.manifest;
    this.#command = options.command;
    this.#args = options.args;
    this.#preferredAuthMethods = options.preferredAuthMethods ?? [];
    this.#versionArgs = options.versionArgs ?? ["--version"];
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#cwdResolver = options.cwdResolver ?? rejectUnconfiguredCwdResolver;
    this.#childEnvironment = buildChildEnvironment(
      options.environment ?? process.env,
      options.providerEnvironmentKeys ?? [],
      options.additionalEnvKeys,
    );
    this.#peerFactory = options.peerFactory ?? createProcessJsonRpcPeer;
    this.#probe = options.probe ?? probeExecutable;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#cancellationGraceMs = options.cancellationGraceMs ?? 2_000;
    this.#runs = new ActiveRunRegistry<AcpRunState>(this.manifest.id);
  }

  async doctor(context: DoctorContext = {}): Promise<DoctorResult> {
    const resolvedContext = context.cwd
      ? { ...context, cwd: await this.#cwdResolver.resolve(context.cwd) }
      : context;
    return executableDoctor(
      this.manifest,
      this.#command,
      this.#versionArgs,
      this.#probe,
      this.#clock,
      { ...this.#childEnvironment.env },
      createSecretRedactor(this.#childEnvironment.secretValues),
      resolvedContext,
    );
  }

  start(input: RunInput, events: HarnessEventSink): Promise<RunHandle> {
    return this.#start(input, events, false);
  }

  resume(input: ResumeInput, events: HarnessEventSink): Promise<RunHandle> {
    return this.#start(input, events, true);
  }

  async cancel(runId: string): Promise<void> {
    const state = this.#runs.get(runId);
    if (state.terminal || state.cancelRequested) return;
    state.cancelRequested = true;
    await state.writer.emit({ type: "run.cancellation.requested" });
    this.#sendCancellation(state);
  }

  async respondToApproval(
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const pending = this.#approvals.get(approvalId);
    if (!pending)
      throw new Error(`Approval ${approvalId} is no longer pending.`);
    this.#approvals.delete(approvalId);
    const options = array(pending.request.params?.options)
      .map((value) => record(value))
      .filter((value): value is Record<string, unknown> => value !== undefined);
    const desiredKinds =
      decision.outcome === "allow"
        ? decision.remember
          ? ["allow_always", "allow_once"]
          : ["allow_once", "allow_always"]
        : ["reject_once", "reject_always", "deny_once", "deny_always"];
    const selected = desiredKinds
      .map((kind) => options.find((option) => string(option.kind) === kind))
      .find((option) => option !== undefined);
    const optionId = string(selected?.optionId) ?? string(selected?.option_id);
    pending.response.resolve(
      optionId
        ? { outcome: { outcome: "selected", optionId } }
        : { outcome: { outcome: "cancelled" } },
    );
  }

  async #start(
    input: RunInput | ResumeInput,
    events: HarnessEventSink,
    resume: boolean,
  ): Promise<RunHandle> {
    validateRunInput(input);
    const resolvedInput = {
      ...input,
      cwd: await this.#cwdResolver.resolve(input.cwd),
    };
    const state: AcpRunState = {
      input: resolvedInput,
      writer: new NormalizedEventWriter(
        input.runId,
        events,
        this.#clock,
        createSecretRedactor(this.#childEnvironment.secretValues, [
          resolvedInput.cwd,
        ]),
      ),
      completion: deferred<RunCompletion>(),
      cancelRequested: false,
      terminal: false,
    };
    this.#runs.add(input.runId, state);
    void this.#boot(state, resume).catch((error) => {
      void (state.cancelRequested
        ? this.#complete(state, "canceled")
        : this.#fail(state, error));
    });
    return { runId: input.runId, completion: state.completion.promise };
  }

  async #boot(state: AcpRunState, resume: boolean): Promise<void> {
    await state.writer.emit({ type: "run.state", state: "starting" });
    const peer = this.#peerFactory({
      command: this.#command,
      args: this.#args,
      cwd: state.input.cwd,
      environment: { ...this.#childEnvironment.env },
      includeJsonRpcHeader: true,
      requestTimeoutMs: this.#requestTimeoutMs,
      onNotification: async ({ method, params }) => {
        if (method !== "session/update") return;
        for (const event of parseAcpSessionUpdate(params, {
          normalizePath: (value) => toWorkspacePath(state.input.cwd, value),
        })) {
          await state.writer.emit(event);
        }
      },
      onRequest: (request) => this.#handleClientRequest(state, request),
      onProtocolError: (error) => void this.#fail(state, error),
    });
    state.peer = peer;
    void peer.closed.then((exit) => {
      if (!state.terminal && !exit.expected) {
        void (state.cancelRequested
          ? this.#complete(state, "canceled")
          : this.#fail(
              state,
              new Error(`${this.manifest.displayName} ACP process exited.`),
            ));
      }
    });

    const initialized = await peer.request<JsonObject>("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: {
        name: "replicantos",
        title: "ReplicantOS",
        version: "0.1.0",
      },
    });
    const authMethod = this.#selectAuthMethod(initialized);
    if (authMethod) {
      await peer.request("authenticate", {
        methodId: authMethod,
        _meta: { headless: true },
      });
    } else if (array(initialized.authMethods).length > 0) {
      throw new Error(
        `${this.manifest.displayName} requires provider-native authentication. Complete its login flow on the host first.`,
      );
    }

    const sessionResult = await peer.request<JsonObject>(
      resume ? "session/load" : "session/new",
      resume
        ? {
            sessionId: (state.input as ResumeInput).sessionId,
            cwd: state.input.cwd,
            mcpServers: [],
          }
        : { cwd: state.input.cwd, mcpServers: [] },
    );
    const sessionId =
      string(sessionResult.sessionId) ?? string(sessionResult.session_id);
    if (!sessionId)
      throw new Error(
        `${this.manifest.displayName} did not return a session id.`,
      );
    state.sessionId = sessionId;
    await state.writer.emit({ type: "session.bound", sessionId });
    await state.writer.emit({ type: "run.state", state: "running" });
    if (state.cancelRequested) this.#sendCancellation(state);

    const promptResult = await peer.request<JsonObject>(
      "session/prompt",
      {
        sessionId,
        prompt: [
          {
            type: "text",
            text: state.input.systemPrompt
              ? [
                  "ReplicantOS system instructions:",
                  state.input.systemPrompt,
                  "",
                  "Channel or task context:",
                  state.input.prompt,
                ].join("\n")
              : state.input.prompt,
          },
        ],
      },
      24 * 60 * 60 * 1_000,
    );
    const stopReason =
      string(promptResult.stopReason) ?? string(promptResult.stop_reason);
    await this.#complete(
      state,
      state.cancelRequested ||
        stopReason === "cancelled" ||
        stopReason === "canceled"
        ? "canceled"
        : "succeeded",
    );
  }

  #selectAuthMethod(initialized: JsonObject): string | undefined {
    const ids = array(initialized.authMethods)
      .map((value) => string(record(value)?.id))
      .filter((value): value is string => value !== undefined);
    for (const preferred of this.#preferredAuthMethods) {
      if (ids.includes(preferred)) return preferred;
    }
    return ids.find((id) => id.includes("cached") || id.endsWith(".api_key"));
  }

  async #handleClientRequest(
    state: AcpRunState,
    request: JsonRpcRequest,
  ): Promise<JsonValue> {
    if (request.method !== "session/request_permission") {
      throw new Error(`Unsupported ACP client request: ${request.method}`);
    }
    const approvalId = `acp:${state.input.runId}:${request.id}`;
    const response = deferred<JsonValue>();
    this.#approvals.set(approvalId, { state, request, response });
    const toolCall =
      record(request.params?.toolCall) ?? record(request.params?.tool_call);
    const options = array(request.params?.options)
      .map((value) => record(value))
      .filter((value): value is Record<string, unknown> => value !== undefined)
      .map((option) => ({
        id: string(option.optionId) ?? string(option.option_id) ?? "unknown",
        label: compactPublicText(option.name, "Permission option", 120),
        kind: string(option.kind)?.startsWith("allow")
          ? ("allow" as const)
          : ("deny" as const),
      }));
    await state.writer.emit({
      type: "approval.requested",
      approvalId,
      kind: "tool",
      title: compactPublicText(
        toolCall?.title,
        `${this.manifest.displayName} tool request`,
      ),
      detail: compactPublicText(
        toolCall?.kind,
        "Review the requested tool action.",
      ),
      risk: "medium",
      ...(options.length > 0 ? { options } : {}),
    });
    return response.promise;
  }

  #sendCancellation(state: AcpRunState): void {
    if (!state.peer || !state.sessionId) return;
    state.peer.notify("session/cancel", { sessionId: state.sessionId });
    if (state.cancellationTimer) return;
    state.cancellationTimer = setTimeout(
      () => state.peer?.close(),
      this.#cancellationGraceMs,
    );
    state.cancellationTimer.unref();
  }

  async #complete(
    state: AcpRunState,
    status: "canceled" | "succeeded",
  ): Promise<void> {
    if (state.terminal) return;
    state.terminal = true;
    try {
      await state.writer.emit({
        type: "run.completed",
        status,
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      });
    } finally {
      this.#settle(state, {
        runId: state.input.runId,
        status,
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      });
    }
  }

  async #fail(state: AcpRunState, error: unknown): Promise<void> {
    if (state.terminal) return;
    state.terminal = true;
    const code = errorCode(error, `${this.manifest.id}_failed`);
    try {
      await state.writer.emit({
        type: "run.failed",
        code,
        message: publicErrorMessage(error),
        retryable: false,
      });
    } catch {
      // Completion still resolves so callers are never left with a hung run.
    } finally {
      this.#settle(state, {
        runId: state.input.runId,
        status: "failed",
        errorCode: code,
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      });
    }
  }

  #settle(state: AcpRunState, completion: RunCompletion): void {
    if (state.cancellationTimer) clearTimeout(state.cancellationTimer);
    for (const [approvalId, pending] of this.#approvals) {
      if (pending.state !== state) continue;
      this.#approvals.delete(approvalId);
      pending.response.resolve({ outcome: { outcome: "cancelled" } });
    }
    state.completion.resolve(completion);
    state.peer?.close();
    this.#runs.delete(state.input.runId);
  }
}
