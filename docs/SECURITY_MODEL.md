# Security Model

## Trust boundary

ReplicantOS is designed for a dedicated non-root operating-system user on a trusted self-hosted machine or VM. Agent harnesses can execute tools, so the host account and its approved workspace roots are the outer security boundary.

Authentication protects the ReplicantOS product from other users; it does not turn an untrusted host into a safe execution environment.

## Default roles

- **Owner:** installation policy, users, access policy, and all implemented workspace resources; the operator remains responsible for offline backups and provider-supported host credentials
- **Admin:** workspace administration without ownership transfer
- **Member:** explicitly granted channels, Replicants, tasks, schedules, files, and documents
- **Service:** non-interactive actor record that can receive bounded explicit grants but has no v0.1 authentication path or login UI

No role bypasses resource checks merely because it can connect to the HTTP or WebSocket service.

## Implemented privileged capabilities

These capabilities default to owner/admin and can be narrowed further:

- File mutation
- Database inspection
- User and access administration
- Schedule creation and Run Now
- Approval of external or destructive actions
- Run cancellation

The protocol reserves capabilities for terminal execution, managed credentials,
workspace transfer, backup, restore, update, and export. ReplicantOS v0.1 does
not expose those operations or persist provider credentials.

## Required controls

- Password hashing with a memory-hard algorithm
- Opaque revocable session tokens stored only as hashes server-side
- HTTP-only, same-site cookies, `Secure` cookies for HTTPS deployments, and explicit Origin validation
- Strict CORS allowlist and authenticated WebSocket upgrade
- Rate limits for login, account creation, and privileged mutations
- Resource authorization at query and mutation time; any future resource-event fan-out must re-evaluate visibility before delivery
- Realpath-based filesystem containment and symlink escape rejection
- SQLite table allowlist, protected-column masking, fixed parameterized projections, row limits, and a read-only `query_only` connection for the viewer; there is no user-supplied SQL parser or endpoint
- No provider credentials stored by the v0.1 baseline; any future managed
  credential store must require encryption with a key outside SQLite
- Append-only audit records for access-policy and privileged-operation changes
- Approval records bound to the actor, exact action digest, expiration, and one-time use

## Non-goals

- Safely executing arbitrary untrusted code on the same host without OS/container isolation
- Exposing ReplicantOS directly to the public internet without TLS, firewalling, and deployment hardening
- Treating regex command filters as a complete sandbox
