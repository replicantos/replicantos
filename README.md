# ReplicantOS

Your AI agents. One operating system.

ReplicantOS is a self-hosted control plane for persistent AI agents. It brings multiple users, multiple Replicants, and multiple agent harnesses into one inspectable workspace with channels, tasks, schedules, files, documents, and explicit permissions.

The public edition is free and open-source under the MIT License. ReplicantOS does not host user workspaces or provide a SaaS; installations run on infrastructure controlled by their operators.

> This clean-room public edition is under active development. The source-build path below is available for review, but it is not a supported tagged release until the public release gate closes.

## Install from source

ReplicantOS runs on your own host; `replicantos.com` does not host workspaces or an application service. The current installation path uses Node.js 22 or newer and the pnpm version pinned by this repository:

```sh
git clone https://github.com/replicantos/replicantos.git
cd replicantos
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
pnpm build
pnpm run doctor
pnpm start
```

Open `http://127.0.0.1:8787` and create the first owner. There is no default account or password. `pnpm start` verifies existing dependency and build artifacts; it never installs or builds silently.

The default listener is loopback-only HTTP. For access beyond the host, keep the listener on loopback, terminate TLS at a same-host reverse proxy, and set `REPLICANTOS_ALLOWED_ORIGINS` to the one exact public HTTPS origin. Plain HTTP network exposure is rejected by the operator entrypoint.

See [Installation and operation](docs/INSTALLATION.md) for configuration, reverse-proxy, data-root, harness, and update guidance.

## Public v0.1 surface

- Persistent, permission-checked channels where an authorized message can enqueue a bound Replicant, resume its provider session, and store its final reply
- Human owner, admin, and member roles with scoped allow and deny grants enforced on the server
- Multiple Replicant personas with dedicated workspace directories and durable memory nested inside each workspace
- Codex and optional Claude Agent SDK adapters marked stable, plus beta OpenCode and Grok Build adapters, composed into one durable runtime; provider runtimes are installed separately on the host
- Timezone-aware cron schedules with retries, Run Now, and basic execution history
- Durable task records with status, priority, notes, and optional Replicant assignment; the v0.1 board displays status, priority, and assignee
- A safe-root UTF-8 file editor, an approved Markdown/text metadata index with hash-verified raw preview, and a masked allowlisted SQLite viewer
- Authenticated run history and detail with bounded normalized events, persisted output and usage, approval decisions, cancellation requests, and on-demand harness diagnostics
- A responsive, installable PWA with no telemetry enabled by default

Command-adapter diagnostics verify executable and version discovery; they do not prove that a provider login is valid. Claude diagnostics separately check that the optional SDK and a supported host authentication mode are present. Provider session identifiers are retained only in protected control-plane state for continuity and are omitted from public run projections and event payloads.

Service-account authentication, extended chat features, token-by-token UI streaming, outcome assertions and recovery alerts, task execution history, uploads and PDF rendering, arbitrary SQL, browser terminal access, and backup/restore/export/update tooling are outside the v0.1 contract.

## Repository layout

```text
apps/
  server/       HTTP, WebSocket, scheduling, and runtime composition
  site/         Static replicantos.com marketing and documentation site
  web/          Authenticated ReplicantOS web application
packages/
  core/         Domain services and authorization policy
  db/           Consolidated SQLite schema and repositories
  harnesses/    Normalized agent harness contract and adapters
  protocol/     Shared API and realtime event schemas
  ui/           Shared design tokens and UI primitives
```

The deterministic database seed is `packages/db/src/demo-seed.ts`; the offline, screenshot-only presentation is `apps/web/src/demo.ts`. There is no `fixtures/demo/` directory.

Architecture, security, and release invariants are documented in [`docs/`](docs/).

## Development status

The source-build operator flow and deterministic live browser journey—including runtime dispatch, approvals, cancellation, diagnostics, permissions, and persistence—are implemented. Publication remains gated on a clean committed release `HEAD`, the clean-clone archive verifier, ten reviewed and promoted screenshots, a reviewed credential-exposure disposition, and two independent `HEAD`-bound release reviews documented in [`docs/PRIVACY_RELEASE_GATE.md`](docs/PRIVACY_RELEASE_GATE.md).
