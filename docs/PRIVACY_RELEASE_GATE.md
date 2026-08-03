# Privacy and Public Release Gate

The public target is `replicantos/replicantos`, licensed MIT. ReplicantOS is
free, open-source, self-hosted software. `replicantos.com` is a static marketing,
documentation, and installation site; no hosted application or SaaS offering is
part of this release.

The release requirement is zero **known** personal or private data in the source
tree, reachable Git history, dependency evidence, screenshots, documentation,
or metadata. Automated detection reduces risk but does not replace manual
judgment. Two independent reviews are the default; the repository owner may
explicitly waive only that review-count requirement in a HEAD-bound record that
does not assert any independent review occurred.

## Private denylist

Normal development runs `pnpm privacy:check` without private terms so public CI
does not need private information. Release mode additionally requires a nonempty
UTF-8 denylist outside the repository. Each non-comment line of at least three
characters is matched case-insensitively after Unicode normalization.

Supply its path through `REPLICANTOS_PRIVATE_TERMS_FILE`. The scanner refuses a
release denylist stored anywhere inside the repository, including through a
symlink. Findings show a one-way hint and redact a matching location; they never
echo a private term.

## Source and history scan

`scripts/privacy-check.mjs` checks the working tree for:

- secret-shaped values, non-project email addresses, and user-home paths
- external private terms
- runtime state, environment files, credentials, archives, databases, logs,
  media, symlinks, and unexpected binaries
- PNG text, EXIF, timestamp, profile, and unapproved extension chunks

Release mode also enumerates every Git ref, every reachable commit and annotated
tag, and every path in every reachable tree. It checks author, committer, and
tagger identities against `privacy/allowed-authors.json`, scans commit and tag
messages, and reads deleted as well as current blobs. A clean tip cannot hide a
private value in an older reachable object.

Only root runtime-state directories are ignored by Git and forbidden by policy.
Source directories such as `packages/runtime/` are scanned normally.

## Deterministic synthetic media

There is no `fixtures/demo/` directory. The deterministic database seed lives in
`packages/db/src/demo-seed.ts`. The offline screenshot presentation lives in
`apps/web/src/demo.ts` and is opened with `?demo=1` by
`tests/e2e/specs/capture.spec.ts`. Before each capture,
`tests/e2e/support/privacy.ts` checks rendered DOM text against the public
synthetic-data rules. Raw Playwright output stays under ignored `artifacts/`.

After visual review, run `pnpm screenshots:promote`. The promotion command:

1. requires an explicit promotion environment flag;
2. accepts only the ten ordered names in `privacy/screenshot-policy.json`;
3. enforces 1600×900 desktop frames and the 390×844 mobile frame;
4. validates PNG structure and CRCs;
5. strips recognized textual, EXIF, time, color-profile, and other metadata;
6. rejects unknown PNG chunks rather than guessing whether removal is safe; and
7. writes deterministic files and a SHA-256 manifest to `launch/screenshots/`.

The command is idempotent when output matches and refuses to overwrite differing
reviewed output. `pnpm launch:check -- --release` verifies the files, dimensions,
metadata, manifest, hashes, post copy, and alt text.

Code-generated PWA icons and static social cards are permitted only under the
approved web/site asset roots and pass the same PNG-chunk inspection. The
current social-card PNG is generated locally from repository-owned sources.

## Dependency evidence

`pnpm security:audit` runs the registry vulnerability audit at high severity and
does not ignore registry failures. `pnpm release:artifacts` generates two stable,
path-free JSON artifacts:

- `licenses.json`, a sorted license inventory bound to the lockfile and policy
- `sbom.cdx.json`, a deterministic CycloneDX 1.6 software bill of materials

Both omit timestamps, serial numbers, installation paths, package-author fields,
and other host-specific values. The generator fails when a license is absent or
outside `privacy/license-policy.json`.

The generator asks pnpm for non-optional license declarations, then requires
every optional lockfile node to match an exact-version declaration in the
reviewed policy. This avoids pnpm's platform-specific store scan while still
failing closed when any optional package or declaration changes.

The optional Claude Agent SDK and its native packages ship proprietary terms
without an SPDX declaration. The policy maps only version `0.3.220` to
`LicenseRef-Anthropic-Claude-Agent-SDK-Terms`; upgrades fail closed. It is not
installed in the base MIT checkout. If a derived release opts into it, each
release reviewer—or the repository owner in the waiver path—must explicitly
accept the exception found in that release's generated inventory.
Platform-specific packages with SPDX licenses are also exact-version locked so
cross-platform SBOM output does not depend on the audit machine.

## Archive verification

Release reviewers and owners need evidence before recording a disposition.
`pnpm release:preflight` therefore runs the same clean-HEAD archive, privacy,
frozen-install, verification, Chromium, launch-media, vulnerability, license,
and SBOM checks without accepting a disposition or authorizing publication. It
still requires the external private denylist and an explicit preflight
environment guard, and it writes a manifest with `reviewStatus: "pending"`
under ignored `artifacts/release-preflight/` by default. The final verifier
repeats the audit after the release disposition is complete.

`pnpm release:verify` runs only when
`REPLICANTOS_ALLOW_RELEASE_VERIFY=1` is set intentionally. It requires:

- a clean committed `HEAD` with the MIT `LICENSE` file;
- the external nonempty private denylist;
- an external release-disposition JSON file bound to the exact `HEAD`;
- a closed credential-exposure disposition confirming either no known exposure
  or rotation of every known exposed credential; and
- confirmation that the publication operator is authorized for the
  `replicantos` GitHub namespace; and
- either two distinct reviewers completing every privacy, media, distribution,
  and dependency-license attestation, or an explicit repository-owner waiver
  of only that two-reviewer requirement.

The verifier scans the working tree and complete Git graph, creates a Git archive
of `HEAD`, extracts it to a fresh temporary directory, rescans the archive, runs
a frozen install, the full verifier, Chromium end-to-end tests, release launch
validation, the vulnerability audit, and dependency-artifact generation. It
emits a source archive, license inventory, SBOM, and hash manifest under ignored
`artifacts/release-audit/` by default. Child commands receive an allowlisted
environment so unrelated credentials are not propagated into builds or tests.

Use `release/approvals.example.json` for the default independent-review path or
`release/waiver.example.json` for the explicit owner-waiver path. The completed
record must remain outside Git and must never contain credentials or denylist
terms. A waiver requires an empty reviewer array and is reported as
`reviewStatus: "owner-waived"`; it does not waive the denylist, privacy/history,
media, credential, namespace, dependency, browser, or archive checks.

## CI policy

Pull-request CI has only `contents: read`, receives no repository secrets, uses a
full-history checkout, and runs verification, browser tests, vulnerability
audit, and deterministic dependency evidence. The manual release audit is the
only workflow that consumes the two release-policy secrets and is bound to the
protected `public-release` environment.

Every third-party action is pinned to a full commit SHA. Reviewed versions,
official release sources, and SHAs are recorded in
`privacy/github-actions-policy.json`; `pnpm ci:policy` rejects floating or
unapproved action references and elevated workflow permissions.

## Release completion criteria

Publication is authorized only after all of the following are true:

- the clean-room tree has a committed, clean release `HEAD` using
  `ReplicantOS <admin@replicantos.com>`;
- the public application shell and launch media pass an approved visual-parity
  review against the ReplicantOS interaction language without copying private
  source code, assets, data, fixtures, configuration, history, or metadata;
- all ten screenshots have been promoted and manually reviewed;
- credential exposure has been reviewed and either no known credential was
  exposed or every known exposed credential has been rotated;
- two external approvals are complete and bound to `HEAD`, or the repository
  owner has recorded the explicit HEAD-bound two-reviewer waiver; and
- the publication operator is authorized to create the repository in the
  `replicantos` GitHub namespace; and
- the manual archive verifier passes without exceptions.
