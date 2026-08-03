# Architecture

## Dependency direction

```text
apps/web  ─────────> packages/protocol
      └───────────> packages/ui
apps/site --build-> packages/ui tokens

apps/server ──────> packages/protocol
       │           packages/core
       │           packages/db
       │           packages/runtime
       └─────────> packages/harnesses

packages/db   ───> packages/core and packages/runtime ports
packages/runtime -> packages/protocol and packages/harnesses
packages/harnesses -> packages/protocol

packages/core, packages/protocol, and packages/ui have no internal runtime dependencies
```

Application composition belongs in `apps/server`. Domain policy must not import Fastify, React, a database driver, or a provider SDK.

## Runtime model

- One server process owns the SQLite connection, scheduler leadership, active harness-run registry, and authenticated realtime endpoint.
- SQLite runs in WAL mode with foreign keys, a busy timeout, versioned migrations, and explicit transactions.
- The web application consumes versioned HTTP resources. Channel messages poll durable state every 2.5 seconds and active run detail polls every 3 seconds. The v0.1 WebSocket reports authenticated connection presence only; it does not fan out resource changes or stream provider tokens.
- Every protected request resolves an authenticated actor and evaluates server-side policy before repository or harness access. Health, bootstrap status, initial bootstrap, and login are intentionally public endpoints with their own validation and rate limits.
- Enabled schedules are durable authorized resources. Their runs retain the
  schedule creator as the requesting identity for audit; the scheduler does not
  impersonate an owner or bypass resource creation policy.

## Harness boundary

Every adapter implements the same lifecycle while advertising its capabilities. Unsupported behavior is explicit and never simulated.

```ts
interface HarnessAdapter {
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
```

Normalized events cover run state, assistant text deltas, reasoning summaries when available, tool lifecycle, approval requests, file changes, usage, recoverable warnings, and terminal failures. Only bounded normalized projections enter durable storage; raw provider event objects are neither part of the public protocol nor a v0.1 persistence contract.

Provider session identifiers are stored in protected run state when an adapter supplies one so a later eligible channel-triggered run can resume that provider session. Public run projections omit the identifier, and public event payloads redact session, prompt, system-prompt, thread, and working-directory fields.

Implemented integration paths:

- Codex: local app-server JSON-RPC over stdio for threads, turns, approvals, and streamed events
- Claude: Claude Agent SDK with explicit setting sources and permission callbacks
- OpenCode: `opencode acp` over ACP v1 stdio
- Grok Build: `grok --no-auto-update agent stdio` over ACP v1 stdio

## Data ownership

- The database stores identity, access policy, channels, messages, task metadata, schedules, run metadata, approvals, notifications, and artifact indexes.
- Each Replicant receives a dedicated logical directory beneath the configured approved workspace root, with its durable memory nested inside that directory. Persona configuration remains in the control-plane database and is supplied to each run as bounded system instructions. Harnesses still execute as the ReplicantOS host account; these directories do not create operating-system or container isolation.
- The document library indexes only explicitly selected Markdown or text files inside its configured library root. Hidden and unsafe paths are rejected, but operators remain responsible for choosing a root that does not contain source, credentials, authentication stores, or backups.
- ReplicantOS v0.1 does not persist provider credentials. Adapters consume only their explicitly allowlisted provider-supported host environment and configuration mechanisms.
