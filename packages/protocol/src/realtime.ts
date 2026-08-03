import type { HarnessEvent } from "./harness.js";
import {
  ProtocolValidationError,
  requireInteger,
  requireIsoTimestamp,
  requireJsonObject,
  requireRecord,
  requireString,
  type JsonObject,
} from "./schema.js";
import { PROTOCOL_VERSION, type ProtocolVersion } from "./version.js";

export type RealtimeEventType =
  | "approval.updated"
  | "channel.updated"
  | "harness.event"
  | "message.created"
  | "message.deleted"
  | "message.updated"
  | "notification.created"
  | "presence.updated"
  | "schedule.updated"
  | "task.updated";

export interface RealtimeEnvelope<
  TType extends RealtimeEventType = RealtimeEventType,
> {
  version: ProtocolVersion;
  eventId: string;
  workspaceId: string;
  sequence: number;
  occurredAt: string;
  type: TType;
  data: TType extends "harness.event" ? HarnessEvent : JsonObject;
}

const REALTIME_EVENT_TYPES: readonly RealtimeEventType[] = [
  "approval.updated",
  "channel.updated",
  "harness.event",
  "message.created",
  "message.deleted",
  "message.updated",
  "notification.created",
  "presence.updated",
  "schedule.updated",
  "task.updated",
];

export function makeRealtimeEnvelope<TType extends RealtimeEventType>(input: {
  eventId: string;
  workspaceId: string;
  sequence: number;
  occurredAt: string;
  type: TType;
  data: RealtimeEnvelope<TType>["data"];
}): RealtimeEnvelope<TType> {
  return { version: PROTOCOL_VERSION, ...input };
}

export function parseRealtimeEnvelope(value: unknown): RealtimeEnvelope {
  const envelope = requireRecord(value, "realtime");
  const version = requireInteger(envelope.version, "realtime.version", 1);
  if (version !== PROTOCOL_VERSION) {
    throw new ProtocolValidationError(
      `realtime.version ${version} is unsupported; expected ${PROTOCOL_VERSION}`,
    );
  }
  const type = requireString(envelope.type, "realtime.type");
  if (!REALTIME_EVENT_TYPES.includes(type as RealtimeEventType)) {
    throw new ProtocolValidationError(`realtime.type ${type} is unknown`);
  }
  return {
    version: PROTOCOL_VERSION,
    eventId: requireString(envelope.eventId, "realtime.eventId"),
    workspaceId: requireString(envelope.workspaceId, "realtime.workspaceId"),
    sequence: requireInteger(envelope.sequence, "realtime.sequence"),
    occurredAt: requireIsoTimestamp(envelope.occurredAt, "realtime.occurredAt"),
    type: type as RealtimeEventType,
    data: requireJsonObject(envelope.data, "realtime.data"),
  } as RealtimeEnvelope;
}
