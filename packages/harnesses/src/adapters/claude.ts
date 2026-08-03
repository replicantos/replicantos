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
import type { JsonObject } from "@replicantos/protocol";

import { deferred, type Deferred } from "../runtime/deferred.js";
import {
  rejectUnconfiguredCwdResolver,
  type ApprovedCwdResolver,
} from "../runtime/cwd.js";
import {
  buildChildEnvironment,
  createSecretRedactor,
  type ChildEnvironment,
} from "../runtime/environment.js";
import { NormalizedEventWriter, type Clock } from "../runtime/events.js";
import {
  array,
  asJsonObject,
  compactPublicText,
  record,
  string,
} from "../runtime/json.js";
import { ActiveRunRegistry } from "../runtime/run-registry.js";
import { errorCode, validateRunInput } from "../runtime/validation.js";
import { parseClaudeMessage } from "./claude-parser.js";
import { CLAUDE_MANIFEST } from "./manifests.js";

export interface ClaudeQuery extends AsyncIterable<unknown> {
  interrupt?(): Promise<void>;
}

export interface ClaudeSdkModule {
  query(input: {
    prompt: string;
    options: Record<string, unknown>;
  }): ClaudeQuery;
}

export type ClaudeSdkLoader = () => Promise<ClaudeSdkModule>;

const importOptionalClaudeSdk: ClaudeSdkLoader = async () => {
  const dynamicImport = new Function(
    "specifier",
    "return import(specifier)",
  ) as (specifier: string) => Promise<unknown>;
  const loaded = record(await dynamicImport("@anthropic-ai/claude-agent-sdk"));
  if (typeof loaded?.query !== "function") {
    throw new Error("The Claude Agent SDK did not export query().");
  }
  return loaded as unknown as ClaudeSdkModule;
};

export interface ClaudeAdapterOptions {
  clock?: Clock;
  cwdResolver?: ApprovedCwdResolver;
  environment?: NodeJS.ProcessEnv;
  additionalEnvKeys?: readonly string[];
  loadSdk?: ClaudeSdkLoader;
}

/** Provider/config variables copied from the host when present. */
export const CLAUDE_CHILD_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_MANTLE_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUDSDK_CONFIG",
  "CLOUD_ML_REGION",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_AUTHORITY_HOST",
  "AZURE_CONFIG_DIR",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_AWS_BASE_URL",
] as const;

interface ClaudePermissionResult {
  behavior: "allow" | "deny";
  updatedInput?: JsonObject;
  message?: string;
}

interface PendingClaudeApproval {
  state: ClaudeRunState;
  originalInput: JsonObject;
  response: Deferred<ClaudePermissionResult>;
}

interface ClaudeRunState {
  input: RunInput;
  writer: NormalizedEventWriter;
  completion: Deferred<RunCompletion>;
  abortController: AbortController;
  query?: ClaudeQuery;
  sessionId?: string;
  approvalSequence: number;
  cancelRequested: boolean;
  terminal: boolean;
}

export class ClaudeAdapter implements HarnessAdapter {
  readonly manifest = CLAUDE_MANIFEST;
  readonly #clock: Clock;
  readonly #cwdResolver: ApprovedCwdResolver;
  readonly #childEnvironment: ChildEnvironment;
  readonly #loadSdk: ClaudeSdkLoader;
  readonly #runs = new ActiveRunRegistry<ClaudeRunState>("claude");
  readonly #approvals = new Map<string, PendingClaudeApproval>();

  constructor(options: ClaudeAdapterOptions = {}) {
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#cwdResolver = options.cwdResolver ?? rejectUnconfiguredCwdResolver;
    this.#childEnvironment = buildChildEnvironment(
      options.environment ?? process.env,
      CLAUDE_CHILD_ENV_KEYS,
      options.additionalEnvKeys,
    );
    // The SDK replaces its inherited environment with options.env. Keep auth in
    // the SDK process while preventing Bash, hooks, and MCP children from seeing it.
    this.#childEnvironment.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
    this.#loadSdk = options.loadSdk ?? importOptionalClaudeSdk;
  }

  async doctor(context: DoctorContext = {}): Promise<DoctorResult> {
    if (context.cwd) await this.#cwdResolver.resolve(context.cwd);
    let sdkAvailable = false;
    try {
      await this.#loadSdk();
      sdkAvailable = true;
    } catch {
      sdkAvailable = false;
    }
    const authConfigured = this.#hasSupportedHostAuth();
    return {
      harnessId: "claude",
      status: !sdkAvailable
        ? "unavailable"
        : authConfigured
          ? "ready"
          : "degraded",
      checkedAt: this.#clock(),
      checks: [
        sdkAvailable
          ? {
              id: "sdk",
              status: "pass",
              message: "The optional Claude Agent SDK is available.",
            }
          : {
              id: "sdk",
              status: "fail",
              message: "The optional Claude Agent SDK is not installed.",
              remediation:
                "Install @anthropic-ai/claude-agent-sdk for the server package.",
            },
        authConfigured
          ? {
              id: "credentials",
              status: "pass",
              message:
                "A supported host authentication variable is configured; its value is not returned or persisted.",
            }
          : {
              id: "credentials",
              status: "warn",
              message:
                "No supported Claude Agent SDK host authentication mode was detected.",
              remediation:
                "Configure an Anthropic API key or a supported Bedrock, Vertex, or Foundry identity in the server host environment.",
            },
      ],
    };
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
    try {
      await state.query?.interrupt?.();
    } finally {
      state.abortController.abort();
      this.#denyApprovalsFor(state, "The run was canceled.");
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
    pending.response.resolve(
      decision.outcome === "allow"
        ? {
            behavior: "allow",
            updatedInput: decision.updatedInput ?? pending.originalInput,
          }
        : {
            behavior: "deny",
            message:
              decision.reason?.slice(0, 500) || "The user denied this action.",
          },
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
    const state: ClaudeRunState = {
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
      abortController: new AbortController(),
      approvalSequence: 0,
      cancelRequested: false,
      terminal: false,
    };
    this.#runs.add(input.runId, state);
    void this.#consume(state, resume).catch((error) => {
      void (state.cancelRequested
        ? this.#complete(state, "canceled")
        : this.#fail(state, error));
    });
    return { runId: input.runId, completion: state.completion.promise };
  }

  async #consume(state: ClaudeRunState, resume: boolean): Promise<void> {
    await state.writer.emit({ type: "run.state", state: "starting" });
    const sdk = await this.#loadSdk();
    const query = sdk.query({
      prompt: state.input.prompt,
      options: {
        abortController: state.abortController,
        cwd: state.input.cwd,
        env: { ...this.#childEnvironment.env },
        includePartialMessages: true,
        settingSources: ["project"],
        permissionMode:
          state.input.approvalMode === "plan" ? "plan" : "default",
        canUseTool: (
          toolName: string,
          input: unknown,
        ): Promise<ClaudePermissionResult> =>
          this.#requestApproval(state, toolName, input),
        ...(state.input.model ? { model: state.input.model } : {}),
        ...(state.input.systemPrompt
          ? { systemPrompt: state.input.systemPrompt }
          : {}),
        ...(resume ? { resume: (state.input as ResumeInput).sessionId } : {}),
      },
    });
    state.query = query;
    await state.writer.emit({ type: "run.state", state: "running" });
    if (state.cancelRequested) {
      try {
        await state.query.interrupt?.();
      } finally {
        state.abortController.abort();
      }
    }

    let terminal: "failed" | "succeeded" | undefined;
    let terminalCode: string | undefined;
    for await (const message of query) {
      const parsed = parseClaudeMessage(message);
      if (parsed.sessionId && parsed.sessionId !== state.sessionId) {
        state.sessionId = parsed.sessionId;
        await state.writer.emit({
          type: "session.bound",
          sessionId: parsed.sessionId,
        });
      }
      for (const event of parsed.events) await state.writer.emit(event);
      if (
        parsed.terminalStatus === "failed" ||
        parsed.terminalStatus === "succeeded"
      ) {
        terminal = parsed.terminalStatus;
        terminalCode = parsed.errorCode;
      }
    }
    if (state.cancelRequested) {
      await this.#complete(state, "canceled");
    } else if (terminal === "succeeded") {
      await this.#complete(state, "succeeded");
    } else if (terminal === "failed") {
      await this.#fail(
        state,
        new Error("Claude Agent SDK returned a failed result."),
        terminalCode,
      );
    } else {
      await this.#fail(
        state,
        new Error("Claude Agent SDK ended without a result."),
      );
    }
  }

  async #requestApproval(
    state: ClaudeRunState,
    toolName: string,
    inputValue: unknown,
  ): Promise<ClaudePermissionResult> {
    const originalInput = asJsonObject(inputValue) ?? {};
    const approvalId = `claude:${state.input.runId}:${state.approvalSequence++}`;
    const response = deferred<ClaudePermissionResult>();
    this.#approvals.set(approvalId, { state, originalInput, response });
    const isQuestion = toolName === "AskUserQuestion";
    const questions = isQuestion
      ? array(originalInput.questions)
          .map((value, index) => {
            const question = record(value);
            const prompt = string(question?.question);
            if (!prompt) return undefined;
            return {
              id: `question_${index}`,
              question: prompt.slice(0, 1_000),
              multiSelect: question?.multiSelect === true,
              options: array(question?.options)
                .map((optionValue) => record(optionValue))
                .filter(
                  (option): option is Record<string, unknown> =>
                    option !== undefined,
                )
                .map((option) => ({
                  label: compactPublicText(option.label, "Option", 120),
                  description: compactPublicText(option.description, "", 300),
                })),
            };
          })
          .filter(
            (
              question,
            ): question is {
              id: string;
              question: string;
              multiSelect: boolean;
              options: { label: string; description: string }[];
            } => question !== undefined,
          )
      : [];
    await state.writer.emit({
      type: "approval.requested",
      approvalId,
      kind: isQuestion ? "question" : "tool",
      title: isQuestion
        ? "Claude needs your input"
        : `Approve ${toolName.slice(0, 100)}`,
      detail: isQuestion
        ? (questions[0]?.question ??
          "Claude needs clarification before continuing.")
        : "Review this tool request before Claude continues.",
      risk: isQuestion
        ? "low"
        : toolName === "Bash" || toolName === "Write"
          ? "high"
          : "medium",
      ...(questions.length > 0 ? { questions } : {}),
    });
    return response.promise;
  }

  #hasSupportedHostAuth(): boolean {
    return Boolean(
      this.#childEnvironment.env.ANTHROPIC_API_KEY ||
        this.#childEnvironment.env.ANTHROPIC_AUTH_TOKEN ||
        this.#childEnvironment.env.CLAUDE_CODE_USE_BEDROCK ||
        this.#childEnvironment.env.CLAUDE_CODE_USE_MANTLE ||
        this.#childEnvironment.env.CLAUDE_CODE_USE_VERTEX ||
        this.#childEnvironment.env.CLAUDE_CODE_USE_FOUNDRY ||
        this.#childEnvironment.env.CLAUDE_CODE_USE_ANTHROPIC_AWS,
    );
  }

  async #complete(
    state: ClaudeRunState,
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
    state: ClaudeRunState,
    error: unknown,
    overrideCode?: string,
  ): Promise<void> {
    if (state.terminal) return;
    state.terminal = true;
    const code = overrideCode ?? errorCode(error, "claude_failed");
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

  #denyApprovalsFor(state: ClaudeRunState, message: string): void {
    for (const [approvalId, pending] of this.#approvals) {
      if (pending.state !== state) continue;
      this.#approvals.delete(approvalId);
      pending.response.resolve({ behavior: "deny", message });
    }
  }

  #settle(state: ClaudeRunState, completion: RunCompletion): void {
    this.#denyApprovalsFor(state, "The run has ended.");
    state.completion.resolve(completion);
    this.#runs.delete(state.input.runId);
  }
}
