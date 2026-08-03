import type { HarnessManifest } from "@replicantos/protocol/harness";

const hostCredentials = Object.freeze({
  mode: "host-native" as const,
  storedByReplicantOS: false as const,
});

export const CODEX_MANIFEST: HarnessManifest = Object.freeze({
  id: "codex",
  displayName: "Codex",
  description: "OpenAI Codex through its local app-server protocol.",
  maturity: "stable",
  transport: "app-server-stdio",
  credentials: hostCredentials,
  capabilities: Object.freeze({
    approvals: true,
    cancellation: true,
    fileChanges: true,
    images: false,
    modelSelection: true,
    reasoningSummaries: true,
    sessionResume: true,
    streamingText: true,
    toolEvents: true,
    usage: true,
  }),
});

export const CLAUDE_MANIFEST: HarnessManifest = Object.freeze({
  id: "claude",
  displayName: "Claude Agent",
  description:
    "Anthropic's Claude Agent SDK with explicit project settings and approvals.",
  maturity: "stable",
  transport: "in-process-sdk",
  credentials: hostCredentials,
  capabilities: Object.freeze({
    approvals: true,
    cancellation: true,
    fileChanges: false,
    images: false,
    modelSelection: true,
    reasoningSummaries: true,
    sessionResume: true,
    streamingText: true,
    toolEvents: true,
    usage: true,
  }),
});

export const OPENCODE_MANIFEST: HarnessManifest = Object.freeze({
  id: "opencode",
  displayName: "OpenCode",
  description: "OpenCode through its local Agent Client Protocol subprocess.",
  maturity: "beta",
  transport: "acp-stdio",
  credentials: hostCredentials,
  capabilities: Object.freeze({
    approvals: true,
    cancellation: true,
    fileChanges: true,
    images: false,
    modelSelection: false,
    reasoningSummaries: true,
    sessionResume: true,
    streamingText: true,
    toolEvents: true,
    usage: true,
  }),
});

export const GROK_MANIFEST: HarnessManifest = Object.freeze({
  id: "grok",
  displayName: "Grok Build",
  description: "Grok Build through its local Agent Client Protocol subprocess.",
  maturity: "beta",
  transport: "acp-stdio",
  credentials: hostCredentials,
  capabilities: Object.freeze({
    approvals: true,
    cancellation: true,
    fileChanges: true,
    images: false,
    modelSelection: false,
    reasoningSummaries: true,
    sessionResume: true,
    streamingText: true,
    toolEvents: true,
    usage: true,
  }),
});
