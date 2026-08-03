import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const siteRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const readSource = (relativePath) =>
  readFile(path.join(siteRoot, "src", relativePath), "utf8");
const readAsset = (relativePath) =>
  readFile(path.join(siteRoot, "src", relativePath));
const repositoryRoot = path.resolve(siteRoot, "../..");

const [html, docsHtml, css, manifest, sitemap, vercelConfigSource] =
  await Promise.all([
    readSource("index.html"),
    readSource("docs/index.html"),
    readSource("styles/site.css"),
    readSource("manifest.webmanifest"),
    readSource("sitemap.xml"),
    readFile(path.join(repositoryRoot, "vercel.json"), "utf8"),
  ]);
const vercelConfig = JSON.parse(vercelConfigSource);

test("the landing page states the complete public capability story", () => {
  for (const expected of [
    "Codex",
    "Claude Agent SDK",
    "OpenCode",
    "Grok Build",
    "Persistent",
    "Schedules",
    "Team",
    "Inspectability",
    "Security",
    "No telemetry",
  ]) {
    assert.match(html, new RegExp(expected, "iu"));
  }
});

test("public copy matches the implemented pre-release surface", () => {
  const publicCopy = `${html}\n${docsHtml}`;
  assert.match(html, /PUBLIC V0\.1 PRE-RELEASE/u);
  assert.match(html, /SYNTHETIC RUN DETAIL/u);
  assert.match(html, />\s*runs · ALLOWLIST · LIMIT 50/u);
  assert.match(html, /on-demand provider\s+diagnostics/iu);
  assert.match(docsHtml, /One lifecycle\. Four adapters\./u);
  assert.match(docsHtml, /Claude Agent SDK is\s+optional/iu);
  assert.match(docsHtml, /BETA \/ ACP STDIO/u);
  assert.doesNotMatch(publicCopy, /FOUNDATION 00\.1/iu);
  assert.doesNotMatch(publicCopy, /INTEGRATION PREVIEW/iu);
  assert.doesNotMatch(publicCopy, /\brun_index\b/iu);
  assert.doesNotMatch(publicCopy, /credential[- ]rotation/iu);
  assert.match(docsHtml, /credential-exposure/iu);
  assert.doesNotMatch(publicCopy, /isolated Replicant workspaces/iu);
  assert.doesNotMatch(
    publicCopy,
    /approval[^.]*cancellation[^.]*still (?:being )?(?:completed|completing)/iu,
  );
});

test("the documentation destination is a real, status-honest first-party page", () => {
  assert.match(docsHtml, /<html\s+lang="en"/u);
  assert.match(docsHtml, /id="concepts"/u);
  assert.match(docsHtml, /id="access"/u);
  assert.match(docsHtml, /id="harnesses"/u);
  assert.match(docsHtml, /id="data-boundaries"/u);
  assert.match(docsHtml, /id="installation"/u);
  assert.match(docsHtml, /pnpm run doctor/u);
  assert.match(docsHtml, /not\s+a\s+supported tagged release/iu);
  assert.match(docsHtml, /release gate is still open/iu);
  assert.doesNotMatch(docsHtml, /ready for production/iu);
  assert.match(sitemap, /https:\/\/replicantos\.com\/docs\//u);
});

test("the landing page presents an honest self-hosted installation path", () => {
  assert.match(html, /id="install"/u);
  assert.match(
    html,
    /git clone https:\/\/github\.com\/replicantos\/replicantos\.git/u,
  );
  assert.match(html, /pnpm install --frozen-lockfile/u);
  assert.match(html, /pnpm build/u);
  assert.match(html, /pnpm run doctor/u);
  assert.match(html, /pnpm start/u);
  assert.match(html, /never hosts a\s+workspace or agent session/iu);
  assert.match(html, /PRE-RELEASE SOURCE PATH/u);
  assert.doesNotMatch(html, /cloud-hosted|managed workspace|sign up/iu);
});

test("all runtime resources are first-party", () => {
  assert.doesNotMatch(html, /<(?:script|img)[^>]+(?:src)=["']https?:/iu);
  assert.doesNotMatch(
    html,
    /<link[^>]+rel=["'](?:stylesheet|preload|modulepreload)["'][^>]+href=["']https?:/iu,
  );
  assert.doesNotMatch(css, /(?:@import|url)\s*\(\s*["']?https?:/iu);
  assert.doesNotMatch(docsHtml, /<(?:script|img)[^>]+(?:src)=["']https?:/iu);
});

test("accessibility affordances are present without client JavaScript", () => {
  assert.match(html, /<html\s+lang="en"/u);
  assert.match(html, /class="skip-link"/u);
  assert.match(html, /<main\s+id="main-content"/u);
  assert.match(html, /aria-label=/u);
  assert.match(css, /:focus-visible/u);
  assert.match(css, /prefers-reduced-motion:\s*reduce/u);
});

test("the Vercel deployment is static and prevents passive collection", () => {
  assert.equal(
    vercelConfig.buildCommand,
    "pnpm --filter @replicantos/site build",
  );
  assert.equal(vercelConfig.outputDirectory, "apps/site/dist");
  const globalHeaders = Object.fromEntries(
    vercelConfig.headers
      .find((entry) => entry.source === "/(.*)")
      .headers.map((entry) => [entry.key, entry.value]),
  );
  assert.match(globalHeaders["Content-Security-Policy"], /connect-src 'none'/u);
  assert.match(
    globalHeaders["Content-Security-Policy"],
    /frame-ancestors 'none'/u,
  );
  assert.ok(globalHeaders["Permissions-Policy"]);
  assert.equal(globalHeaders["Referrer-Policy"], "no-referrer");
});

test("the installable manifest uses only neutral local vector marks", () => {
  const parsed = JSON.parse(manifest);
  assert.equal(parsed.name, "ReplicantOS");
  assert.equal(parsed.icons.length, 1);
  assert.equal(parsed.icons[0].src, "/assets/favicon.svg");
  assert.equal(parsed.icons[0].type, "image/svg+xml");
});

test("social previews use the deterministic first-party large card", async () => {
  for (const page of [html, docsHtml]) {
    assert.match(page, /twitter:card" content="summary_large_image"/u);
    assert.match(page, /https:\/\/replicantos\.com\/assets\/social-card\.png/u);
  }
  const card = await readAsset("assets/social-card.png");
  assert.equal(card.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(card.readUInt32BE(16), 1_200);
  assert.equal(card.readUInt32BE(20), 630);
});
