# Public Product Contract

Status: released as `v0.1.0`; this document defines the supported public v0.1 product boundary.

## Product promise

ReplicantOS is a self-hosted control plane for persistent AI agents. One installation hosts one workspace. A workspace can contain multiple human users, Replicants, channels, tasks, schedules, files, and approved documents.

ReplicantOS is free and open-source under the MIT License. The project does not host customer workspaces or offer a ReplicantOS SaaS. `replicantos.com` is limited to public product information, documentation, and installation guidance.

ReplicantOS does not call model APIs through one proprietary abstraction. Its production server composes each adapter's declared supported capability subset behind a shared durable run lifecycle while credentials remain in provider-supported host mechanisms.

## Public v0.1 contract

### Identity and access

- First-run owner creation with no default credential
- Human owner, admin, and member roles
- Explicit channel read/write, Replicant view/interact, and privileged-feature grants
- Server-side authorization for every protected HTTP, realtime-connection, file, database, task, schedule, and run operation; v0.1 does not broadcast resource changes
- Revocable server-side sessions and an immutable permission audit trail

### Replicants and harnesses

- Multiple Replicants with separate personas and dedicated logical workspace directories; each Replicant's durable memory is nested inside its workspace
- Authorized channel messages enqueue bound Replicants and preserve provider-session continuity
- Final Replicant replies are stored in the channel; v0.1 does not promise token-by-token live UI streaming
- Per-Replicant default harness
- Stable Codex and optional Claude Agent SDK adapters plus beta OpenCode and Grok Build adapters behind one capability-aware contract; provider runtimes are not bundled
- Durable run state, normalized adapter events, retry, session continuity, and bounded diagnostics
- Provider session identifiers are protected control-plane state used for continuity and are omitted from public run and event projections
- ReplicantOS v0.1 does not persist provider credentials

### Collaboration and work

- Persistent channels and permission-checked human and Replicant messages
- Durable task records with status, priority, notes, and optional Replicant assignee; the create API and form persist notes, while the v0.1 board renders status, priority, and assignee
- Scheduled jobs with timezone-aware cron, Replicant selection, Run Now, retry, and basic execution history

### Inspectability and operations

- Safe-root file browsing and editing with symlink-safe containment
- UTF-8 source editing within approved file roots
- Approved Markdown/text metadata indexing with hash-verified raw preview
- Admin-only SQLite viewer with table allowlists, column masking, row limits, and no arbitrary SQL
- Durable run history and detail with bounded normalized events, persisted assistant output, usage projections, and retry records
- Responsive installable PWA

## Run control and diagnostics

- Authenticated Runs API and UI for history, detail, pending approvals, action-bound approval decisions, and authorized cancellation requests
- On-demand Settings diagnostics for all four adapter manifests
- Command-adapter diagnostics that verify executable and version discovery, not provider login validity
- Claude diagnostics that report optional SDK availability and whether a supported host authentication mode is configured without returning credential values
- Deterministic full-stack browser coverage for dispatch, provider-session resume, schedules, run history, cancellation, approval decisions, diagnostics, permissions, and persistence

## Explicitly deferred

- Service-account credentials and authentication
- Human threaded-reply UI, reactions, attachments, tags, message search, unread state, and automated collaboration notifications
- Token-by-token live agent streaming in the web UI
- Outcome assertions, failure/recovery alerts, and pause/recover controls
- Task-detail and editing UI, projects, due-date UI, human-assignment UI, task execution, and linked run history; some underlying fields already exist in storage and API contracts
- Document uploads, PDF or data-file rendering, generated-artifact workflows, and full-text content search
- Rendered Markdown preview and arbitrary SQL
- Browser terminal access
- Backup, restore, export, and update tooling
- Hosted multi-tenant SaaS and organization federation
- PostgreSQL and horizontal application scaling
- Native iOS or Android clients
- Voice and wake-word operation
- Built-in CRM, trading, health, media studio, or content publishing products
- Bundled customer-specific mail, ticketing, pricing, or identity integrations
- Connector marketplace and inter-instance orchestration

## Release invariants

- No personal data, private source history, customer material, real credentials, personal commit metadata, or workstation paths
- No public screenshot may originate from a live or private installation
- No telemetry by default
- No privileged operation authorized only by client-side UI state
- No table, file path, workspace, protected resource, or future resource event visible without server-side authorization
- No release until a clean clone passes the complete verification pipeline
