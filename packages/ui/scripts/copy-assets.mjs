import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outputDirectory = path.join(packageRoot, "dist");

await mkdir(outputDirectory, { recursive: true });
await copyFile(
  path.join(packageRoot, "src", "tokens.css"),
  path.join(outputDirectory, "tokens.css"),
);
