import { rm } from "node:fs/promises";
import { basename } from "node:path";

export default async function globalTeardown() {
  const directory = process.env.REPLICANTOS_E2E_DATA_DIR;
  if (!directory || !basename(directory).startsWith("replicantos-e2e-")) return;
  await rm(directory, { force: true, recursive: true });
}
