import type {
  HarnessEventDraft,
  RunTerminalStatus,
} from "@replicantos/protocol/harness";

import {
  array,
  boolean,
  compactPublicText,
  number,
  record,
  string,
} from "../runtime/json.js";

export interface ClaudeParseResult {
  events: readonly HarnessEventDraft[];
  sessionId?: string;
  terminalStatus?: RunTerminalStatus;
  errorCode?: string;
}

function sessionId(message: Record<string, unknown>): string | undefined {
  return string(message.session_id) ?? string(message.sessionId);
}

/** Converts documented Claude Agent SDK messages without exposing the SDK union. */
export function parseClaudeMessage(value: unknown): ClaudeParseResult {
  const message = record(value);
  if (!message) return { events: [] };
  const type = string(message.type);
  const common = sessionId(message);
  if (type === "stream_event") {
    const event = record(message.event);
    if (string(event?.type) !== "content_block_delta") {
      return { events: [], ...(common ? { sessionId: common } : {}) };
    }
    const delta = record(event?.delta);
    const deltaType = string(delta?.type);
    const text = string(delta?.text) ?? string(delta?.thinking);
    if (!text) return { events: [], ...(common ? { sessionId: common } : {}) };
    return {
      events: [
        deltaType === "thinking_delta"
          ? { type: "assistant.reasoning.summary", text }
          : { type: "assistant.text.delta", text },
      ],
      ...(common ? { sessionId: common } : {}),
    };
  }
  if (type === "assistant") {
    const sdkMessage = record(message.message);
    const events: HarnessEventDraft[] = [];
    for (const blockValue of array(sdkMessage?.content)) {
      const block = record(blockValue);
      if (string(block?.type) !== "tool_use") continue;
      const toolCallId = string(block?.id);
      if (!toolCallId) continue;
      events.push({
        type: "tool.started",
        toolCallId,
        name: compactPublicText(block?.name, "tool", 120),
      });
    }
    return { events, ...(common ? { sessionId: common } : {}) };
  }
  if (type === "user") {
    const sdkMessage = record(message.message);
    const events: HarnessEventDraft[] = [];
    for (const blockValue of array(sdkMessage?.content)) {
      const block = record(blockValue);
      if (string(block?.type) !== "tool_result") continue;
      const toolCallId = string(block?.tool_use_id) ?? string(block?.toolUseId);
      if (!toolCallId) continue;
      events.push({
        type: "tool.completed",
        toolCallId,
        status: boolean(block?.is_error) ? "failed" : "succeeded",
      });
    }
    return { events, ...(common ? { sessionId: common } : {}) };
  }
  if (type === "tool_progress" || type === "task_progress") {
    const toolCallId =
      string(message.tool_use_id) ??
      string(message.toolUseId) ??
      string(message.task_id);
    const progress = string(message.summary) ?? string(message.message);
    return {
      events:
        toolCallId && progress
          ? [
              {
                type: "tool.progress",
                toolCallId,
                message: compactPublicText(progress, "Working"),
              },
            ]
          : [],
      ...(common ? { sessionId: common } : {}),
    };
  }
  if (type === "result") {
    const events: HarnessEventDraft[] = [];
    const usage = record(message.usage);
    const inputTokens =
      number(usage?.input_tokens) ?? number(usage?.inputTokens) ?? 0;
    const outputTokens =
      number(usage?.output_tokens) ?? number(usage?.outputTokens) ?? 0;
    const costUsd =
      number(message.total_cost_usd) ?? number(message.totalCostUsd);
    if (inputTokens > 0 || outputTokens > 0 || costUsd !== undefined) {
      events.push({
        type: "usage.updated",
        inputTokens: Math.max(0, Math.trunc(inputTokens)),
        outputTokens: Math.max(0, Math.trunc(outputTokens)),
        ...(costUsd === undefined ? {} : { costUsd: Math.max(0, costUsd) }),
      });
    }
    const subtype = string(message.subtype);
    const failed =
      boolean(message.is_error) === true ||
      (subtype !== undefined && subtype !== "success");
    return {
      events,
      ...(common ? { sessionId: common } : {}),
      terminalStatus: failed ? "failed" : "succeeded",
      ...(failed ? { errorCode: subtype ?? "claude_result_error" } : {}),
    };
  }
  if (type === "system" && string(message.subtype) === "compact_boundary") {
    return {
      events: [
        {
          type: "warning",
          code: "context_compacted",
          message: "Claude compacted the session context.",
          recoverable: true,
        },
      ],
      ...(common ? { sessionId: common } : {}),
    };
  }
  return { events: [], ...(common ? { sessionId: common } : {}) };
}
