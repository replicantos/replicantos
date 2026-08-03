# Installation and operation

ReplicantOS is free, MIT-licensed, and entirely self-hosted. One installation runs one workspace on infrastructure controlled by its operator. `replicantos.com` is only the project’s static marketing, documentation, and installation site; it does not host ReplicantOS accounts, data, or agent runs.

> **Pre-release status:** this source-build path is implemented for review, but it is not a supported tagged release until the public release gate closes. Do not expose a pre-release installation to untrusted networks.

## Requirements

- A dedicated, non-root host account
- Git
- Node.js 22 or newer, including Corepack
- Enough local storage for the SQLite database, approved files, and provider output
- Any harness runtimes you intend to use, installed with their provider-supported host credentials or identity mechanism

Ubuntu is the primary production target. macOS is supported for development. Docker is not required: host-native operation lets ReplicantOS use local harness runtimes and provider-supported host configuration without copying provider credentials into a container or the ReplicantOS database.

## Build once, start explicitly

The public repository destination is fixed. Before the release gate closes it may be unavailable or contain only pre-release source.

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

Open `http://127.0.0.1:8787`. The first-run screen presents local owner setup; submitting that form creates the owner account. ReplicantOS ships with no default user, email address, or password.

`pnpm start` is deliberately unsurprising: it loads the optional local `.env`, validates the Node.js version and production configuration, verifies installed dependencies and compiled server, web, and runtime artifacts, checks that the data location is writable, and then starts the compiled server. It does not run an installer, contact a provider, build source, or repair missing artifacts. Run `pnpm run doctor` at any time for the same read-only readiness checks.

The operator `pnpm run doctor` checks host configuration, build artifacts, and data-directory readiness; it does not probe agent providers. Authenticated Settings diagnostics inspect the four adapters on demand. Codex, OpenCode, and Grok checks discover an executable and read its version, which does not prove provider authentication. Claude diagnostics check the optional SDK and the presence of a supported host authentication mode without returning or persisting credential values.

## Secure defaults

The committed `.env.example` contains configuration only—never credentials—and starts with these boundaries:

| Setting                       | Default                 | Boundary                                                                |
| ----------------------------- | ----------------------- | ----------------------------------------------------------------------- |
| `REPLICANTOS_HOST`            | `127.0.0.1`             | The bundled server remains loopback-only.                               |
| `REPLICANTOS_PORT`            | `8787`                  | The local HTTP listener port.                                           |
| `REPLICANTOS_ALLOWED_ORIGINS` | `http://127.0.0.1:8787` | Exact browser origin; no wildcard, path, or trailing slash.             |
| `REPLICANTOS_DATA_DIR`        | `./data`                | Resolved from the repository root, independent of the launch directory. |

With the default data directory, ReplicantOS stores its SQLite control plane at `data/replicantos.sqlite`, editable workspace files at `data/files/workspace`, and library documents at `data/files/library`. Runtime data, databases, and `.env` are ignored by Git. Back up the complete data directory only while the server is stopped until the supported backup workflow lands.

`REPLICANTOS_WORKSPACE_ROOT` and `REPLICANTOS_LIBRARY_ROOT` may point at different operator-owned locations. Overrides must be absolute, distinct, and non-overlapping. File and document APIs still enforce their safe-root, real-path, hidden-path, symlink, hard-link, and size boundaries.

## Public HTTPS through a reverse proxy

The ReplicantOS process serves plain HTTP and intentionally stays on loopback. For network access, place a TLS-terminating reverse proxy on the same host:

1. Keep `REPLICANTOS_HOST=127.0.0.1`.
2. Set `REPLICANTOS_ALLOWED_ORIGINS` to the browser-facing canonical HTTPS origin, for example `https://agents.example.invalid`. Replace the reserved example domain with the operator’s real domain.
3. Proxy that HTTPS origin to `http://127.0.0.1:8787` and preserve WebSocket upgrades for `/api/v1/realtime`.
4. Do not publish the loopback upstream through a second plain-HTTP listener.
5. Run `pnpm run doctor` before restarting.

The value is an origin, not a URL prefix: it contains the scheme, hostname, and optional port, but no path, query, fragment, credentials, wildcard, or trailing slash. HTTPS origins receive `Secure`, `HttpOnly`, `SameSite=Strict` session cookies. The operator entrypoint rejects non-loopback listeners, non-loopback HTTP origins, mixed HTTP/HTTPS origin sets, and mismatched loopback ports.

The v0.1 WebSocket authenticates the session, reports connection presence, and revalidates the session periodically. Durable messages and active run detail refresh over bounded HTTP polling; resource-event fan-out and token-by-token UI streaming are not implemented.

## Harness credentials

Install only the harness runtimes this workspace needs: Codex, the optional Claude Agent SDK, OpenCode, or Grok Build. Configure their provider-supported credential or identity mechanisms for the same dedicated host account that runs ReplicantOS.

The command-based Codex, OpenCode, and Grok adapters discover their executables from the dedicated account's `PATH`. The Claude Agent SDK is an optional peer and is deliberately not installed by the base MIT source checkout because its package carries separate terms. To opt into the reviewed adapter version, install it locally and review those terms first:

```sh
pnpm add --workspace-root --save-exact @anthropic-ai/claude-agent-sdk@0.3.220
pnpm build
pnpm run doctor
```

That command changes the local package manifest and lockfile; it does not send credentials to ReplicantOS. Keep the operator-specific change private unless its dependency license review is also included in a derived public release.

ReplicantOS does not seed credentials and `.env.example` contains none. The operator entrypoint forwards only an explicit set of host-runtime and provider variables; unrelated environment values do not cross into the server. Each harness applies a second, provider-specific allowlist before starting its own process. Never commit `.env`, provider login stores, tokens, or generated runtime state.

## Starting and stopping

Run the server in the foreground during evaluation:

```sh
pnpm run doctor
pnpm start
```

`SIGINT` and `SIGTERM` are forwarded to the server for graceful database shutdown. For unattended use after a supported release, run the same `pnpm start` command under the operating system’s service manager as the dedicated non-root account. Keep the working copy and data directory writable only by that account, and keep the reverse proxy separate from the ReplicantOS process.

## Updating a source build

Do not update a running installation in place. Stop the service, take an offline backup of the complete data directory, update the source to a reviewed tag, and repeat the frozen install, build, and doctor steps before starting again:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm run doctor
pnpm start
```

Until the first supported tag and migration compatibility policy are published, treat every pre-release update as potentially incompatible and test restoration on a separate host-owned copy.
