import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const siteRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const html = await readFile(path.join(siteRoot, "src", "index.html"), "utf8");
const docsHtml = await readFile(
  path.join(siteRoot, "src", "docs", "index.html"),
  "utf8",
);
const css = await readFile(
  path.join(siteRoot, "src", "styles", "site.css"),
  "utf8",
);
const javascript = await readFile(
  path.join(siteRoot, "src", "assets", "site.js"),
  "utf8",
);

const requiredSections = [
  "harnesses",
  "persistence",
  "schedules",
  "team",
  "inspectability",
  "security",
];

for (const section of requiredSections) {
  if (!html.includes(`id="${section}"`)) {
    throw new Error(`Missing public product section: ${section}`);
  }
}

for (const forbidden of [
  /<script[^>]+src=["']https?:/iu,
  /<link[^>]+rel=["'](?:stylesheet|preload|modulepreload)["'][^>]+href=["']https?:/iu,
  /<img[^>]+src=["']https?:/iu,
  /@import\s+url/iu,
  /document\.cookie/iu,
  /localStorage/iu,
]) {
  if (forbidden.test(`${html}\n${docsHtml}\n${css}\n${javascript}`)) {
    throw new Error(
      `Public site contains forbidden client behavior: ${forbidden}`,
    );
  }
}

if (!html.includes('class="skip-link"')) {
  throw new Error("The public site requires a keyboard skip link");
}

if (!docsHtml.includes('class="skip-link"')) {
  throw new Error("The public documentation requires a keyboard skip link");
}

if (!css.includes("prefers-reduced-motion: reduce")) {
  throw new Error("The public site requires reduced-motion behavior");
}
