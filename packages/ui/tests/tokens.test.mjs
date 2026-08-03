import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const css = await readFile(path.join(packageRoot, "src", "tokens.css"), "utf8");
const tokenSource = await readFile(
  path.join(packageRoot, "src", "tokens.ts"),
  "utf8",
);

test("the token layer is local and code-native", () => {
  assert.doesNotMatch(css, /https?:\/\//iu);
  assert.doesNotMatch(css, /@font-face/iu);
  assert.doesNotMatch(css, /url\s*\(/iu);
});

test("CSS and TypeScript share the core palette", () => {
  for (const value of ["#070808", "#0c0e0e", "#292c2b", "#f3f4ef"]) {
    assert.match(css, new RegExp(value, "iu"));
    assert.match(tokenSource, new RegExp(value, "iu"));
  }
});

test("motion has an operating-system preference escape hatch", () => {
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/iu);
  assert.match(css, /--r-duration-base:\s*0ms/iu);
});
