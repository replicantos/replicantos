import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { dependencyArtifactInternalsForTest } from "./generate-dependency-artifacts.mjs";

const script = fileURLToPath(
  new URL("./generate-dependency-artifacts.mjs", import.meta.url),
);
const policyPath = fileURLToPath(
  new URL("../privacy/license-policy.json", import.meta.url),
);
const {
  assertNoAbsolutePaths,
  collectLicenses,
  matchLicensePolicy,
  summarizeCommandFailure,
} = dependencyArtifactInternalsForTest;

test("license policy fail-closes unknown declarations and pins reviewed exceptions", async () => {
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  assert.throws(
    () => matchLicensePolicy("unreviewed-package", "1.0.0", "Unknown", policy),
    /not approved/u,
  );
  const inventory = collectLicenses(
    {
      Unknown: [
        {
          name: "@anthropic-ai/claude-agent-sdk",
          versions: ["0.3.220"],
        },
      ],
    },
    policy,
  );
  assert.deepEqual(inventory[0], {
    concludedLicense: "LicenseRef-Anthropic-Claude-Agent-SDK-Terms",
    declarationSource: "locked-exception-policy",
    declaredLicense: "Unknown",
    exceptionId: "anthropic-claude-agent-sdk-terms",
    name: "@anthropic-ai/claude-agent-sdk",
    version: "0.3.220",
  });
  assert.throws(
    () =>
      matchLicensePolicy(
        "@anthropic-ai/claude-agent-sdk",
        "0.3.221",
        "Unknown",
        policy,
      ),
    /not approved/u,
  );
});

test("dependency artifacts are deterministic and contain no host paths", async (t) => {
  const temporary = await mkdtemp(
    join(tmpdir(), "replicantos-dependency-test-"),
  );
  t.after(() => rm(temporary, { force: true, recursive: true }));
  const output = join(temporary, "output");
  const run = () =>
    spawnSync(process.execPath, [script, "--output-dir", output], {
      encoding: "utf8",
    });

  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const firstInventory = await readFile(join(output, "licenses.json"), "utf8");
  const firstSbom = await readFile(join(output, "sbom.cdx.json"), "utf8");
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(
    await readFile(join(output, "licenses.json"), "utf8"),
    firstInventory,
  );
  assert.equal(
    await readFile(join(output, "sbom.cdx.json"), "utf8"),
    firstSbom,
  );

  const linkedScript = join(temporary, "dependency-artifacts.mjs");
  const linkedOutput = join(temporary, "linked-output");
  await symlink(script, linkedScript);
  const linkedRun = spawnSync(
    process.execPath,
    [linkedScript, "--output-dir", linkedOutput],
    { encoding: "utf8" },
  );
  assert.equal(linkedRun.status, 0, linkedRun.stderr);
  assert.equal(
    await readFile(join(linkedOutput, "licenses.json"), "utf8"),
    firstInventory,
  );
  assert.equal(
    await readFile(join(linkedOutput, "sbom.cdx.json"), "utf8"),
    firstSbom,
  );

  assertNoAbsolutePaths(firstInventory);
  assertNoAbsolutePaths(firstSbom);

  const inventory = JSON.parse(firstInventory);
  const sbom = JSON.parse(firstSbom);
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.specVersion, "1.6");
  assert.equal("timestamp" in sbom.metadata, false);
  assert.equal("serialNumber" in sbom, false);
  assert.equal(
    inventory.licenseExceptions.some(
      (entry) => entry.id === "anthropic-claude-agent-sdk-terms",
    ),
    false,
  );
  assert.deepEqual(inventory.licenseExceptions, []);
});

test("absolute-path guard reports the problem without echoing the path", () => {
  const privatePath = ["", "Users", "private-operator", "dependency"].join("/");
  assert.throws(
    () => assertNoAbsolutePaths(privatePath),
    /absolute user-home path/u,
  );
});

test("command diagnostics are bounded and redact runner paths", () => {
  const privatePath = ["", "home", "runner", "pnpm-store", "index.json"].join(
    "/",
  );
  const diagnostic = summarizeCommandFailure(
    `\u001B[31mERR_PNPM_TEST\u001B[0m package index missing (at ${privatePath}) ${"x".repeat(2_000)}`,
  );
  assert.match(diagnostic, /ERR_PNPM_TEST/u);
  assert.match(diagnostic, /<redacted-path>/u);
  assert.equal(diagnostic.includes(privatePath), false);
  assert.equal(diagnostic.length, 1_000);
});
