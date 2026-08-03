import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./check-workflows.mjs", import.meta.url));
const policyPath = fileURLToPath(
  new URL("../privacy/github-actions-policy.json", import.meta.url),
);

test("all workflow actions are exact reviewed SHA references", async () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  for (const action of policy.actions) {
    assert.match(action.sha, /^[a-f0-9]{40}$/u);
    assert.equal(
      action.source,
      `https://github.com/${action.action}/releases/tag/${action.version}`,
    );
  }
});
