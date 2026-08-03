import {
  ProtocolValidationError,
  isRecord,
  requireInteger,
  requireIsoTimestamp,
  requireJsonObject,
  requireRecord,
  requireString,
  type JsonObject,
  type JsonValue,
} from "./schema.js";
import { PROTOCOL_VERSION, type ProtocolVersion } from "./version.js";

export type HarnessId = "claude" | "codex" | "grok" | "opencode";
export type HarnessMaturity = "beta" | "stable";
export type HarnessTransport =
  | "acp-stdio"
  | "app-server-stdio"
  | "in-process-sdk";

export interface HarnessCapabilities {
  approvals: boolean;
  cancellation: boolean;
  fileChanges: boolean;
  images: boolean;
  modelSelection: boolean;
  reasoningSummaries: boolean;
  sessionResume: boolean;
  streamingText: boolean;
  toolEvents: boolean;
  usage: boolean;
}

export interface HarnessManifest {
  id: HarnessId;
  displayName: string;
  description: string;
  maturity: HarnessMaturity;
  transport: HarnessTransport;
  credentials: {
    mode: "host-native";
    storedByReplicantOS: false;
  };
  capabilities: Readonly<HarnessCapabilities>;
}

export interface DoctorContext {
  cwd?: string;
  timeoutMs?: number;
}

export type DoctorCheckStatus = "fail" | "pass" | "warn";

export interface DoctorCheck {
  id: string;
  status: DoctorCheckStatus;
  message: string;
  remediation?: string;
}

export interface DoctorResult {
  harnessId: HarnessId;
  status: "degraded" | "ready" | "unavailable";
  checkedAt: string;
  checks: readonly DoctorCheck[];
}

export type RunApprovalMode = "ask" | "plan";

export interface RunInput {
  runId: string;
  prompt: string;
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  systemPrompt?: string;
  approvalMode?: RunApprovalMode;
}

export interface ResumeInput extends RunInput {
  sessionId: string;
}

export type RunTerminalStatus = "canceled" | "failed" | "succeeded";

export interface RunCompletion {
  runId: string;
  status: RunTerminalStatus;
  sessionId?: string;
  errorCode?: string;
}

export interface RunHandle {
  runId: string;
  completion: Promise<RunCompletion>;
}

export interface ApprovalDecision {
  outcome: "allow" | "deny";
  reason?: string;
  remember?: boolean;
  updatedInput?: JsonObject;
}

interface HarnessEventBase {
  version: ProtocolVersion;
  runId: string;
  sequence: number;
  occurredAt: string;
}

export type HarnessEvent =
  | (HarnessEventBase & {
      type: "run.state";
      state: "awaiting-approval" | "queued" | "running" | "starting";
      message?: string;
    })
  | (HarnessEventBase & { type: "run.cancellation.requested" })
  | (HarnessEventBase & { type: "session.bound"; sessionId: string })
  | (HarnessEventBase & { type: "assistant.text.delta"; text: string })
  | (HarnessEventBase & { type: "assistant.reasoning.summary"; text: string })
  | (HarnessEventBase & {
      type: "plan.updated";
      entries: readonly {
        content: string;
        status: "completed" | "in_progress" | "pending";
      }[];
    })
  | (HarnessEventBase & {
      type: "tool.started";
      toolCallId: string;
      name: string;
      title?: string;
    })
  | (HarnessEventBase & {
      type: "tool.progress";
      toolCallId: string;
      message: string;
    })
  | (HarnessEventBase & {
      type: "tool.completed";
      toolCallId: string;
      status: "canceled" | "failed" | "succeeded";
      summary?: string;
    })
  | (HarnessEventBase & {
      type: "approval.requested";
      approvalId: string;
      kind: "question" | "tool";
      title: string;
      detail: string;
      risk: "high" | "low" | "medium";
      options?: readonly {
        id: string;
        label: string;
        kind: "allow" | "deny";
      }[];
      questions?: readonly {
        id: string;
        question: string;
        multiSelect: boolean;
        options: readonly { label: string; description: string }[];
      }[];
    })
  | (HarnessEventBase & {
      type: "file.changed";
      path: string;
      change: "created" | "deleted" | "modified" | "renamed";
    })
  | (HarnessEventBase & {
      type: "usage.updated";
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      costUsd?: number;
    })
  | (HarnessEventBase & {
      type: "warning";
      code: string;
      message: string;
      recoverable: boolean;
    })
  | (HarnessEventBase & {
      type: "run.completed";
      status: "canceled" | "succeeded";
      sessionId?: string;
    })
  | (HarnessEventBase & {
      type: "run.failed";
      code: string;
      message: string;
      retryable: boolean;
    });

type WithoutEventBase<T> = T extends HarnessEvent
  ? Omit<T, "occurredAt" | "runId" | "sequence" | "version">
  : never;
export type HarnessEventDraft = WithoutEventBase<HarnessEvent>;

export type HarnessEventSink = (event: HarnessEvent) => Promise<void> | void;

export interface HarnessAdapter {
  readonly manifest: HarnessManifest;
  doctor(context?: DoctorContext): Promise<DoctorResult>;
  start(input: RunInput, events: HarnessEventSink): Promise<RunHandle>;
  resume(input: ResumeInput, events: HarnessEventSink): Promise<RunHandle>;
  cancel(runId: string): Promise<void>;
  respondToApproval?(
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<void>;
}

export class HarnessCapabilityError extends Error {
  readonly harnessId: HarnessId;
  readonly capability: keyof HarnessCapabilities;

  constructor(harnessId: HarnessId, capability: keyof HarnessCapabilities) {
    super(`Harness ${harnessId} does not support ${capability}`);
    this.name = "HarnessCapabilityError";
    this.harnessId = harnessId;
    this.capability = capability;
  }
}

export class HarnessContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessContractError";
  }
}

export function assertHarnessAdapter(adapter: HarnessAdapter): void {
  const { manifest } = adapter;
  if (!manifest.displayName.trim() || !manifest.description.trim()) {
    throw new HarnessContractError(
      `Harness ${manifest.id} must have public display metadata`,
    );
  }
  if (
    manifest.credentials.mode !== "host-native" ||
    manifest.credentials.storedByReplicantOS
  ) {
    throw new HarnessContractError(
      `Harness ${manifest.id} must use host-native credentials`,
    );
  }
  if (
    manifest.capabilities.approvals &&
    typeof adapter.respondToApproval !== "function"
  ) {
    throw new HarnessContractError(
      `Harness ${manifest.id} advertises approvals without respondToApproval`,
    );
  }
}

export function createHarnessEvent(
  runId: string,
  sequence: number,
  occurredAt: string,
  draft: HarnessEventDraft,
): HarnessEvent {
  return {
    ...draft,
    version: PROTOCOL_VERSION,
    runId,
    sequence,
    occurredAt,
  } as HarnessEvent;
}

const HARNESS_EVENT_TYPES = new Set([
  "approval.requested",
  "assistant.reasoning.summary",
  "assistant.text.delta",
  "file.changed",
  "plan.updated",
  "run.completed",
  "run.cancellation.requested",
  "run.failed",
  "run.state",
  "session.bound",
  "tool.completed",
  "tool.progress",
  "tool.started",
  "usage.updated",
  "warning",
]);

const RUN_STATES = new Set([
  "awaiting-approval",
  "queued",
  "running",
  "starting",
]);
const RUN_COMPLETION_STATUSES = new Set(["canceled", "succeeded"]);
const TOOL_COMPLETION_STATUSES = new Set(["canceled", "failed", "succeeded"]);

/** Strictly validates metadata and the event discriminator at untrusted boundaries. */
export function parseHarnessEvent(value: unknown): HarnessEvent {
  const event = requireRecord(value, "event");
  const version = requireInteger(event.version, "event.version", 1);
  if (version !== PROTOCOL_VERSION) {
    throw new ProtocolValidationError(
      `event.version ${version} is unsupported; expected ${PROTOCOL_VERSION}`,
    );
  }
  const type = requireString(event.type, "event.type");
  if (!HARNESS_EVENT_TYPES.has(type)) {
    throw new ProtocolValidationError(`event.type ${type} is unknown`);
  }
  requireString(event.runId, "event.runId");
  requireInteger(event.sequence, "event.sequence");
  requireIsoTimestamp(event.occurredAt, "event.occurredAt");
  requireJsonObject(event, "event");

  switch (type) {
    case "assistant.text.delta":
    case "assistant.reasoning.summary":
      requireString(event.text, "event.text");
      break;
    case "session.bound":
      requireString(event.sessionId, "event.sessionId");
      break;
    case "run.state":
      if (!RUN_STATES.has(requireString(event.state, "event.state"))) {
        throw new ProtocolValidationError("event.state is unknown");
      }
      break;
    case "run.cancellation.requested":
      break;
    case "tool.started":
      requireString(event.toolCallId, "event.toolCallId");
      requireString(event.name, "event.name");
      break;
    case "tool.progress":
      requireString(event.toolCallId, "event.toolCallId");
      requireString(event.message, "event.message");
      break;
    case "tool.completed":
      requireString(event.toolCallId, "event.toolCallId");
      if (
        !TOOL_COMPLETION_STATUSES.has(
          requireString(event.status, "event.status"),
        )
      ) {
        throw new ProtocolValidationError("event.status is unknown");
      }
      break;
    case "approval.requested":
      requireString(event.approvalId, "event.approvalId");
      requireString(event.kind, "event.kind");
      requireString(event.title, "event.title");
      requireString(event.detail, "event.detail");
      break;
    case "file.changed":
      requireString(event.path, "event.path");
      requireString(event.change, "event.change");
      break;
    case "usage.updated":
      requireInteger(event.inputTokens, "event.inputTokens");
      requireInteger(event.outputTokens, "event.outputTokens");
      break;
    case "warning":
    case "run.failed":
      requireString(event.code, "event.code");
      requireString(event.message, "event.message");
      break;
    case "run.completed":
      if (
        !RUN_COMPLETION_STATUSES.has(
          requireString(event.status, "event.status"),
        )
      ) {
        throw new ProtocolValidationError("event.status is unknown");
      }
      break;
    case "plan.updated":
      if (!Array.isArray(event.entries)) {
        throw new ProtocolValidationError("event.entries must be an array");
      }
      break;
  }
  return event as unknown as HarnessEvent;
}

export function isTerminalHarnessEvent(event: HarnessEvent): boolean {
  return event.type === "run.completed" || event.type === "run.failed";
}

export function publicErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim())
    return error.message.slice(0, 500);
  if (isRecord(error) && typeof error.message === "string")
    return error.message.slice(0, 500);
  return "The harness stopped unexpectedly.";
}

export function jsonObject(value: Record<string, JsonValue>): JsonObject {
  return value;
}
