import {
  publicErrorMessage,
  type ApprovalDecision,
  type DoctorContext,
  type DoctorResult,
  type HarnessAdapter,
  type HarnessEventSink,
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
import { compactPublicText, record, string } from "../runtime/json.js";
import { toWorkspacePath } from "../runtime/path.js";
import {
  probeExecutable,
  type ProbeExecutable,
} from "../runtime/process-doctor.js";
import { ActiveRunRegistry } from "../runtime/run-registry.js";
import { errorCode, validateRunInput } from "../runtime/validation.js";
import { CODEX_MANIFEST } from "./manifests.js";
import {
  codexTurnTerminalStatus,
  parseCodexNotification,
} from "./codex-parser.js";

export interface CodexAdapterOptions {
  command?: string;
  clock?: Clock;
  cwdResolver?: ApprovedCwdResolver;
  environment?: NodeJS.ProcessEnv;
  additionalEnvKeys?: readonly string[];
  peerFactory?: JsonRpcPeerFactory;
  probe?: ProbeExecutable;
  requestTimeoutMs?: number;
}

/** Provider/config variables copied from the host when present. */
export const CODEX_CHILD_ENV_KEYS = [
  "CODEX_HOME",
  "CODEX_SQLITE_HOME",
  "CODEX_ACCESS_TOKEN",
  "OPENAI_API_KEY",
] as const;

interface PendingCodexApproval {
  state: CodexRunState;
  method: string;
  response: Deferred<JsonValue>;
}

interface CodexRunState {
  input: RunInput;
  writer: NormalizedEventWriter;
  completion: Deferred<RunCompletion>;
  peer?: JsonRpcPeer;
  sessionId?: string;
  turnId?: string;
  cancelRequested: boolean;
  terminal: boolean;
}

export class CodexAdapter implements HarnessAdapter {
  readonly manifest = CODEX_MANIFEST;
  readonly #command: string;
  readonly #clock: Clock;
  readonly #cwdResolver: ApprovedCwdResolver;
  readonly #childEnvironment: ChildEnvironment;
  readonly #peerFactory: JsonRpcPeerFactory;
  readonly #probe: ProbeExecutable;
  readonly #requestTimeoutMs: number;
  readonly #runs = new ActiveRunRegistry<CodexRunState>("codex");
  readonly #approvals = new Map<string, PendingCodexApproval>();

  constructor(options: CodexAdapterOptions = {}) {
    this.#command = options.command ?? "codex";
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#cwdResolver = options.cwdResolver ?? rejectUnconfiguredCwdResolver;
    this.#childEnvironment = buildChildEnvironment(
      options.environment ?? process.env,
      CODEX_CHILD_ENV_KEYS,
      options.additionalEnvKeys,
    );
    this.#peerFactory = options.peerFactory ?? createProcessJsonRpcPeer;
    this.#probe = options.probe ?? probeExecutable;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async doctor(context: DoctorContext = {}): Promise<DoctorResult> {
    const resolvedContext = context.cwd
      ? { ...context, cwd: await this.#cwdResolver.resolve(context.cwd) }
      : context;
    return executableDoctor(
      this.manifest,
      this.#command,
      ["--version"],
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
    await this.#interrupt(state);
  }

  async #interrupt(state: CodexRunState): Promise<void> {
    if (state.peer && state.sessionId && state.turnId) {
      await state.peer.request("turn/interrupt", {
        threadId: state.sessionId,
        turnId: state.turnId,
      });
    }
  }

  async respondToApproval(
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const pending = this.#approvals.get(approvalId);
    if (!pending)
      throw new Error(`Approval ${approvalId} is no longer pending.`);
    this.#approvals.delete(approvalId);
    if (pending.method === "item/permissions/requestApproval") {
      const permissionValue = decision.updatedInput?.permissions;
      const permissions = Array.isArray(permissionValue) ? permissionValue : [];
      pending.response.resolve(
        decision.outcome === "allow" && permissions.length > 0
          ? { permissions, scope: decision.remember ? "session" : "turn" }
          : { permissions: [] },
      );
      return;
    }
    if (pending.method === "item/tool/requestUserInput") {
      pending.response.resolve(
        decision.outcome === "allow" && decision.updatedInput
          ? decision.updatedInput
          : ({ answers: {} } as JsonValue),
      );
      return;
    }
    pending.response.resolve({
      decision:
        decision.outcome === "allow"
          ? decision.remember
            ? "acceptForSession"
            : "accept"
          : "decline",
    });
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
    const state: CodexRunState = {
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
    void this.#boot(state, resume).catch((error) => this.#fail(state, error));
    return { runId: input.runId, completion: state.completion.promise };
  }

  async #boot(state: CodexRunState, resume: boolean): Promise<void> {
    await state.writer.emit({ type: "run.state", state: "starting" });
    const peer = this.#peerFactory({
      command: this.#command,
      args: ["app-server"],
      cwd: state.input.cwd,
      environment: { ...this.#childEnvironment.env },
      includeJsonRpcHeader: false,
      requestTimeoutMs: this.#requestTimeoutMs,
      onNotification: async ({ method, params }) => {
        for (const event of parseCodexNotification(method, params, {
          normalizePath: (value) => toWorkspacePath(state.input.cwd, value),
        })) {
          await state.writer.emit(event);
        }
        if (method === "turn/completed") {
          const status = codexTurnTerminalStatus(params);
          if (status === "failed") {
            await this.#fail(
              state,
              new Error("Codex turn failed."),
              "codex_turn_failed",
            );
          } else if (status) {
            await this.#complete(state, status);
          }
        }
      },
      onRequest: (request) => this.#handleServerRequest(state, request),
      onProtocolError: (error) => void this.#fail(state, error),
    });
    state.peer = peer;
    void peer.closed.then((exit) => {
      if (!state.terminal && !exit.expected) {
        void (state.cancelRequested
          ? this.#complete(state, "canceled")
          : this.#fail(
              state,
              new Error("Codex app-server exited unexpectedly."),
            ));
      }
    });

    await peer.request("initialize", {
      clientInfo: {
        name: "replicantos",
        title: "ReplicantOS",
        version: "0.1.0",
      },
    });
    peer.notify("initialized", {});

    const approvalPolicy =
      state.input.approvalMode === "plan" ? "never" : "on-request";
    const sandbox =
      state.input.approvalMode === "plan" ? "read-only" : "workspace-write";
    const threadResult = await peer.request<JsonObject>(
      resume ? "thread/resume" : "thread/start",
      resume
        ? {
            threadId: (state.input as ResumeInput).sessionId,
            cwd: state.input.cwd,
            approvalPolicy,
            sandbox,
            ...(state.input.model ? { model: state.input.model } : {}),
            ...(state.input.systemPrompt
              ? { developerInstructions: state.input.systemPrompt }
              : {}),
          }
        : {
            cwd: state.input.cwd,
            approvalPolicy,
            sandbox,
            ...(state.input.model ? { model: state.input.model } : {}),
            ...(state.input.systemPrompt
              ? { developerInstructions: state.input.systemPrompt }
              : {}),
          },
    );
    const sessionId = string(record(threadResult.thread)?.id);
    if (!sessionId) throw new Error("Codex did not return a thread id.");
    state.sessionId = sessionId;
    await state.writer.emit({ type: "session.bound", sessionId });

    // App-server may emit turn notifications before the turn/start response.
    // Announce the running state before sending the request to preserve event order.
    await state.writer.emit({ type: "run.state", state: "running" });
    const turnResult = await peer.request<JsonObject>("turn/start", {
      threadId: sessionId,
      input: [{ type: "text", text: state.input.prompt }],
      cwd: state.input.cwd,
      approvalPolicy,
      ...(state.input.model ? { model: state.input.model } : {}),
      ...(state.input.reasoningEffort
        ? { effort: state.input.reasoningEffort }
        : {}),
    });
    const turnId = string(record(turnResult.turn)?.id);
    if (!turnId) throw new Error("Codex did not return a turn id.");
    state.turnId = turnId;
    if (state.cancelRequested) await this.#interrupt(state);
  }

  async #handleServerRequest(
    state: CodexRunState,
    request: JsonRpcRequest,
  ): Promise<JsonValue> {
    const supported = new Set([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "item/tool/requestUserInput",
    ]);
    if (!supported.has(request.method)) {
      throw new Error(`Unsupported Codex client request: ${request.method}`);
    }
    const approvalId = `codex:${state.input.runId}:${request.id}`;
    const response = deferred<JsonValue>();
    this.#approvals.set(approvalId, {
      state,
      method: request.method,
      response,
    });
    const params = request.params ?? {};
    const question = request.method === "item/tool/requestUserInput";
    const title = question
      ? "Codex needs your input"
      : request.method.includes("fileChange")
        ? "Approve file changes"
        : request.method.includes("permissions")
          ? "Approve additional permissions"
          : "Approve a Codex tool";
    await state.writer.emit({
      type: "approval.requested",
      approvalId,
      kind: question ? "question" : "tool",
      title,
      detail: compactPublicText(params.reason, `${title}.`),
      risk:
        request.method.includes("fileChange") ||
        request.method.includes("permissions")
          ? "high"
          : "medium",
    });
    return response.promise;
  }

  async #complete(
    state: CodexRunState,
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

  async #fail(
    state: CodexRunState,
    error: unknown,
    code = errorCode(error, "codex_failed"),
  ): Promise<void> {
    if (state.terminal) return;
    state.terminal = true;
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

  #settle(state: CodexRunState, completion: RunCompletion): void {
    for (const [approvalId, pending] of this.#approvals) {
      if (pending.state !== state) continue;
      this.#approvals.delete(approvalId);
      pending.response.resolve({ decision: "cancel" });
    }
    state.completion.resolve(completion);
    state.peer?.close();
    this.#runs.delete(state.input.runId);
  }
}
