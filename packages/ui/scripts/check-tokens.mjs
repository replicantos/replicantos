import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const css = await readFile(path.join(packageRoot, "src", "tokens.css"), "utf8");

const requiredTokens = [
  "--r-color-canvas",
  "--r-color-surface",
  "--r-color-line",
  "--r-color-ink",
  "--r-font-body",
  "--r-font-mono",
  "--r-page-gutter",
  "--r-duration-base",
];

for (const token of requiredTokens) {
  if (!css.includes(`${token}:`)) {
    throw new Error(`Missing required design token: ${token}`);
  }
}

if (!css.includes("prefers-reduced-motion: reduce")) {
  throw new Error("Design tokens must include a reduced-motion override");
}

if (/url\s*\(/iu.test(css)) {
  throw new Error(
    "Shared tokens may not make external or embedded asset requests",
  );
}
