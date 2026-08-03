export * from "./adapters/acp.js";
export * from "./adapters/claude.js";
export * from "./adapters/codex.js";
export * from "./adapters/grok.js";
export * from "./adapters/manifests.js";
export * from "./adapters/opencode.js";
export * from "./registry.js";
export {
  CwdPolicyError,
  createApprovedRootCwdResolver,
  type ApprovedCwdResolver,
  type ApprovedRootCwdResolverOptions,
} from "./runtime/cwd.js";

import { ClaudeAdapter, type ClaudeAdapterOptions } from "./adapters/claude.js";
import { CodexAdapter, type CodexAdapterOptions } from "./adapters/codex.js";
import { GrokAdapter, type GrokAdapterOptions } from "./adapters/grok.js";
import {
  OpenCodeAdapter,
  type OpenCodeAdapterOptions,
} from "./adapters/opencode.js";
import { HarnessRegistry } from "./registry.js";

export interface DefaultHarnessOptions {
  claude?: ClaudeAdapterOptions;
  codex?: CodexAdapterOptions;
  grok?: GrokAdapterOptions;
  opencode?: OpenCodeAdapterOptions;
}

export function createDefaultHarnessRegistry(
  options: DefaultHarnessOptions = {},
): HarnessRegistry {
  return new HarnessRegistry([
    new CodexAdapter(options.codex),
    new ClaudeAdapter(options.claude),
    new OpenCodeAdapter(options.opencode),
    new GrokAdapter(options.grok),
  ]);
}
