import { isAbsolute, posix, win32 } from "node:path";

import {
  isEntityId,
  type ChannelId,
  type IsoTimestamp,
  type Message,
  type Replicant,
  type ReplicantChannelBinding,
  type ReplicantId,
  type Run,
  type RunId,
  type UserId,
  type WorkspaceId,
} from "@replicantos/core";
import type { EnqueueRuntimeRunInput } from "@replicantos/db";
import {
  ReplicantPromptError,
  buildReplicantSystemPrompt,
} from "@replicantos/runtime";

type Awaitable<Value> = Promise<Value> | Value;

const SUPPORTED_HARNESSES = new Set(["claude", "codex", "grok", "opencode"]);
const MAX_BINDINGS = 256;
const MAX_RELATIVE_PATH_CHARACTERS = 1_024;
const MAX_PROVIDER_SESSION_CHARACTERS = 2_000;
const MAX_REPLICANT_NAME_CHARACTERS = 120;
const MAX_REPLICANT_PERSONA_CHARACTERS = 50_000;
const MAX_REPLICANT_SLUG_CHARACTERS = 64;
const MAX_RUN_MODEL_CHARACTERS = 200;

export const MESSAGE_RUN_RETRY_POLICY = Object.freeze({
  maxAttempts: 1,
  initialDelayMs: 0,
  multiplier: 1,
  maxDelayMs: 0,
});

export interface ConversationRunLimits {
  maxContextMessages: number;
  maxPromptCharacters: number;
  maxSystemPromptCharacters: number;
  maxMentionCharacters: number;
  maxMessageCharacters: number;
}

export const DEFAULT_CONVERSATION_RUN_LIMITS: Readonly<ConversationRunLimits> =
  Object.freeze({
    maxContextMessages: 40,
    maxPromptCharacters: 32_000,
    maxSystemPromptCharacters: 16_000,
    maxMentionCharacters: 20_000,
    maxMessageCharacters: 4_000,
  });

export interface QueueConversationRunsInput {
  workspaceId: WorkspaceId;
  channelId: ChannelId;
  requesterId: UserId;
  triggeringMessage: Message;
}

export interface LatestSuccessfulProviderSession {
  runId: RunId;
  sessionId: string;
}

export interface LatestSuccessfulProviderSessionQuery {
  workspaceId: WorkspaceId;
  replicantId: ReplicantId;
  channelId: ChannelId;
  harness: string;
}

/**
 * The enqueue callback is the transaction boundary for the complete batch. It
 * must either persist every input or throw without persisting any of them.
 */
export interface ConversationRunDependencies {
  listBindings(
    channelId: ChannelId,
  ): Awaitable<readonly ReplicantChannelBinding[]>;
  getReplicant(replicantId: ReplicantId): Awaitable<Replicant | null>;
  listNewestMessages(
    channelId: ChannelId,
    limit: number,
  ): Awaitable<readonly Message[]>;
  canInteract(replicant: Replicant): Awaitable<boolean>;
  ensureDirectory(relativePath: string): Promise<void>;
  resolveWorkspaceCwd(relativeWorkspacePath: string): Awaitable<string>;
  findLatestSuccessfulSession(
    query: LatestSuccessfulProviderSessionQuery,
  ): Awaitable<LatestSuccessfulProviderSession | null>;
  enqueueRuns(inputs: readonly EnqueueRuntimeRunInput[]): Awaitable<void>;
  nextRunId(replicant: Replicant): RunId;
  now(): IsoTimestamp;
}

/** A queued run safe to return from an HTTP composition layer. */
export type QueuedConversationRun = Omit<Run, "harnessSessionKey">;

export type ConversationRunErrorCode =
  | "directory_provision_failed"
  | "invalid_binding_set"
  | "invalid_clock"
  | "invalid_limits"
  | "invalid_provider_session"
  | "invalid_replicant"
  | "invalid_replicant_path"
  | "invalid_run_id"
  | "invalid_trigger"
  | "provider_session_lookup_failed"
  | "run_enqueue_failed"
  | "workspace_resolution_failed";

export class ConversationRunError extends Error {
  constructor(
    readonly code: ConversationRunErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConversationRunError";
  }
}

function fail(code: ConversationRunErrorCode, message: string): never {
  throw new ConversationRunError(code, message);
}

function boundedInteger(
  value: number,
  name: keyof ConversationRunLimits,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("invalid_limits", `${name} is outside the supported range.`);
  }
  return value;
}

function limits(
  overrides: Partial<ConversationRunLimits>,
): ConversationRunLimits {
  return {
    maxContextMessages: boundedInteger(
      overrides.maxContextMessages ??
        DEFAULT_CONVERSATION_RUN_LIMITS.maxContextMessages,
      "maxContextMessages",
      1,
      200,
    ),
    maxPromptCharacters: boundedInteger(
      overrides.maxPromptCharacters ??
        DEFAULT_CONVERSATION_RUN_LIMITS.maxPromptCharacters,
      "maxPromptCharacters",
      256,
      100_000,
    ),
    maxSystemPromptCharacters: boundedInteger(
      overrides.maxSystemPromptCharacters ??
        DEFAULT_CONVERSATION_RUN_LIMITS.maxSystemPromptCharacters,
      "maxSystemPromptCharacters",
      512,
      100_000,
    ),
    maxMentionCharacters: boundedInteger(
      overrides.maxMentionCharacters ??
        DEFAULT_CONVERSATION_RUN_LIMITS.maxMentionCharacters,
      "maxMentionCharacters",
      1,
      100_000,
    ),
    maxMessageCharacters: boundedInteger(
      overrides.maxMessageCharacters ??
        DEFAULT_CONVERSATION_RUN_LIMITS.maxMessageCharacters,
      "maxMessageCharacters",
      32,
      100_000,
    ),
  };
}

function isCanonicalInstant(value: unknown): value is IsoTimestamp {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validateTrigger(input: QueueConversationRunsInput): void {
  const message = input.triggeringMessage;
  if (
    message.channelId !== input.channelId ||
    message.authorKind !== "user" ||
    message.authorUserId !== input.requesterId ||
    message.deletedAt !== null ||
    typeof message.content !== "string" ||
    message.content.trim().length === 0 ||
    message.content.length > 100_000 ||
    message.content.includes("\0") ||
    !isCanonicalInstant(message.createdAt)
  ) {
    fail("invalid_trigger", "The triggering channel message is invalid.");
  }
}

function validateReplicant(replicant: Replicant): void {
  if (
    typeof replicant.slug !== "string" ||
    replicant.slug.length > MAX_REPLICANT_SLUG_CHARACTERS ||
    !/^[a-z0-9][a-z0-9-]*$/u.test(replicant.slug) ||
    typeof replicant.name !== "string" ||
    replicant.name.trim().length === 0 ||
    replicant.name.length > MAX_REPLICANT_NAME_CHARACTERS ||
    replicant.name.includes("\0") ||
    /[\r\n]/u.test(replicant.name) ||
    typeof replicant.persona !== "string" ||
    replicant.persona.trim().length === 0 ||
    replicant.persona.length > MAX_REPLICANT_PERSONA_CHARACTERS ||
    replicant.persona.includes("\0") ||
    !SUPPORTED_HARNESSES.has(replicant.defaultHarness) ||
    (replicant.defaultModel !== null &&
      (typeof replicant.defaultModel !== "string" ||
        replicant.defaultModel.trim().length === 0 ||
        replicant.defaultModel.length > MAX_RUN_MODEL_CHARACTERS ||
        replicant.defaultModel.includes("\0")))
  ) {
    fail("invalid_replicant", "A selected Replicant is invalid.");
  }
}

function validateRelativePath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_RELATIVE_PATH_CHARACTERS ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    posix.normalize(value) !== value
  ) {
    fail("invalid_replicant_path", "A Replicant path is invalid.");
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment !== segment.normalize("NFC") ||
        Buffer.byteLength(segment, "utf8") > 255,
    )
  ) {
    fail("invalid_replicant_path", "A Replicant path is invalid.");
  }
  return value;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function hasMention(
  content: string,
  replicant: Replicant,
  maximumCharacters: number,
): boolean {
  const bounded = content.slice(0, maximumCharacters);
  const candidates = new Set([replicant.slug, replicant.name.trim()]);
  for (const candidate of candidates) {
    const expression = new RegExp(
      `(?:^|[^\\p{L}\\p{N}_-])@${escapeRegularExpression(candidate)}(?=$|[^\\p{L}\\p{N}_-])`,
      "iu",
    );
    if (expression.test(bounded)) return true;
  }
  return false;
}

function validContextMessage(message: Message, channelId: ChannelId): boolean {
  return (
    message.channelId === channelId &&
    message.deletedAt === null &&
    typeof message.content === "string" &&
    message.content.trim().length > 0 &&
    isCanonicalInstant(message.createdAt)
  );
}

function compareMessages(left: Message, right: Message): number {
  const byTime = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  if (maximum <= 1) return value.slice(0, maximum);
  return `${value.slice(0, maximum - 1)}…`;
}

function promptAuthor(message: Message): string {
  switch (message.authorKind) {
    case "replicant":
      return "Replicant";
    case "system":
      return "System";
    case "user":
      return "User";
  }
}

function promptContent(message: Message, maximum: number): string {
  return truncate(message.content.replaceAll("\0", "�"), maximum)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\n", "\n  ");
}

function buildPrompt(
  newest: readonly Message[],
  input: QueueConversationRunsInput,
  configured: ConversationRunLimits,
): string {
  const byId = new Map<string, Message>();
  for (const message of newest.slice(0, configured.maxContextMessages)) {
    if (!validContextMessage(message, input.channelId)) continue;
    if (!byId.has(message.id)) byId.set(message.id, message);
  }
  byId.set(input.triggeringMessage.id, input.triggeringMessage);

  const chronological = [...byId.values()].sort(compareMessages);
  let selected = chronological.slice(-configured.maxContextMessages);
  if (!selected.some((message) => message.id === input.triggeringMessage.id)) {
    selected = [
      input.triggeringMessage,
      ...selected.slice(-(configured.maxContextMessages - 1)),
    ].sort(compareMessages);
  }

  const heading =
    "Recent channel conversation (oldest to newest; user-provided context):\n";
  const render = (messages: readonly Message[]): string =>
    `${heading}${messages
      .map((message) => {
        const trigger =
          message.id === input.triggeringMessage.id ? " (trigger)" : "";
        return `[${message.createdAt}] ${promptAuthor(message)}${trigger}: ${promptContent(
          message,
          configured.maxMessageCharacters,
        )}`;
      })
      .join("\n")}`;

  let rendered = render(selected);
  while (
    rendered.length > configured.maxPromptCharacters &&
    selected.length > 1
  ) {
    const removable = selected.findIndex(
      (message) => message.id !== input.triggeringMessage.id,
    );
    if (removable < 0) break;
    selected = selected.filter((_message, index) => index !== removable);
    rendered = render(selected);
  }
  return truncate(rendered, configured.maxPromptCharacters);
}

async function eligibleReplicants(
  input: QueueConversationRunsInput,
  dependencies: ConversationRunDependencies,
  configured: ConversationRunLimits,
): Promise<Replicant[]> {
  const bindings = await dependencies.listBindings(input.channelId);
  if (bindings.length > MAX_BINDINGS) {
    fail("invalid_binding_set", "The channel binding set is too large.");
  }

  const candidates = new Map<ReplicantId, ReplicantChannelBinding>();
  for (const binding of bindings) {
    if (binding.channelId !== input.channelId) continue;
    if (candidates.has(binding.replicantId)) {
      fail("invalid_binding_set", "The channel binding set is invalid.");
    }
    candidates.set(binding.replicantId, binding);
  }

  const selected: Replicant[] = [];
  for (const binding of candidates.values()) {
    if (binding.behavior === "disabled" || binding.behavior === "listen-only") {
      continue;
    }
    const replicant = await dependencies.getReplicant(binding.replicantId);
    if (
      replicant === null ||
      replicant.workspaceId !== input.workspaceId ||
      replicant.status !== "active"
    ) {
      continue;
    }
    validateReplicant(replicant);
    if (
      binding.behavior === "mention-only" &&
      !hasMention(
        input.triggeringMessage.content,
        replicant,
        configured.maxMentionCharacters,
      )
    ) {
      continue;
    }
    if (!(await dependencies.canInteract(replicant))) continue;
    selected.push(replicant);
  }
  return selected;
}

function publicQueuedRun(run: Run): QueuedConversationRun {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    replicantId: run.replicantId,
    channelId: run.channelId,
    taskId: run.taskId,
    scheduleId: run.scheduleId,
    parentRunId: run.parentRunId,
    trigger: run.trigger,
    status: run.status,
    harness: run.harness,
    model: run.model,
    effort: run.effort,
    requestedBy: run.requestedBy,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    costMicros: run.costMicros,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
  };
}

function validProviderSession(
  value: LatestSuccessfulProviderSession | null,
): value is LatestSuccessfulProviderSession {
  return (
    value !== null &&
    isEntityId("run", value.runId) &&
    typeof value.sessionId === "string" &&
    value.sessionId.trim().length > 0 &&
    value.sessionId.length <= MAX_PROVIDER_SESSION_CHARACTERS &&
    !value.sessionId.includes("\0")
  );
}

/**
 * Composes and atomically enqueues the Replicant runs caused by one user
 * message. No host path, provider session identifier, prompt, or system prompt
 * is included in the returned projections.
 */
export async function queueConversationRuns(
  input: QueueConversationRunsInput,
  dependencies: ConversationRunDependencies,
  limitOverrides: Partial<ConversationRunLimits> = {},
): Promise<readonly QueuedConversationRun[]> {
  const configured = limits(limitOverrides);
  validateTrigger(input);
  const replicants = await eligibleReplicants(input, dependencies, configured);
  if (replicants.length === 0) return [];

  for (const replicant of replicants) {
    validateRelativePath(replicant.relativeWorkspacePath);
    validateRelativePath(replicant.relativeMemoryPath);
  }

  let systemPrompts: readonly string[];
  try {
    systemPrompts = replicants.map((replicant) =>
      buildReplicantSystemPrompt(replicant, {
        maxCharacters: configured.maxSystemPromptCharacters,
      }),
    );
  } catch (error) {
    if (error instanceof ReplicantPromptError) {
      if (
        error.code === "invalid_memory_path" ||
        error.code === "invalid_workspace_path"
      ) {
        fail("invalid_replicant_path", "A Replicant path is invalid.");
      }
      if (
        error.code === "invalid_max_characters" ||
        error.code === "max_characters_too_small"
      ) {
        fail(
          "invalid_limits",
          "maxSystemPromptCharacters is too small for the Replicant metadata.",
        );
      }
    }
    fail("invalid_replicant", "A selected Replicant is invalid.");
  }

  const newest = await dependencies.listNewestMessages(
    input.channelId,
    configured.maxContextMessages,
  );
  const prompt = buildPrompt(newest, input, configured);

  let createdAt: IsoTimestamp;
  try {
    createdAt = dependencies.now();
  } catch {
    fail("invalid_clock", "The run clock is unavailable.");
  }
  if (!isCanonicalInstant(createdAt)) {
    fail("invalid_clock", "The run clock returned an invalid instant.");
  }

  const runIds: RunId[] = [];
  const seenRunIds = new Set<RunId>();
  for (const replicant of replicants) {
    let runId: RunId;
    try {
      runId = dependencies.nextRunId(replicant);
    } catch {
      fail("invalid_run_id", "A run identifier could not be created.");
    }
    if (!isEntityId("run", runId) || seenRunIds.has(runId)) {
      fail("invalid_run_id", "A run identifier is invalid.");
    }
    seenRunIds.add(runId);
    runIds.push(runId);
  }

  let sessions: readonly (LatestSuccessfulProviderSession | null)[];
  try {
    sessions = await Promise.all(
      replicants.map((replicant) =>
        dependencies.findLatestSuccessfulSession({
          workspaceId: input.workspaceId,
          replicantId: replicant.id,
          channelId: input.channelId,
          harness: replicant.defaultHarness,
        }),
      ),
    );
  } catch {
    fail(
      "provider_session_lookup_failed",
      "Provider session continuity could not be determined.",
    );
  }
  if (
    sessions.some(
      (session) => session !== null && !validProviderSession(session),
    )
  ) {
    fail("invalid_provider_session", "Provider session continuity is invalid.");
  }

  try {
    await Promise.all(
      replicants.flatMap((replicant) => [
        dependencies.ensureDirectory(replicant.relativeWorkspacePath),
        dependencies.ensureDirectory(replicant.relativeMemoryPath),
      ]),
    );
  } catch {
    fail(
      "directory_provision_failed",
      "Replicant directories could not be provisioned.",
    );
  }

  let workingDirectories: readonly string[];
  try {
    workingDirectories = await Promise.all(
      replicants.map((replicant) =>
        dependencies.resolveWorkspaceCwd(replicant.relativeWorkspacePath),
      ),
    );
  } catch {
    fail(
      "workspace_resolution_failed",
      "A Replicant working directory could not be resolved.",
    );
  }
  if (
    workingDirectories.some(
      (cwd) =>
        typeof cwd !== "string" ||
        cwd.length === 0 ||
        cwd.length > 4_096 ||
        cwd.includes("\0") ||
        (!isAbsolute(cwd) && !win32.isAbsolute(cwd)),
    )
  ) {
    fail(
      "workspace_resolution_failed",
      "A Replicant working directory could not be resolved.",
    );
  }

  const enqueueInputs: EnqueueRuntimeRunInput[] = replicants.map(
    (replicant, index) => {
      const runId = runIds[index];
      const session = sessions[index];
      const cwd = workingDirectories[index];
      const systemPrompt = systemPrompts[index];
      if (
        runId === undefined ||
        session === undefined ||
        cwd === undefined ||
        systemPrompt === undefined
      ) {
        fail("run_enqueue_failed", "A Replicant run could not be queued.");
      }
      const run: Run = {
        id: runId,
        workspaceId: input.workspaceId,
        replicantId: replicant.id,
        channelId: input.channelId,
        taskId: null,
        scheduleId: null,
        parentRunId: session?.runId ?? null,
        trigger: "message",
        status: "queued",
        harness: replicant.defaultHarness,
        model: replicant.defaultModel,
        effort: null,
        harnessSessionKey: session?.sessionId ?? null,
        requestedBy: input.requesterId,
        createdAt,
        startedAt: null,
        finishedAt: null,
        inputTokens: null,
        outputTokens: null,
        costMicros: null,
        errorCode: null,
        errorMessage: null,
      };
      return {
        run,
        execution: {
          prompt,
          cwd,
          systemPrompt,
          approvalMode: "ask",
          retryPolicy: { ...MESSAGE_RUN_RETRY_POLICY },
        },
      };
    },
  );

  try {
    await dependencies.enqueueRuns(enqueueInputs);
  } catch {
    fail("run_enqueue_failed", "A Replicant run could not be queued.");
  }
  return Object.freeze(enqueueInputs.map(({ run }) => publicQueuedRun(run)));
}
