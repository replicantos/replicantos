import type { HarnessEventDraft } from "@replicantos/protocol/harness";

import {
  array,
  boolean,
  compactPublicText,
  number,
  record,
  string,
} from "../runtime/json.js";

export interface ProviderParserContext {
  normalizePath?(path: string): string | undefined;
}

const TOOL_ITEM_TYPES = new Set([
  "collabAgentToolCall",
  "commandExecution",
  "dynamicToolCall",
  "mcpToolCall",
  "webSearch",
]);

function itemName(item: Record<string, unknown>): string {
  return (
    string(item.tool) ??
    string(item.name) ??
    string(item.server) ??
    string(item.type) ??
    "tool"
  ).slice(0, 120);
}

function itemId(item: Record<string, unknown>): string | undefined {
  return string(item.id) ?? string(item.callId) ?? string(item.toolCallId);
}

function mapToolStatus(value: unknown): "canceled" | "failed" | "succeeded" {
  const status = string(value)?.toLowerCase();
  if (
    status === "cancelled" ||
    status === "canceled" ||
    status === "interrupted"
  ) {
    return "canceled";
  }
  if (status === "failed" || status === "error") return "failed";
  return "succeeded";
}

function parseUsage(
  params: Record<string, unknown>,
): HarnessEventDraft | undefined {
  const usage =
    record(params.tokenUsage) ??
    record(params.usage) ??
    record(record(params.turn)?.usage);
  if (!usage) return undefined;
  const total = record(usage.totalUsage) ?? usage;
  const inputTokens =
    number(total.inputTokens) ?? number(total.input_tokens) ?? 0;
  const outputTokens =
    number(total.outputTokens) ?? number(total.output_tokens) ?? 0;
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  const cachedInputTokens =
    number(total.cachedInputTokens) ?? number(total.cached_input_tokens);
  return {
    type: "usage.updated",
    inputTokens: Math.max(0, Math.trunc(inputTokens)),
    outputTokens: Math.max(0, Math.trunc(outputTokens)),
    ...(cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: Math.max(0, Math.trunc(cachedInputTokens)) }),
  };
}

function parseFileChanges(
  item: Record<string, unknown>,
  context: ProviderParserContext,
): HarnessEventDraft[] {
  const events: HarnessEventDraft[] = [];
  const candidates =
    array(item.changes).length > 0 ? array(item.changes) : [item];
  for (const candidate of candidates) {
    const change = record(candidate);
    if (!change) continue;
    const providerPath = string(change.path) ?? string(change.filePath);
    if (!providerPath) continue;
    const normalized = context.normalizePath?.(providerPath);
    if (!normalized) continue;
    const kind = (
      string(change.kind) ??
      string(change.change) ??
      "modified"
    ).toLowerCase();
    const mapped = kind.includes("delete")
      ? "deleted"
      : kind.includes("create") || kind.includes("add")
        ? "created"
        : kind.includes("rename")
          ? "renamed"
          : "modified";
    events.push({ type: "file.changed", path: normalized, change: mapped });
  }
  return events;
}

/** Converts selected Codex app-server notifications without retaining native payloads. */
export function parseCodexNotification(
  method: string,
  paramsValue: unknown,
  context: ProviderParserContext = {},
): HarnessEventDraft[] {
  const params = record(paramsValue) ?? {};
  if (method === "item/agentMessage/delta") {
    const text = string(params.delta) ?? string(record(params.delta)?.text);
    return text ? [{ type: "assistant.text.delta", text }] : [];
  }
  if (
    method === "item/reasoning/summaryTextDelta" ||
    method === "item/reasoning/textDelta" ||
    method === "item/reasoning/delta"
  ) {
    const text = string(params.delta) ?? string(record(params.delta)?.text);
    return text ? [{ type: "assistant.reasoning.summary", text }] : [];
  }
  if (method.includes("tokenUsage") || method === "turn/usage/updated") {
    const usage = parseUsage(params);
    return usage ? [usage] : [];
  }
  if (method === "error" || method.endsWith("/error")) {
    const error = record(params.error) ?? params;
    return [
      {
        type: "warning",
        code: string(error.code) ?? "codex_warning",
        message: compactPublicText(
          error.message,
          "Codex reported a recoverable error.",
        ),
        recoverable:
          boolean(error.willRetry) ?? boolean(params.recoverable) ?? false,
      },
    ];
  }
  if (method !== "item/started" && method !== "item/completed") return [];
  const item = record(params.item);
  if (!item) return [];
  const type = string(item.type);
  if (type === "fileChange") return parseFileChanges(item, context);
  if (!type || !TOOL_ITEM_TYPES.has(type)) return [];
  const toolCallId = itemId(item);
  if (!toolCallId) return [];
  if (method === "item/started") {
    return [
      {
        type: "tool.started",
        toolCallId,
        name: itemName(item),
        ...(string(item.title)
          ? { title: compactPublicText(item.title, itemName(item)) }
          : {}),
      },
    ];
  }
  return [
    {
      type: "tool.completed",
      toolCallId,
      status: mapToolStatus(item.status),
    },
  ];
}

export function codexTurnTerminalStatus(
  paramsValue: unknown,
): "canceled" | "failed" | "succeeded" | undefined {
  const params = record(paramsValue);
  const turn = record(params?.turn);
  const status = string(turn?.status) ?? string(params?.status);
  if (!status) return undefined;
  if (status === "completed") return "succeeded";
  if (
    status === "interrupted" ||
    status === "cancelled" ||
    status === "canceled"
  ) {
    return "canceled";
  }
  if (status === "failed") return "failed";
  return undefined;
}
