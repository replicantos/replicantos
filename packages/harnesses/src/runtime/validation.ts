import path from "node:path";

import type { RunInput } from "@replicantos/protocol/harness";

export function validateRunInput(input: RunInput): void {
  if (!input.runId.trim()) throw new Error("runId is required.");
  if (!input.prompt.trim()) throw new Error("prompt is required.");
  if (!path.isAbsolute(input.cwd) && !path.win32.isAbsolute(input.cwd)) {
    throw new Error("cwd must be an absolute path.");
  }
}

export function errorCode(error: unknown, fallback: string): string {
  if (error instanceof Error && error.name) {
    return error.name
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .slice(0, 80);
  }
  return fallback;
}
