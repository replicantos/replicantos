import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  APP_ENV_KEYS,
  createLaunchSpec,
  createServerEnvironment,
  inspectReadiness,
  loadOperatorEnvironment,
  resolveOperatorConfig,
} from "./start.mjs";

async function createBuiltTree(root) {
  const files = [
    "apps/server/dist/index.js",
    "apps/web/dist/index.html",
    "packages/core/dist/index.js",
    "packages/db/dist/index.js",
    "packages/harnesses/dist/index.js",
    "packages/protocol/dist/index.js",
    "packages/runtime/dist/index.js",
  ];
  await mkdir(join(root, "node_modules"), { recursive: true });
  await mkdir(join(root, "apps/web/dist/assets"), { recursive: true });
  for (const file of files) {
    const target = join(root, file);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, "synthetic build artifact\n", "utf8");
  }
}

test("operator defaults are deterministic and loopback-only", () => {
  const root = "/opt/replicantos-source";
  const config = resolveOperatorConfig({}, root);

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8_787);
  assert.deepEqual(config.allowedOrigins, ["http://127.0.0.1:8787"]);
  assert.equal(config.dataDirectory, join(root, "data"));
  assert.equal(config.workspaceRoot, join(root, "data/files/workspace"));
  assert.equal(config.libraryRoot, join(root, "data/files/library"));
  assert.equal(config.exposureMode, "loopback-http");
});

test("operator config requires HTTPS for every non-loopback browser origin", () => {
  assert.throws(
    () =>
      resolveOperatorConfig({
        REPLICANTOS_ALLOWED_ORIGINS: "http://192.0.2.10:8787",
      }),
    /Plain HTTP origins must be loopback-only/u,
  );
  assert.throws(
    () => resolveOperatorConfig({ REPLICANTOS_HOST: "0.0.0.0" }),
    /must remain loopback-only/u,
  );
  assert.throws(
    () =>
      resolveOperatorConfig({
        REPLICANTOS_ALLOWED_ORIGINS:
          "https://agents.example.invalid,http://127.0.0.1:8787",
      }),
    /cannot mix/u,
  );
  assert.throws(
    () =>
      resolveOperatorConfig({
        REPLICANTOS_ALLOWED_ORIGINS:
          "https://agents.example.invalid,https://agents-two.example.invalid",
      }),
    /exactly one browser origin/u,
  );

  const config = resolveOperatorConfig({
    REPLICANTOS_ALLOWED_ORIGINS: "https://agents.example.invalid",
  });
  assert.equal(config.exposureMode, "reverse-proxy-https");
  assert.equal(config.host, "127.0.0.1");
});

test("operator config rejects ambiguous ports and filesystem roots", () => {
  assert.throws(
    () => resolveOperatorConfig({ REPLICANTOS_PORT: "8787.5" }),
    /must be an integer/u,
  );
  assert.throws(
    () =>
      resolveOperatorConfig({
        REPLICANTOS_LIBRARY_ROOT: "relative/library",
      }),
    /must be a non-empty absolute path/u,
  );
  assert.throws(
    () =>
      resolveOperatorConfig({
        REPLICANTOS_LIBRARY_ROOT: "/srv/replicantos/files",
        REPLICANTOS_WORKSPACE_ROOT: "/srv/replicantos/files/workspace",
      }),
    /distinct, non-overlapping/u,
  );
});

test("server child environment copies only explicit host, provider, and app keys", () => {
  const config = resolveOperatorConfig({});
  const environment = createServerEnvironment(
    {
      HOME: "/var/empty",
      OPENAI_API_KEY: "synthetic",
      UNRELATED_PRIVATE_VALUE: "must-not-cross-boundary",
    },
    config,
  );

  assert.equal(environment.HOME, "/var/empty");
  assert.equal(environment.OPENAI_API_KEY, "synthetic");
  assert.equal(environment.UNRELATED_PRIVATE_VALUE, undefined);
  assert.equal(environment.NODE_ENV, "production");
  assert.deepEqual(
    APP_ENV_KEYS.filter((key) => environment[key] === undefined),
    [],
  );
});

test("local .env is bounded, parsed without execution, and loses to process values", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "replicantos-start-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, ".env"),
    "REPLICANTOS_PORT=9000\nREPLICANTOS_HOST=127.0.0.1\n",
    "utf8",
  );

  const loaded = await loadOperatorEnvironment(
    { REPLICANTOS_PORT: "8787" },
    root,
  );
  assert.equal(loaded.localFilePresent, true);
  assert.equal(loaded.environment.REPLICANTOS_PORT, "8787");
  assert.equal(loaded.environment.REPLICANTOS_HOST, "127.0.0.1");
});

test("doctor checks build output without starting a listener or a provider", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "replicantos-doctor-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const beforeBuild = await inspectReadiness({
    environment: {},
    nodeVersion: "22.0.0",
    rootDirectory: root,
  });
  assert.equal(beforeBuild.ready, false);
  assert.ok(beforeBuild.checks.some((check) => check.label === "Server build"));

  await createBuiltTree(root);
  const afterBuild = await inspectReadiness({
    environment: {},
    nodeVersion: "22.0.0",
    rootDirectory: root,
  });
  assert.equal(afterBuild.ready, true);

  const launch = createLaunchSpec(root, { NODE_ENV: "production" });
  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.args, [join(root, "apps/server/dist/index.js")]);
  assert.equal(launch.options.shell, false);
});
