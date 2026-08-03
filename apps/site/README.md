# ReplicantOS public site

A static landing and documentation site deployed through Vercel. Its interface
illustrations are deterministic synthetic HTML and CSS; its first-party visual
assets are local SVG and generated PNG files.

## Commands

```sh
pnpm --filter @replicantos/site lint
pnpm --filter @replicantos/site typecheck
pnpm --filter @replicantos/site test
pnpm --filter @replicantos/site build
pnpm --filter @replicantos/site dev
```

The build recursively copies `src/` to `dist/`, injects the confirmed public
destinations from `site.config.mjs`, and copies the canonical shared CSS tokens
from `@replicantos/ui`. No request is made during the build.

Before release, review the confirmed repository and documentation destinations
in `site.config.mjs`. The default browser policy in `src/_headers` blocks all
client-side network connections, frames, forms, and third-party assets. There
is no telemetry script or external font.

For production, connect the public repository to Vercel with the repository
root as the root directory. The committed root `vercel.json` performs a frozen
workspace install, builds only `@replicantos/site`, publishes `apps/site/dist`,
and applies the same restrictive security and cache headers used by the static
site. Attach `replicantos.com` only after Vercel confirms domain ownership and
the required DNS records resolve.
