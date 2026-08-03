import assert from "node:assert/strict";
import test from "node:test";

import {
  PROTOCOL_VERSION,
  ProtocolValidationError,
  HTTP_ROUTES,
  createHarnessEvent,
  isPermission,
  makeRealtimeEnvelope,
  parseApiEnvelope,
  parseHarnessEvent,
  parseRealtimeEnvelope,
  success,
} from "../dist/index.js";

test("HTTP envelopes round-trip and reject ambiguous shapes", () => {
  const envelope = success({ status: "ok" });
  assert.deepEqual(parseApiEnvelope(envelope), envelope);
  assert.throws(
    () => parseApiEnvelope({ ...envelope, error: { code: "conflict" } }),
    ProtocolValidationError,
  );
});

test("normalized harness events are JSON-safe and versioned", () => {
  const event = createHarnessEvent("run_demo", 3, "2026-01-01T00:00:00.000Z", {
    type: "assistant.text.delta",
    text: "Hello",
  });
  assert.deepEqual(parseHarnessEvent(event), event);
  assert.throws(
    () =>
      parseHarnessEvent({
        ...event,
        type: "run.completed",
        status: "cancelled",
      }),
    ProtocolValidationError,
  );
});

test("v1 permissions use core capability names", () => {
  assert.equal(isPermission("approval:decide"), true);
  assert.equal(isPermission("artifact:read"), true);
  assert.equal(isPermission("approval:resolve"), false);
  assert.equal(isPermission("document:read"), false);
  assert.equal(HTTP_ROUTES.decideApproval.capability, "approval:decide");
  assert.equal(HTTP_ROUTES.documents.capability, "artifact:read");
});

test("realtime envelopes carry normalized harness events", () => {
  const harnessEvent = createHarnessEvent(
    "run_demo",
    0,
    "2026-01-01T00:00:00.000Z",
    {
      type: "run.state",
      state: "running",
    },
  );
  const envelope = makeRealtimeEnvelope({
    eventId: "event_demo",
    workspaceId: "workspace_demo",
    sequence: 8,
    occurredAt: "2026-01-01T00:00:00.000Z",
    type: "harness.event",
    data: harnessEvent,
  });
  assert.deepEqual(parseRealtimeEnvelope(envelope), envelope);
});
