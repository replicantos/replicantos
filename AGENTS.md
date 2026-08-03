# ReplicantOS Contributor Instructions

These instructions apply to the entire repository.

## Non-negotiable privacy boundary

- This repository is a clean-room public codebase. Do not copy Git history, runtime data, reports, personas, messages, uploads, logs, databases, browser profiles, voice assets, environment files, or configuration from any private ReplicantOS installation.
- Reimplement or port source one module at a time only after reviewing it for product-specific behavior, personal data, secrets, absolute paths, customer names, private domains, and hard-coded identifiers.
- Fixtures and screenshots must be generated from the deterministic synthetic demo workspace in this repository. Use reserved domains such as `example.invalid`; never use a real person's identity.
- Do not add personal names, personal email addresses, workstation paths, credentials, tokens, customer data, or production identifiers to source, tests, documentation, commit messages, or media metadata.
- Never commit `.env` files, runtime SQLite files, archives, logs, backups, authentication stores, or generated browser state.
- A public release must pass `pnpm privacy:check` against both the working tree and a fresh clone of the proposed release commit.

## Product boundary

- ReplicantOS v1 is a self-hosted, single-workspace application with multiple users and multiple Replicants.
- SQLite is the v1 source of truth. Code must preserve a future storage boundary without pretending PostgreSQL is currently supported.
- Harness-specific behavior belongs in `packages/harnesses`. Product code consumes only the normalized harness contract.
- Authorization is enforced server-side for HTTP, WebSocket, file, database, task, schedule, and harness operations. UI hiding is never an authorization control.
- Terminal, file mutation, database inspection, credential management, and administrative scheduling are privileged capabilities and default to owner/admin access.
- No telemetry is enabled by default.

## Engineering expectations

- Read nearby code before changing it and use `rg` for search.
- Keep modules small and dependency direction explicit: apps depend on packages; core domain code does not depend on app code.
- Add or update tests for behavior and authorization boundaries. Every fixed security bug needs a regression test.
- Use real filesystem containment checks (`realpath` plus `path.relative`), not string-prefix checks.
- Mask protected columns and allowlist tables in the database viewer.
- Prefer explicit failure over silently weakening permissions, sandboxing, authentication, or validation.
- Run the smallest relevant checks while iterating, then run `pnpm verify` before committing.

## Git hygiene

- Keep this repository's history independent from every private source repository.
- Use a non-personal ReplicantOS maintainer identity for commits intended for publication.
- Do not make the repository public until credential exposure is reviewed, the disposition confirms either no known exposure or rotation of every known exposed credential, and the release checklist has two independent approvals.
- Keep commits focused and do not mix generated launch media with unrelated product changes.
