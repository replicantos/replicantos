# Public release evidence

ReplicantOS is released from `replicantos/replicantos` under MIT as free,
open-source, self-hosted software. The public site is static marketing,
documentation, and install guidance; the release does not include a hosted app
or SaaS service.

`pnpm release:verify` is intentionally fail-closed. It requires two files that
must remain outside the repository:

- a nonempty private denylist, supplied with
  `REPLICANTOS_PRIVATE_TERMS_FILE`
- a JSON release-disposition record, supplied with
  `REPLICANTOS_RELEASE_APPROVALS_FILE`

The default path is `approvals.example.json`: copy it to a private location,
bind the top-level and both reviewer `HEAD` fields to the exact proposed commit,
and complete every attestation only after review. An owner may instead copy
`waiver.example.json` and explicitly waive only the two-independent-reviewer
requirement. The waiver is bound to the exact proposed `HEAD`, requires
`approvals: []`, and produces `reviewStatus: "owner-waived"`; it does not claim
that an independent review occurred.

The base MIT checkout has no dependency exception that requires acceptance, so
the relevant exception list remains empty. If a derived release installs the
optional Claude Agent SDK, every reviewer—or the owner waiver—must list
`anthropic-claude-agent-sdk-terms`; that records acceptance of the SDK's
proprietary, non-SPDX terms and is not a project-license exception.

`githubNamespaceAuthorizationConfirmed` stays false until the publication
operator can create `replicantos/replicantos`; a namespace that merely exists is
not sufficient.

`credentialExposureDisposition` is intentionally closed to two values:
`no-known-credential-exposure` when the clean-room work exposed no credentials,
or `all-known-exposed-credentials-rotated` after every known exposed credential
has been rotated. Each reviewer must confirm the selected value. An owner waiver
must explicitly accept the same value.

Before reviewers sign or an owner records a waiver, run
`pnpm release:preflight` with
`REPLICANTOS_PRIVATE_TERMS_FILE` pointing to the external private denylist. The
preflight requires a clean committed `HEAD` and performs the complete archive,
privacy, frozen-install, verification, Chromium, vulnerability, launch-media,
license, and SBOM audit. It writes a source archive and a manifest marked
`reviewStatus: "pending"` under ignored `artifacts/release-preflight/`. It does
not consume a disposition, authorize publication, or weaken the final release
gate.

Set `REPLICANTOS_ALLOW_RELEASE_VERIFY=1` only for an intentional audit. The
verifier checks the complete Git graph, archives `HEAD`, extracts it to a fresh
temporary tree, runs a frozen install, verification and browser tests, audits
dependencies, validates launch media, and emits deterministic evidence under
the ignored `artifacts/release-audit/` directory by default.

The external record confirms the credential-exposure disposition and selected
review path; it must never contain credentials or the private denylist itself.
An owner waiver changes no automated invariant: the denylist, tree and history
scans, media checks, credential and namespace dispositions, dependency evidence,
Chromium tests, and clean-archive audit all remain mandatory.
