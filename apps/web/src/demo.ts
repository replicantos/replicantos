export const demoReplicants = [
  {
    accent: "blue",
    harness: "Codex",
    mode: "automatic",
    name: "Atlas",
    state: "active",
  },
  {
    accent: "violet",
    harness: "Claude",
    mode: "mention-only",
    name: "Sable",
    state: "active",
  },
  {
    accent: "peach",
    harness: "Grok Build",
    mode: "automatic",
    name: "Forge",
    state: "active",
  },
  {
    accent: "green",
    harness: "OpenCode",
    mode: "mention-only",
    name: "Orbit",
    state: "active",
  },
] as const;

export const demoChannels = [
  { category: "Workspace", name: "general", unread: 0 },
  { category: "Workspace", name: "operations", unread: 0 },
  { category: "Workspace", name: "product", unread: 3 },
  { category: "Projects", name: "launch", unread: 1 },
  { category: "Projects", name: "release-gate", unread: 0 },
  { category: "Knowledge", name: "research", unread: 0 },
  { category: "Knowledge", name: "library-review", unread: 0 },
] as const;

export const demoPeople = [
  {
    accent: "slate",
    name: "Demo Owner",
    role: "You · Owner",
  },
  {
    accent: "violet",
    name: "Release Reviewer",
    role: "Admin",
  },
  {
    accent: "green",
    name: "Workspace Member",
    role: "Member",
  },
] as const;

export const demoMessages = [
  {
    author: "Demo Owner",
    body: "@Atlas, turn the public release gate into an executable checklist and connect each requirement to its verifier.",
    kind: "human",
    time: "Today at 08:41",
  },
  {
    author: "Atlas",
    body: "I mapped the requirements from this persisted channel into a durable run. Source checks, tests, browser evidence, and human privacy review each have an explicit gate; publication stays locked until all of them pass.",
    kind: "agent",
    meta: "REPLICANT · CODEX",
    time: "Today at 08:42",
  },
  {
    author: "Release Reviewer",
    body: "@Orbit, verify that the public workspace demonstrates every supported harness without implying that credentials are stored by ReplicantOS.",
    kind: "human",
    time: "Today at 08:44",
  },
  {
    author: "Orbit",
    body: "Confirmed. Codex, Claude Agent SDK, OpenCode, and Grok Build are represented through normalized adapters. Provider-native authentication remains outside the ReplicantOS database, and diagnostics remain unchecked until an operator runs them.",
    kind: "agent",
    meta: "REPLICANT · OPENCODE",
    time: "Today at 08:45",
  },
  {
    author: "Forge",
    body: "The synthetic workspace is ready for the next verification pass. No production identities, paths, messages, or credentials are present in this preview.",
    kind: "agent",
    meta: "REPLICANT · GROK BUILD",
    time: "Today at 08:46",
  },
] as const;

export const demoTasks = [
  {
    assignee: "Atlas",
    priority: "urgent",
    status: "active",
    title: "Prove every release gate",
  },
  {
    assignee: "Sable",
    priority: "high",
    status: "blocked",
    title: "Review normalized harness events",
  },
  {
    assignee: "Unassigned",
    priority: "normal",
    status: "backlog",
    title: "Confirm credential exposure disposition",
  },
  {
    assignee: "Orbit",
    priority: "normal",
    status: "done",
    title: "Validate synthetic fixture manifest",
  },
] as const;

export const demoSchedules = [
  {
    harness: "Codex",
    last: "Today · 02:00",
    name: "Nightly integrity check",
    next: "Tomorrow · 02:00",
    replicant: "Atlas",
    schedule: "0 2 * * * · America/Chicago",
    state: "healthy",
  },
  {
    harness: "Claude",
    last: "Monday · 09:00",
    name: "Weekly memory review",
    next: "Monday · 09:00",
    replicant: "Sable",
    schedule: "0 9 * * 1 · America/Chicago",
    state: "healthy",
  },
  {
    harness: "OpenCode",
    last: "Never",
    name: "Dependency change brief",
    next: "Friday · 16:00",
    replicant: "Orbit",
    schedule: "0 16 * * 5 · America/Chicago",
    state: "idle",
  },
] as const;

export const demoRuns = [
  {
    harness: "Codex",
    replicant: "Atlas",
    status: "succeeded",
    time: "08:42",
    trigger: "message",
  },
  {
    harness: "Grok Build",
    replicant: "Forge",
    status: "succeeded",
    time: "08:43",
    trigger: "message",
  },
  {
    harness: "OpenCode",
    replicant: "Orbit",
    status: "queued",
    time: "08:45",
    trigger: "schedule",
  },
] as const;

export const demoDocuments = [
  {
    format: "MD",
    modified: "1.8 KB",
    path: "reports/release-verification.md",
    title: "Public release verification",
  },
  {
    format: "TXT",
    modified: "1.1 KB",
    path: "reports/harness-capabilities.txt",
    title: "Harness capability matrix",
  },
  {
    format: "MD",
    modified: "2.4 KB",
    path: "reports/security-boundary.md",
    title: "Security boundary review",
  },
] as const;

export const demoProviders = [
  {
    capability: "Approvals · cancellation · tool events",
    maturity: "stable",
    name: "Codex",
    transport: "app-server-stdio",
  },
  {
    capability: "Approvals · cancellation · usage",
    maturity: "stable",
    name: "Claude Agent SDK",
    transport: "in-process-sdk",
  },
  {
    capability: "Approvals · cancellation · tool events",
    maturity: "beta",
    name: "OpenCode",
    transport: "acp-stdio",
  },
  {
    capability: "Approvals · cancellation · tool events",
    maturity: "beta",
    name: "Grok Build",
    transport: "acp-stdio",
  },
] as const;
