import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assertHarnessAdapter } from "@replicantos/protocol/harness";
import {
  ClaudeAdapter,
  CodexAdapter,
  GrokAdapter,
  HarnessRegistry,
  OpenCodeAdapter,
} from "../dist/index.js";
import {
  CwdPolicyError,
  JsonLineDecoder,
  buildChildEnvironment,
  createApprovedRootCwdResolver,
  parseAcpSessionUpdate,
  parseClaudeMessage,
  parseCodexNotification,
} from "../dist/testing.js";

const clock = () => "2026-01-01T00:00:00.000Z";
const allowCwd = { resolve: async (cwd) => cwd };
const probe = async (command) => ({
  available: true,
  version: `${command} 1.0.0`,
  message: `${command} is available.`,
});

class FakePeer {
  calls = [];
  notifications = [];
  #closedResolve;
  closed = new Promise((resolve) => {
    this.#closedResolve = resolve;
  });

  constructor(spec, requestHandler, notifyHandler = () => {}) {
    this.spec = spec;
    this.requestHandler = requestHandler;
    this.notifyHandler = notifyHandler;
  }

  async request(method, params = {}) {
    this.calls.push({ method, params });
    return this.requestHandler(this, method, params);
  }

  notify(method, params = {}) {
    this.notifications.push({ method, params });
    this.notifyHandler(this, method, params);
  }

  close() {
    this.#closedResolve({ code: 0, signal: null, expected: true });
  }
}

function codexPeerFactory(peers) {
  return (spec) => {
    const peer = new FakePeer(spec, async (_peer, method) => {
      if (method === "initialize") return {};
      if (method === "thread/start" || method === "thread/resume") {
        return { thread: { id: "session_demo" } };
      }
      if (method === "turn/start") {
        queueMicrotask(() => {
          void (async () => {
            await spec.onNotification?.({
              method: "item/agentMessage/delta",
              params: { delta: "Hello from Codex" },
            });
            await spec.onNotification?.({
              method: "turn/completed",
              params: { turn: { status: "completed" } },
            });
          })();
        });
        return { turn: { id: "turn_demo" } };
      }
      if (method === "turn/interrupt") return {};
      throw new Error(`Unexpected Codex method ${method}`);
    });
    peers.push(peer);
    return peer;
  };
}

function acpPeerFactory(peers, { autoComplete = true } = {}) {
  return (spec) => {
    let resolvePrompt;
    const peer = new FakePeer(
      spec,
      async (_peer, method) => {
        if (method === "initialize") return { authMethods: [] };
        if (method === "session/new" || method === "session/load") {
          return { sessionId: "session_demo" };
        }
        if (method === "session/prompt") {
          if (autoComplete) {
            await spec.onNotification?.({
              method: "session/update",
              params: {
                sessionId: "session_demo",
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "Hello over ACP" },
                },
              },
            });
            return { stopReason: "end_turn" };
          }
          return new Promise((resolve) => {
            resolvePrompt = resolve;
          });
        }
        if (method === "authenticate") return {};
        throw new Error(`Unexpected ACP method ${method}`);
      },
      (_peer, method) => {
        if (method === "session/cancel")
          resolvePrompt?.({ stopReason: "cancelled" });
      },
    );
    peers.push(peer);
    return peer;
  };
}

function claudeLoader(queries) {
  return Promise.resolve({
    query(input) {
      queries?.push(input);
      return {
        async interrupt() {},
        async *[Symbol.asyncIterator]() {
          yield { type: "system", subtype: "init", session_id: "session_demo" };
          yield {
            type: "stream_event",
            session_id: "session_demo",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "Hello from Claude" },
            },
          };
          yield {
            type: "result",
            subtype: "success",
            session_id: "session_demo",
            usage: { input_tokens: 4, output_tokens: 3 },
          };
        },
      };
    },
  });
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs)
      throw new Error("Timed out waiting for test state.");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("all public adapters satisfy the capability-aware contract and doctors are injectable", async () => {
  const adapters = [
    new CodexAdapter({ clock, probe, cwdResolver: allowCwd }),
    new ClaudeAdapter({
      clock,
      cwdResolver: allowCwd,
      loadSdk: claudeLoader,
      environment: { ANTHROPIC_API_KEY: "present" },
    }),
    new OpenCodeAdapter({ clock, probe, cwdResolver: allowCwd }),
    new GrokAdapter({ clock, probe, cwdResolver: allowCwd }),
  ];
  for (const adapter of adapters) {
    assert.doesNotThrow(() => assertHarnessAdapter(adapter));
    const result = await adapter.doctor({ cwd: "/workspace" });
    assert.equal(result.harnessId, adapter.manifest.id);
    assert.equal(result.status, "ready");
    assert.equal(adapter.manifest.credentials.storedByReplicantOS, false);
  }
  assert.equal(new HarnessRegistry(adapters).list().length, 4);
});

test("Codex app-server lifecycle emits normalized ordered events", async () => {
  const peers = [];
  const events = [];
  const adapter = new CodexAdapter({
    clock,
    cwdResolver: allowCwd,
    probe,
    peerFactory: codexPeerFactory(peers),
  });
  const handle = await adapter.start(
    {
      runId: "run_codex",
      prompt: "Say hello",
      cwd: "/workspace",
      systemPrompt: "Act as the synthetic release Replicant.",
      approvalMode: "ask",
    },
    (event) => events.push(event),
  );
  assert.deepEqual(await handle.completion, {
    runId: "run_codex",
    sessionId: "session_demo",
    status: "succeeded",
  });
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "run.state",
      "session.bound",
      "run.state",
      "assistant.text.delta",
      "run.completed",
    ],
  );
  assert.deepEqual(
    events.map((event) => event.sequence),
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(
    peers[0].calls.slice(0, 3).map((call) => call.method),
    ["initialize", "thread/start", "turn/start"],
  );
  assert.equal(peers[0].notifications[0].method, "initialized");
  assert.deepEqual(peers[0].calls[1], {
    method: "thread/start",
    params: {
      approvalPolicy: "on-request",
      cwd: "/workspace",
      developerInstructions: "Act as the synthetic release Replicant.",
      sandbox: "workspace-write",
    },
  });
  assert.equal(peers[0].calls[2].params.approvalPolicy, "on-request");
  assert.equal(peers[0].calls[2].params.cwd, "/workspace");
});

test("Claude Agent SDK lifecycle is lazy and normalized", async () => {
  const events = [];
  const queries = [];
  const adapter = new ClaudeAdapter({
    clock,
    cwdResolver: allowCwd,
    loadSdk: () => claudeLoader(queries),
    environment: {
      ANTHROPIC_API_KEY: "present",
      SERVER_DATABASE_PASSWORD: "must-not-cross",
    },
  });
  const handle = await adapter.start(
    { runId: "run_claude", prompt: "Say hello", cwd: "/workspace" },
    (event) => events.push(event),
  );
  assert.equal((await handle.completion).status, "succeeded");
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "run.state",
      "run.state",
      "session.bound",
      "assistant.text.delta",
      "usage.updated",
      "run.completed",
    ],
  );
  assert.equal(queries[0].options.env.ANTHROPIC_API_KEY, "present");
  assert.equal(queries[0].options.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1");
  assert.equal(queries[0].options.env.SERVER_DATABASE_PASSWORD, undefined);
});

test("OpenCode and Grok ACP lifecycles use initialize, sessions, and prompts", async () => {
  for (const Adapter of [OpenCodeAdapter, GrokAdapter]) {
    const peers = [];
    const events = [];
    const adapter = new Adapter({
      clock,
      cwdResolver: allowCwd,
      environment: {
        OPENCODE_API_KEY: "opencode-secret",
        XAI_API_KEY: "xai-secret",
        SERVER_DATABASE_PASSWORD: "must-not-cross",
      },
      probe,
      peerFactory: acpPeerFactory(peers),
    });
    const handle = await adapter.start(
      {
        runId: `run_${adapter.manifest.id}`,
        prompt: "Say hello",
        cwd: "/workspace",
        systemPrompt: "Act as the synthetic release Replicant.",
      },
      (event) => events.push(event),
    );
    assert.equal((await handle.completion).status, "succeeded");
    assert.deepEqual(
      peers[0].calls.map((call) => call.method),
      ["initialize", "session/new", "session/prompt"],
    );
    assert.ok(events.some((event) => event.type === "assistant.text.delta"));
    assert.equal(
      peers[0].calls[2].params.prompt[0].text,
      [
        "ReplicantOS system instructions:",
        "Act as the synthetic release Replicant.",
        "",
        "Channel or task context:",
        "Say hello",
      ].join("\n"),
    );
    assert.equal(peers[0].spec.environment.SERVER_DATABASE_PASSWORD, undefined);
    if (adapter.manifest.id === "opencode") {
      assert.equal(
        peers[0].spec.environment.OPENCODE_API_KEY,
        "opencode-secret",
      );
      assert.equal(peers[0].spec.environment.XAI_API_KEY, undefined);
    } else {
      assert.equal(peers[0].spec.environment.XAI_API_KEY, "xai-secret");
      assert.equal(peers[0].spec.environment.OPENCODE_API_KEY, undefined);
    }
  }
});

test("ACP cancellation is a notification and completes as canceled", async () => {
  const peers = [];
  const events = [];
  const adapter = new OpenCodeAdapter({
    clock,
    cwdResolver: allowCwd,
    probe,
    cancellationGraceMs: 50,
    peerFactory: acpPeerFactory(peers, { autoComplete: false }),
  });
  const handle = await adapter.start(
    { runId: "run_cancel", prompt: "Wait", cwd: "/workspace" },
    (event) => events.push(event),
  );
  await waitFor(() =>
    events.some(
      (event) => event.type === "run.state" && event.state === "running",
    ),
  );
  await adapter.cancel("run_cancel");
  assert.equal((await handle.completion).status, "canceled");
  assert.ok(
    events.some((event) => event.type === "run.cancellation.requested"),
  );
  assert.equal(peers[0].notifications.at(-1).method, "session/cancel");
});

test("pure parsers retain only normalized public fields", () => {
  assert.deepEqual(
    parseCodexNotification("item/agentMessage/delta", {
      delta: "hello",
      private: "ignored",
    }),
    [{ type: "assistant.text.delta", text: "hello" }],
  );
  assert.deepEqual(
    parseAcpSessionUpdate({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { text: "hi" },
        native: "ignored",
      },
    }),
    [{ type: "assistant.text.delta", text: "hi" }],
  );
  assert.deepEqual(
    parseClaudeMessage({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hey" },
      },
    }).events,
    [{ type: "assistant.text.delta", text: "hey" }],
  );
});

test("JSONL decoder handles fragmentation and rejects oversized lines", () => {
  const decoder = new JsonLineDecoder(32);
  assert.deepEqual(decoder.push('{"id":1'), []);
  assert.deepEqual(decoder.push('}\n{"id":2}\n'), ['{"id":1}', '{"id":2}']);
  assert.throws(() => decoder.push("x".repeat(33)), /size limit/);
});

test("child environments use an explicit allowlist", () => {
  const result = buildChildEnvironment(
    {
      PATH: "/usr/bin",
      HOME: "/host/home",
      XAI_API_KEY: "xai-secret-value",
      CUSTOM_PROVIDER_TOKEN: "custom-secret-value",
      SERVER_DATABASE_PASSWORD: "must-not-cross",
    },
    ["XAI_API_KEY"],
    ["CUSTOM_PROVIDER_TOKEN"],
  );
  assert.deepEqual(result.env, {
    PATH: "/usr/bin",
    HOME: "/host/home",
    XAI_API_KEY: "xai-secret-value",
    CUSTOM_PROVIDER_TOKEN: "custom-secret-value",
  });
  assert.equal(result.env.SERVER_DATABASE_PASSWORD, undefined);
  assert.deepEqual(result.secretValues, [
    "custom-secret-value",
    "xai-secret-value",
  ]);
  assert.throws(
    () => buildChildEnvironment({}, [], ["INVALID=NAME"]),
    /invalid variable name/,
  );
});

test("Codex forwards only opted-in auth and redacts secrets from events", async () => {
  const token = "openai-provider-secret";
  const cwd = "/approved/workspace";
  const events = [];
  let peerSpec;
  const adapter = new CodexAdapter({
    clock,
    cwdResolver: allowCwd,
    environment: {
      PATH: "/usr/bin",
      OPENAI_API_KEY: token,
      CODEX_API_KEY: "exec-only-secret",
      SERVER_DATABASE_PASSWORD: "database-secret",
    },
    peerFactory(spec) {
      peerSpec = spec;
      return new FakePeer(spec, async (_peer, method) => {
        if (method === "initialize") {
          await spec.onNotification?.({
            method: "item/agentMessage/delta",
            params: { delta: `Provider echoed ${token}.` },
          });
          throw new Error(`Provider rejected ${token} while opening ${cwd}.`);
        }
        throw new Error(`Unexpected Codex method ${method}`);
      });
    },
  });
  const handle = await adapter.start(
    { runId: "run_redaction", prompt: "Fail safely", cwd },
    (event) => events.push(event),
  );
  assert.equal((await handle.completion).status, "failed");
  assert.equal(peerSpec.environment.OPENAI_API_KEY, token);
  assert.equal(peerSpec.environment.CODEX_API_KEY, undefined);
  assert.equal(peerSpec.environment.SERVER_DATABASE_PASSWORD, undefined);
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes(cwd), false);
  assert.match(serialized, /\[redacted\]/);
});

test("doctor output cannot echo an allowed credential", async () => {
  const token = "doctor-provider-secret";
  const adapter = new CodexAdapter({
    clock,
    environment: {
      OPENAI_API_KEY: token,
      SERVER_DATABASE_PASSWORD: "must-not-cross",
    },
    probe: async (_command, _args, options) => {
      assert.equal(options.environment.OPENAI_API_KEY, token);
      assert.equal(options.environment.SERVER_DATABASE_PASSWORD, undefined);
      return {
        available: false,
        message: `Provider diagnostics accidentally included ${token}.`,
      };
    },
  });
  const result = await adapter.doctor();
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(token), false);
  assert.match(serialized, /\[redacted\]/);
});

test("approved-root cwd resolution rejects escapes, files, and symlinks", async () => {
  const createdSandbox = await mkdtemp(
    path.join(tmpdir(), "replicantos-cwd-test-"),
  );
  const sandbox = await realpath(createdSandbox);
  const approved = path.join(sandbox, "approved");
  const inside = path.join(approved, "inside");
  const outside = path.join(sandbox, "outside");
  const file = path.join(approved, "file.txt");
  const symlinkInside = path.join(approved, "linked-inside");
  const symlinkEscape = path.join(approved, "linked-outside");
  try {
    await mkdir(inside, { recursive: true });
    await mkdir(outside);
    await writeFile(file, "not a directory");
    await symlink(inside, symlinkInside, "dir");
    await symlink(outside, symlinkEscape, "dir");
    const resolver = createApprovedRootCwdResolver({
      approvedRoots: [approved],
    });
    assert.equal(await resolver.resolve(inside), await realpath(inside));
    await assert.rejects(() => resolver.resolve(outside), CwdPolicyError);
    await assert.rejects(() => resolver.resolve(file), CwdPolicyError);
    await assert.rejects(() => resolver.resolve(symlinkInside), CwdPolicyError);
    await assert.rejects(() => resolver.resolve(symlinkEscape), CwdPolicyError);
  } finally {
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("adapters reject runs when no cwd policy is configured", async () => {
  const adapter = new CodexAdapter({
    clock,
    peerFactory: () => {
      throw new Error("peer should not be created");
    },
  });
  await assert.rejects(
    () =>
      adapter.start(
        { runId: "run_no_policy", prompt: "Do nothing", cwd: "/workspace" },
        () => {},
      ),
    /No approved cwd resolver/,
  );
});
