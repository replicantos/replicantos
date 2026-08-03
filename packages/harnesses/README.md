# `@replicantos/harnesses`

Local agent harness implementations behind the provider-neutral
`HarnessAdapter` contract from `@replicantos/protocol`.

## Adapter exports

- `CodexAdapter`: `codex app-server` over JSONL stdio
- `ClaudeAdapter`: lazy optional `@anthropic-ai/claude-agent-sdk`
- `OpenCodeAdapter`: `opencode acp` over ACP v1 stdio
- `GrokAdapter`: `grok --no-auto-update agent stdio` over ACP v1 stdio
- `HarnessRegistry` and `createDefaultHarnessRegistry`
- Adapter option types for dependency injection in tests and deployments

The manifests label Codex and the optional Claude adapter as stable, and
OpenCode and Grok Build as beta. These labels describe adapter maturity, not
provider availability: no provider runtime is bundled, and the Claude Agent SDK
is an optional peer distributed under separate terms.

The `./testing` export contains pure provider event parsers, the bounded JSONL
decoder, and injectable JSON-RPC/probe types. Product code should not consume
provider parsers directly.

## Safety and authentication

- No adapter accepts a credential value in `RunInput`.
- CLI subprocesses receive a fresh, minimal environment object. The base set is
  limited to executable lookup, locale, temporary-directory, home-directory,
  XDG, and Windows profile variables. The full server environment is never
  passed to a harness.
- Each adapter adds only its provider variables. The complete, auditable sets
  are exported as `CODEX_CHILD_ENV_KEYS`, `CLAUDE_CHILD_ENV_KEYS`,
  `GROK_CHILD_ENV_KEYS`, and `OPENCODE_CHILD_ENV_KEYS`. Codex supports its home,
  SQLite home, access-token, and OpenAI API-key variables; Claude supports
  direct Anthropic auth plus the documented AWS/Bedrock, Google Vertex,
  Microsoft Foundry, and Claude Platform on AWS credential chains; Grok
  supports `GROK_HOME` and `XAI_API_KEY`; OpenCode supports `OPENCODE_API_KEY`,
  `OPENCODE_CONFIG`, and `OPENCODE_CONFIG_DIR`.
- Deployments may opt additional provider variables in by **name** through an
  adapter's `additionalEnvKeys`. The `environment` option selects the source to
  copy from; it does not bypass the allowlist. Credential-looking values are
  centrally redacted from all normalized event strings.
- `CODEX_API_KEY` is intentionally not in the Codex app-server defaults because
  it is an exec-only variable. Provider-native auth remains available through
  the supported variables above and host config under the explicitly forwarded
  home/config directories. ReplicantOS does not persist a token.
- The Claude Agent SDK is a deliberately optional peer loaded only by its
  adapter. Third-party applications must use an Anthropic API key or supported
  Bedrock, Vertex, or Foundry host identity, not relay a user's Claude account
  login. Its SDK environment always sets
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, keeping provider credentials in the SDK
  process while removing them from Bash tools, hooks, and stdio MCP children.
- Filesystem and terminal ACP client capabilities are advertised as disabled.
  Agent tools remain governed by the harness's own sandbox and approval policy.
- Provider-native payloads are parsed into bounded, normalized summaries. Raw
  command input, tool results, and provider event objects do not cross the
  public protocol boundary.
- All subprocesses use argument arrays with `shell: false`, bounded JSONL lines,
  request timeouts, cancellation, and explicit teardown.

## Working-directory policy

Runs fail closed until the host injects an `ApprovedCwdResolver`. The bundled
`createApprovedRootCwdResolver({ approvedRoots })` canonicalizes both injected
roots and requested directories, requires an existing directory, rejects
symlinked request paths, and rejects paths outside every approved root. No root
is hardcoded in this package. Pass the same resolver to each adapter option (or
to each entry in `createDefaultHarnessRegistry`); doctor checks with an explicit
`cwd` use the policy too.

## Integration references

- [Codex app-server](https://learn.chatgpt.com/docs/app-server.md)
- [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)
- [OpenCode ACP](https://dev.opencode.ai/docs/acp/)
- [Grok Build headless and ACP](https://docs.x.ai/build/cli/headless-scripting)
- [Agent Client Protocol v1](https://agentclientprotocol.com/protocol/v1/overview)
