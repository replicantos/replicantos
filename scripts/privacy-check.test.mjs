import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { syntheticPng } from "./test-helpers/png.mjs";

const script = fileURLToPath(new URL("./privacy-check.mjs", import.meta.url));

async function fixture(files, t) {
  const root = await mkdtemp(join(tmpdir(), "replicantos-privacy-test-"));
  t?.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, "privacy"), { recursive: true });
  await writeFile(
    join(root, "privacy/allowed-authors.json"),
    JSON.stringify([{ name: "ReplicantOS", email: "admin@replicantos.com" }]),
  );
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

function run(root, extra = []) {
  return spawnSync(process.execPath, [script, root, ...extra], {
    encoding: "utf8",
  });
}

function runGit(root, argumentsList, overrides = {}) {
  const result = spawnSync("git", argumentsList, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_AUTHOR_EMAIL: "admin@replicantos.com",
      GIT_AUTHOR_NAME: "ReplicantOS",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_EMAIL: "admin@replicantos.com",
      GIT_COMMITTER_NAME: "ReplicantOS",
      ...overrides,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

async function commitFixture(files, t, message = "Synthetic fixture") {
  const root = await fixture(files, t);
  runGit(root, ["init", "-b", "main"]);
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", message]);
  return root;
}

async function externalDenylist(t, contents = "synthetic private marker\n") {
  const root = await mkdtemp(
    join(tmpdir(), "replicantos-private-policy-test-"),
  );
  t.after(() => rm(root, { force: true, recursive: true }));
  const path = join(root, "terms.txt");
  await writeFile(path, contents);
  return path;
}

test("accepts reserved synthetic identity data", async (t) => {
  const root = await fixture(
    {
      "fixtures/demo/user.json": JSON.stringify({
        email: "owner@example.invalid",
        name: "Operator",
      }),
    },
    t,
  );
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
});

test("rejects an absolute workstation path without storing one in this source file", async (t) => {
  const path = ["/", "Users", "/", "private-user", "/", "workspace"].join("");
  const root = await fixture({ "unsafe.txt": path }, t);
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /absolute user-home path/u);
});

test("rejects a token-shaped value and redacts its output", async (t) => {
  const token = [
    "eyJ",
    "a".repeat(18),
    ".",
    "b".repeat(18),
    ".",
    "c".repeat(18),
  ].join("");
  const root = await fixture({ "unsafe.txt": token }, t);
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /JWT-like token/u);
  assert.doesNotMatch(result.stderr, new RegExp(token, "u"));
});

test("rejects terms supplied through the private denylist", async (t) => {
  const root = await fixture(
    { "unsafe.txt": "A forbidden synthetic marker appears here." },
    t,
  );
  const denylist = join(root, ".private-terms");
  await writeFile(denylist, "forbidden synthetic marker\n");
  const result = run(root, ["--denylist", denylist]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /matched private release denylist/u);
  assert.doesNotMatch(result.stderr, /forbidden synthetic marker/u);
});

test("release mode requires a nonempty denylist outside the repository", async (t) => {
  const root = await commitFixture({ "safe.txt": "Synthetic content." }, t);
  const missing = run(root, ["--release"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /requires an external private denylist/u);

  const inside = join(root, ".privacy.local-denylist");
  await writeFile(inside, "synthetic private marker\n");
  const embedded = run(root, ["--release", "--denylist", inside]);
  assert.equal(embedded.status, 1);
  assert.match(embedded.stderr, /outside the repository/u);

  const empty = await externalDenylist(t, "# comments do not count\n");
  const emptyResult = run(root, ["--release", "--denylist", empty]);
  assert.equal(emptyResult.status, 1);
  assert.match(emptyResult.stderr, /nonempty private denylist/u);
});

test("release mode rejects an uncommitted repository", async (t) => {
  const root = await fixture({ "safe.txt": "Synthetic content." }, t);
  runGit(root, ["init", "-b", "main"]);
  const denylist = await externalDenylist(t);
  const result = run(root, ["--release", "--denylist", denylist]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /at least one committed revision/u);
});

test("release mode scans deleted blobs, paths, commit messages, and annotated tags", async (t) => {
  const term = "synthetic private marker";
  const root = await commitFixture(
    { [`archive/${term}.txt`]: `contains ${term}` },
    t,
    `Initial ${term}`,
  );
  runGit(root, ["tag", "-a", "archive-review", "-m", `Tag ${term}`]);
  await rm(join(root, "archive"), { force: true, recursive: true });
  runGit(root, ["add", "-A"]);
  runGit(root, ["commit", "-m", "Remove synthetic historical fixture"]);

  const denylist = await externalDenylist(t, `${term}\n`);
  const result = run(root, ["--release", "--denylist", denylist]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /matched private release denylist/u);
  assert.match(result.stderr, /redacted-location/u);
  assert.doesNotMatch(result.stderr, new RegExp(term, "u"));
});

test("release mode enforces approved author, committer, and tagger identities without leaking them", async (t) => {
  const name = ["Unapproved", "Identity"].join(" ");
  const email = ["unapproved", "identity"].join(".") + "@example.test";
  const root = await fixture({ "safe.txt": "Synthetic content." }, t);
  runGit(root, ["init", "-b", "main"]);
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "Synthetic fixture"], {
    GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_COMMITTER_NAME: name,
  });
  const denylist = await externalDenylist(t);
  const result = run(root, ["--release", "--denylist", denylist]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /non-approved identity/u);
  assert.doesNotMatch(result.stderr, new RegExp(name, "u"));
  assert.doesNotMatch(result.stderr, new RegExp(email, "u"));
});

test("release mode checks annotated-tag identities independently", async (t) => {
  const name = ["Unapproved", "Tagger"].join(" ");
  const email = ["unapproved", "tagger"].join(".") + "@example.test";
  const root = await commitFixture({ "safe.txt": "Synthetic content." }, t);
  runGit(root, ["tag", "-a", "v0.0.0-test", "-m", "Synthetic tag"], {
    GIT_COMMITTER_EMAIL: email,
    GIT_COMMITTER_NAME: name,
  });
  const denylist = await externalDenylist(t);
  const result = run(root, ["--release", "--denylist", denylist]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /non-approved identity/u);
  assert.doesNotMatch(result.stderr, new RegExp(name, "u"));
  assert.doesNotMatch(result.stderr, new RegExp(email, "u"));
});

test("inspects approved PNG assets for release-unsafe metadata", async (t) => {
  const root = await fixture(
    {
      "apps/web/public/card.png": syntheticPng({
        extraChunks: [{ data: Buffer.from("Author\0synthetic"), type: "tEXt" }],
      }),
    },
    t,
  );
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /text metadata/u);
});

test("scans source directories named runtime while rejecting root runtime state", async (t) => {
  const token = ["gh", "p_", "a".repeat(32)].join("");
  const sourceRoot = await fixture({ "packages/runtime/unsafe.txt": token }, t);
  const sourceResult = run(sourceRoot);
  assert.equal(sourceResult.status, 1);
  assert.match(sourceResult.stderr, /GitHub token-like value/u);

  const stateRoot = await fixture({ "runtime/state.txt": "synthetic" }, t);
  const stateResult = run(stateRoot);
  assert.equal(stateResult.status, 1);
  assert.match(stateResult.stderr, /runtime-state path is forbidden/u);
});
