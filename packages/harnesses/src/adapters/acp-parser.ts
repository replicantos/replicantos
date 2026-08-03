import type { HarnessEventDraft } from "@replicantos/protocol/harness";

import {
  array,
  compactPublicText,
  number,
  record,
  string,
} from "../runtime/json.js";
import type { ProviderParserContext } from "./codex-parser.js";

function contentText(value: unknown): string | undefined {
  const content = record(value);
  return string(content?.text) ?? string(value);
}

function toolId(update: Record<string, unknown>): string | undefined {
  return (
    string(update.toolCallId) ??
    string(update.tool_call_id) ??
    string(update.id)
  );
}

function mapToolStatus(
  value: unknown,
): "canceled" | "failed" | "succeeded" | undefined {
  const status = string(value)?.toLowerCase();
  if (!status || status === "pending" || status === "in_progress")
    return undefined;
  if (status === "cancelled" || status === "canceled") return "canceled";
  if (status === "failed" || status === "error") return "failed";
  if (status === "completed" || status === "succeeded") return "succeeded";
  return undefined;
}

/** Parses ACP v1 session/update notifications into provider-neutral drafts. */
export function parseAcpSessionUpdate(
  paramsValue: unknown,
  context: ProviderParserContext = {},
): HarnessEventDraft[] {
  const params = record(paramsValue);
  const update = record(params?.update);
  if (!update) return [];
  const kind = string(update.sessionUpdate) ?? string(update.session_update);
  switch (kind) {
    case "agent_message_chunk": {
      const text = contentText(update.content);
      return text ? [{ type: "assistant.text.delta", text }] : [];
    }
    case "agent_thought_chunk": {
      const text = contentText(update.content);
      return text ? [{ type: "assistant.reasoning.summary", text }] : [];
    }
    case "tool_call": {
      const toolCallId = toolId(update);
      if (!toolCallId) return [];
      return [
        {
          type: "tool.started",
          toolCallId,
          name: compactPublicText(update.kind ?? update.title, "tool", 120),
          ...(string(update.title)
            ? { title: compactPublicText(update.title, "Tool request") }
            : {}),
        },
      ];
    }
    case "tool_call_update": {
      const toolCallId = toolId(update);
      if (!toolCallId) return [];
      const terminalStatus = mapToolStatus(update.status);
      if (terminalStatus) {
        return [{ type: "tool.completed", toolCallId, status: terminalStatus }];
      }
      const message = string(update.title) ?? string(update.status);
      return message
        ? [
            {
              type: "tool.progress",
              toolCallId,
              message: compactPublicText(message, "Working"),
            },
          ]
        : [];
    }
    case "plan": {
      const entries = array(update.entries)
        .map((entry) => record(entry))
        .filter(
          (entry): entry is Record<string, unknown> => entry !== undefined,
        )
        .map((entry) => {
          const status = string(entry.status);
          const normalizedStatus: "completed" | "in_progress" | "pending" =
            status === "completed"
              ? "completed"
              : status === "in_progress"
                ? "in_progress"
                : "pending";
          return {
            content: compactPublicText(entry.content, "Plan step", 500),
            status: normalizedStatus,
          };
        });
      return entries.length > 0 ? [{ type: "plan.updated", entries }] : [];
    }
    case "usage_update": {
      const usage = record(update.usage) ?? update;
      const inputTokens =
        number(usage.inputTokens) ?? number(usage.input_tokens) ?? 0;
      const outputTokens =
        number(usage.outputTokens) ?? number(usage.output_tokens) ?? 0;
      return inputTokens > 0 || outputTokens > 0
        ? [
            {
              type: "usage.updated",
              inputTokens: Math.max(0, Math.trunc(inputTokens)),
              outputTokens: Math.max(0, Math.trunc(outputTokens)),
            },
          ]
        : [];
    }
    case "file_change": {
      const providerPath = string(update.path);
      const normalized = providerPath
        ? context.normalizePath?.(providerPath)
        : undefined;
      if (!normalized) return [];
      const change = string(update.change);
      return [
        {
          type: "file.changed",
          path: normalized,
          change:
            change === "created" || change === "deleted" || change === "renamed"
              ? change
              : "modified",
        },
      ];
    }
    default:
      return [];
  }
}
