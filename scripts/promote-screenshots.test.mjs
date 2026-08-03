import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inspectPng } from "./lib/png.mjs";
import { syntheticPng } from "./test-helpers/png.mjs";

const script = fileURLToPath(
  new URL("./promote-screenshots.mjs", import.meta.url),
);
const policyPath = fileURLToPath(
  new URL("../privacy/screenshot-policy.json", import.meta.url),
);

async function sourceFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "replicantos-screenshot-test-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const source = join(root, "source");
  const output = join(root, "output");
  await mkdir(source);
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  for (const frame of policy.frames) {
    await writeFile(
      join(source, frame.name),
      syntheticPng({
        extraChunks: [
          { data: Buffer.from("Creation Time\0synthetic"), type: "tEXt" },
        ],
        height: frame.height,
        width: frame.width,
      }),
    );
  }
  return { output, policy, source };
}

function run(source, output) {
  return spawnSync(
    process.execPath,
    [script, "--source", source, "--output", output],
    {
      encoding: "utf8",
      env: { ...process.env, REPLICANTOS_PROMOTE_SCREENSHOTS: "1" },
    },
  );
}

test("promotion is explicit, sanitized, path-free, and repeatable", async (t) => {
  const fixture = await sourceFixture(t);
  const first = run(fixture.source, fixture.output);
  assert.equal(first.status, 0, first.stderr);
  const second = run(fixture.source, fixture.output);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already match/u);

  const manifestText = await readFile(
    join(fixture.output, "manifest.json"),
    "utf8",
  );
  assert.doesNotMatch(manifestText, /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)/u);
  const manifest = JSON.parse(manifestText);
  assert.deepEqual(
    manifest.files.map(({ height, name, width }) => ({ height, name, width })),
    fixture.policy.frames,
  );
  for (const frame of fixture.policy.frames) {
    assert.deepEqual(
      inspectPng(await readFile(join(fixture.output, frame.name))).errors,
      [],
    );
  }
});

test("promotion rejects a frame whose dimensions drift", async (t) => {
  const fixture = await sourceFixture(t);
  const first = fixture.policy.frames[0];
  await writeFile(
    join(fixture.source, first.name),
    syntheticPng({ height: 1, width: 1 }),
  );
  const result = run(fixture.source, fixture.output);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be 1600x900/u);
});
