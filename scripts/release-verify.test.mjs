import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  releaseVerifierInternalsForTest,
  validateReleaseApprovals,
} from "./release-verify.mjs";

const head = "a".repeat(40);
const exception = "anthropic-claude-agent-sdk-terms";
const releaseScript = fileURLToPath(
  new URL("./release-verify.mjs", import.meta.url),
);

function approval(reviewerId) {
  return {
    reviewerId,
    reviewedHead: head,
    privacyTreeAndHistoryReviewed: true,
    syntheticMediaReviewed: true,
    reviewedCredentialExposureDisposition: "no-known-credential-exposure",
    selfHostedOnlyReviewed: true,
    dependencyLicensesReviewed: true,
    reviewedLicenseExceptions: [exception],
  };
}

function approvals() {
  return {
    version: 2,
    head,
    repository: "replicantos/replicantos",
    license: "MIT",
    distribution: "self-hosted-only",
    credentialExposureDisposition: "no-known-credential-exposure",
    githubNamespaceAuthorizationConfirmed: true,
    approvals: [approval("reviewer-one"), approval("reviewer-two")],
  };
}

test("accepts two complete independent approvals bound to HEAD", () => {
  assert.doesNotThrow(() =>
    validateReleaseApprovals(approvals(), head, [exception]),
  );
});

test("requires approval only for exceptions present in the release inventory", () => {
  const baseApprovals = approvals();
  for (const entry of baseApprovals.approvals) {
    entry.reviewedLicenseExceptions = [];
  }
  assert.doesNotThrow(() => validateReleaseApprovals(baseApprovals, head, []));

  assert.deepEqual(
    releaseVerifierInternalsForTest.requiredLicenseExceptionsFromInventory({
      licenseExceptions: [
        {
          id: "runtime-library-exception",
          requiresReleaseApproval: false,
        },
        {
          id: exception,
          requiresReleaseApproval: true,
        },
      ],
    }),
    [exception],
  );
});

test("rejects duplicate reviewers and incomplete attestations", () => {
  const duplicate = approvals();
  duplicate.approvals[1].reviewerId = duplicate.approvals[0].reviewerId;
  assert.throws(
    () => validateReleaseApprovals(duplicate, head, [exception]),
    /independent reviewers/u,
  );

  const incomplete = approvals();
  incomplete.approvals[0].syntheticMediaReviewed = false;
  assert.throws(
    () => validateReleaseApprovals(incomplete, head, [exception]),
    /every release attestation/u,
  );
});

test("accepts either reviewed credential exposure disposition", () => {
  const rotated = approvals();
  rotated.credentialExposureDisposition =
    "all-known-exposed-credentials-rotated";
  for (const entry of rotated.approvals) {
    entry.reviewedCredentialExposureDisposition =
      "all-known-exposed-credentials-rotated";
  }
  assert.doesNotThrow(() =>
    validateReleaseApprovals(rotated, head, [exception]),
  );
});

test("rejects wrong commits, missing credential disposition, and unreviewed license exceptions", () => {
  const wrongHead = approvals();
  wrongHead.head = "b".repeat(40);
  assert.throws(
    () => validateReleaseApprovals(wrongHead, head, [exception]),
    /bound to HEAD/u,
  );

  const credentialDisposition = approvals();
  credentialDisposition.credentialExposureDisposition = "review-required";
  assert.throws(
    () => validateReleaseApprovals(credentialDisposition, head, [exception]),
    /credential exposure disposition/u,
  );

  const missingCredentialDisposition = approvals();
  delete missingCredentialDisposition.credentialExposureDisposition;
  assert.throws(
    () =>
      validateReleaseApprovals(missingCredentialDisposition, head, [exception]),
    /credential exposure disposition/u,
  );

  const legacyCredentialRecord = approvals();
  delete legacyCredentialRecord.credentialExposureDisposition;
  legacyCredentialRecord.credentialRotationConfirmed = true;
  assert.throws(
    () => validateReleaseApprovals(legacyCredentialRecord, head, [exception]),
    /credential exposure disposition/u,
  );

  const credentialReview = approvals();
  credentialReview.approvals[1].reviewedCredentialExposureDisposition =
    "all-known-exposed-credentials-rotated";
  assert.throws(
    () => validateReleaseApprovals(credentialReview, head, [exception]),
    /reviewer must confirm the credential exposure disposition/u,
  );

  const publication = approvals();
  publication.githubNamespaceAuthorizationConfirmed = false;
  assert.throws(
    () => validateReleaseApprovals(publication, head, [exception]),
    /namespace authorization/u,
  );

  const licenses = approvals();
  licenses.approvals[1].reviewedLicenseExceptions = [];
  assert.throws(
    () => validateReleaseApprovals(licenses, head, [exception]),
    /license exceptions/u,
  );
});

test("rejects legacy approval schema versions", () => {
  const legacy = approvals();
  legacy.version = 1;
  assert.throws(
    () => validateReleaseApprovals(legacy, head, [exception]),
    /approval format/u,
  );
});

test("release subprocess environment drops unrelated credentials", () => {
  const environment = releaseVerifierInternalsForTest.minimalChildEnvironment({
    HOME: "/synthetic-home",
    PATH: "/synthetic-bin",
    UNRELATED_CREDENTIAL: "must-not-propagate",
  });
  assert.deepEqual(environment, {
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    HOME: "/synthetic-home",
    PATH: "/synthetic-bin",
  });
});

test("release audit mode is explicit and fail-closed", () => {
  const { auditModeForArguments, requireIntentionalAudit } =
    releaseVerifierInternalsForTest;
  assert.equal(auditModeForArguments([]), "release");
  assert.equal(auditModeForArguments(["--preflight"]), "preflight");
  assert.throws(() => auditModeForArguments(["--unknown"]), /unknown option/u);
  assert.throws(
    () => auditModeForArguments(["--preflight", "extra"]),
    /unknown option/u,
  );
  assert.doesNotThrow(() =>
    requireIntentionalAudit("release", {
      REPLICANTOS_ALLOW_RELEASE_VERIFY: "1",
    }),
  );
  assert.doesNotThrow(() =>
    requireIntentionalAudit("preflight", {
      REPLICANTOS_ALLOW_RELEASE_PREFLIGHT: "1",
    }),
  );
  assert.throws(
    () => requireIntentionalAudit("release", {}),
    /ALLOW_RELEASE_VERIFY/u,
  );
  assert.throws(
    () => requireIntentionalAudit("preflight", {}),
    /ALLOW_RELEASE_PREFLIGHT/u,
  );
});

test("release audit remains fail-closed through a symlinked entry path", async (t) => {
  if (process.platform === "win32") {
    t.skip("entry-point symlinks require elevated privileges on Windows");
    return;
  }
  const temporary = await mkdtemp(join(tmpdir(), "replicantos-release-test-"));
  t.after(() => rm(temporary, { force: true, recursive: true }));
  const linkedScript = join(temporary, "release-verify.mjs");
  await symlink(releaseScript, linkedScript);

  const result = spawnSync(process.execPath, [linkedScript], {
    encoding: "utf8",
    env: {},
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ALLOW_RELEASE_VERIFY/u);
});
