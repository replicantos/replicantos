import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { siteConfig } from "../site.config.mjs";

const siteRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(siteRoot, "../..");
const sourceDirectory = path.join(siteRoot, "src");
const outputDirectory = path.join(siteRoot, "dist");
const tokenSource = path.join(
  repositoryRoot,
  "packages",
  "ui",
  "src",
  "tokens.css",
);

for (const [label, value] of Object.entries(siteConfig)) {
  if (
    label === "docsUrl" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\")
  ) {
    continue;
  }
  if (!URL.canParse(value)) {
    throw new Error(`${label} must be an absolute, parseable public URL`);
  }
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await cp(sourceDirectory, outputDirectory, { recursive: true });
await cp(tokenSource, path.join(outputDirectory, "styles", "tokens.css"));

for (const fileName of ["index.html", "404.html", "docs/index.html"]) {
  const outputPath = path.join(outputDirectory, fileName);
  const source = await readFile(outputPath, "utf8");
  const rendered = source
    .replaceAll("{{GITHUB_URL}}", siteConfig.githubUrl)
    .replaceAll("{{DOCS_URL}}", siteConfig.docsUrl);

  if (/\{\{[A-Z_]+\}\}/u.test(rendered)) {
    throw new Error(`Unresolved release placeholder in ${fileName}`);
  }

  await writeFile(outputPath, rendered, "utf8");
}
