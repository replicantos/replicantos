# `@replicantos/protocol`

The only public wire contract shared by ReplicantOS clients, the server, core
packages, and harness adapters. The package has no runtime dependencies.

## Stable exports

- `PROTOCOL_VERSION`, `API_V1_PREFIX`, and `REALTIME_SUBPROTOCOL`
- `HTTP_ROUTES` and `HttpContract` for canonical v1 HTTP resources
- `ApiEnvelope`, `parseApiEnvelope`, `success`, and `failure`
- `RealtimeEnvelope`, `makeRealtimeEnvelope`, and `parseRealtimeEnvelope`
- `HarnessAdapter`, `HarnessManifest`, `HarnessCapabilities`, and run inputs
- `HarnessEvent`, `HarnessEventDraft`, `createHarnessEvent`, and
  `parseHarnessEvent`
- Public resource types from `resources.ts`
- The canonical `permissions` list, `Permission`, and `isPermission`

HTTP resources are versioned by the `/api/v1` path and contain exactly one of
`data` or `error`. Successful message creation also returns top-level
`meta.dispatch` describing whether bound Replicant runs were queued. Harness and
realtime envelopes include the literal protocol version `1`; their parsers
reject unknown versions and non-JSON payloads.

A realtime connection must use the `replicantos.v1` subprotocol. The v0.1
server authenticates and periodically revalidates that connection, sends one
`presence.updated` frame, and otherwise refreshes durable resources over HTTP
polling. The wider realtime event union is a forward-compatible schema, not a
claim that resource-event fan-out is implemented; any future delivery must
re-evaluate authorization for each recipient.

Provider-native payloads are deliberately absent. Harness packages translate
them into the normalized event union before product code can observe them.

Public roles, permissions, task/schedule/run/approval states, and resource
shapes are compatibility-checked against `@replicantos/core`. Core is the
public v0.1 product source of truth; the wire protocol uses literal version `1`,
and wire IDs and timestamps are represented as strings.
