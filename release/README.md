# Public release evidence

ReplicantOS is released from `replicantos/replicantos` under MIT as free,
open-source, self-hosted software. The public site is static marketing,
documentation, and install guidance; the release does not include a hosted app
or SaaS service.

`pnpm release:verify` is intentionally fail-closed. It requires two files that
must remain outside the repository:

- a nonempty private denylist, supplied with
  `REPLICANTOS_PRIVATE_TERMS_FILE`
- a JSON approval record, supplied with
  `REPLICANTOS_RELEASE_APPROVALS_FILE`

Copy `approvals.example.json` to a private location, bind the top-level and both
reviewer `HEAD` fields to the exact proposed commit, and complete every
attestation only after review. The base MIT checkout has no dependency exception
that requires reviewer approval, so `reviewedLicenseExceptions` remains empty.
If a derived release installs the optional Claude Agent SDK, each reviewer must
list `anthropic-claude-agent-sdk-terms`; that records review of the SDK's
proprietary, non-SPDX terms and is not a project-license exception.

`githubNamespaceAuthorizationConfirmed` stays false until the publication
operator can create `replicantos/replicantos`; a namespace that merely exists is
not sufficient.

`credentialExposureDisposition` is intentionally closed to two reviewed values:
`no-known-credential-exposure` when the clean-room work exposed no credentials,
or `all-known-exposed-credentials-rotated` after every known exposed credential
has been rotated. Each reviewer must copy the selected value into
`reviewedCredentialExposureDisposition` after checking the evidence.

Before asking reviewers to sign, run `pnpm release:preflight` with
`REPLICANTOS_PRIVATE_TERMS_FILE` pointing to the external private denylist. The
preflight requires a clean committed `HEAD` and performs the complete archive,
privacy, frozen-install, verification, Chromium, vulnerability, launch-media,
license, and SBOM audit. It writes a source archive and a manifest marked
`reviewStatus: "pending"` under ignored `artifacts/release-preflight/`. It does
not consume approvals, authorize publication, or weaken the final release gate.

Set `REPLICANTOS_ALLOW_RELEASE_VERIFY=1` only for an intentional audit. The
verifier checks the complete Git graph, archives `HEAD`, extracts it to a fresh
temporary tree, runs a frozen install, verification and browser tests, audits
dependencies, validates launch media, and emits deterministic evidence under
the ignored `artifacts/release-audit/` directory by default.

The approval record confirms the reviewed credential-exposure disposition; it
must never contain credentials or the private denylist itself.
