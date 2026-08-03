# Contributing to ReplicantOS

Thanks for helping make self-hosted agent work easier to inspect and control.

## Before you start

- Use an issue for substantial features, security-boundary changes, or public
  API changes so the direction can be agreed before a large patch.
- Do not submit customer data, private prompts, real credentials, private
  source history, workstation paths, or screenshots from a live installation.
- Use synthetic identities and fixtures in tests, documentation, and images.
- Report vulnerabilities through the private process in
  [`SECURITY.md`](SECURITY.md), not a public issue.

## Local development

ReplicantOS requires Node.js 22 or newer and the pnpm version declared in
`package.json`.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm verify
pnpm test:e2e
```

Run `pnpm dev` for the server and web app. Keep changes focused, add tests for
behavioral changes, and preserve fail-closed authorization and filesystem
containment.

## Pull requests

Explain the user-visible outcome, the security or privacy impact, and how the
change was verified. By contributing, you agree that your contribution is
licensed under the repository's MIT License.
