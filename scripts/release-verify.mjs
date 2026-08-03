#!/usr/bin/env node

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = fileURLToPath(new URL("..", import.meta.url));
const EXPECTED_REPOSITORY = "replicantos/replicantos";
const EXPECTED_LICENSE = "MIT";
const EXPECTED_DISTRIBUTION = "self-hosted-only";
const CREDENTIAL_EXPOSURE_DISPOSITIONS = new Set([
  "no-known-credential-exposure",
  "all-known-exposed-credentials-rotated",
]);

function auditModeForArguments(argumentsList) {
  if (argumentsList.length === 0) return "release";
  if (argumentsList.length === 1 && argumentsList[0] === "--preflight") {
    return "preflight";
  }
  throw new Error("release audit received an unknown option");
}

function requireIntentionalAudit(mode, environment = process.env) {
  const key =
    mode === "preflight"
      ? "REPLICANTOS_ALLOW_RELEASE_PREFLIGHT"
      : "REPLICANTOS_ALLOW_RELEASE_VERIFY";
  if (environment[key] !== "1") {
    throw new Error(
      `set ${key}=1 only for an intentional release ${mode === "preflight" ? "preflight" : "audit"}`,
    );
  }
}

function minimalChildEnvironment(source = process.env) {
  const keys = [
    "CI",
    "COREPACK_HOME",
    "HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "LANG",
    "LC_ALL",
    "NO_PROXY",
    "PATH",
    "PLAYWRIGHT_BROWSERS_PATH",
    "PNPM_HOME",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "TMPDIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
  ];
  return {
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    ...Object.fromEntries(
      keys.filter((key) => source[key]).map((key) => [key, source[key]]),
    ),
  };
}

function run(label, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: options.env ?? minimalChildEnvironment(),
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) throw new Error(`${label} failed`);
  return result;
}

function isWithin(parent, candidate) {
  const relationship = relative(parent, candidate);
  return (
    relationship === "" ||
    (!relationship.startsWith(`..${sep}`) && relationship !== "..")
  );
}

async function requireExternalRegularFile(path, label) {
  if (!path)
    throw new Error(`${label} file is required outside the repository`);
  let repositoryPath;
  let actualPath;
  let stat;
  const requestedPath = resolve(path);
  try {
    [repositoryPath, actualPath] = await Promise.all([
      realpath(root),
      realpath(requestedPath),
    ]);
    stat = await lstat(actualPath);
  } catch {
    throw new Error(`${label} file could not be read`);
  }
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`${label} must be a regular file`);
  if (
    isWithin(repositoryPath, requestedPath) ||
    isWithin(repositoryPath, actualPath)
  ) {
    throw new Error(`${label} must remain outside the repository`);
  }
  return actualPath;
}

export function validateReleaseApprovals(
  approvals,
  head,
  requiredLicenseExceptions,
) {
  const validateExceptionList = (value, label) => {
    if (
      !Array.isArray(value) ||
      value.some(
        (id) =>
          typeof id !== "string" ||
          id.length === 0 ||
          id.trim() !== id ||
          !/^[a-z0-9][a-z0-9._-]*$/u.test(id),
      ) ||
      new Set(value).size !== value.length
    ) {
      throw new Error(`${label} must be unique nonempty identifiers`);
    }
    return [...value].sort();
  };
  const requiredExceptions =
    requiredLicenseExceptions == null
      ? null
      : validateExceptionList(
          requiredLicenseExceptions,
          "required dependency license exceptions",
        );
  const matchesRequiredExceptions = (accepted) =>
    requiredExceptions === null ||
    (accepted.length === requiredExceptions.length &&
      accepted.every((id, index) => id === requiredExceptions[index]));

  if (!approvals || approvals.version !== 3)
    throw new Error("release approval format is invalid");
  if (approvals.head !== head)
    throw new Error("release approvals are not bound to HEAD");
  if (approvals.repository !== EXPECTED_REPOSITORY) {
    throw new Error("release approvals target the wrong repository");
  }
  if (approvals.license !== EXPECTED_LICENSE) {
    throw new Error("release approvals target the wrong license");
  }
  if (approvals.distribution !== EXPECTED_DISTRIBUTION) {
    throw new Error(
      "release approvals must attest the self-hosted-only distribution",
    );
  }
  if (
    !CREDENTIAL_EXPOSURE_DISPOSITIONS.has(
      approvals.credentialExposureDisposition,
    )
  ) {
    throw new Error(
      "credential exposure disposition must be confirmed before release",
    );
  }
  if (approvals.githubNamespaceAuthorizationConfirmed !== true) {
    throw new Error(
      "GitHub namespace authorization must be confirmed before release",
    );
  }
  if (approvals.reviewGateDisposition === "owner-waived") {
    if (
      !Array.isArray(approvals.approvals) ||
      approvals.approvals.length !== 0
    ) {
      throw new Error(
        "an owner-waived release cannot contain reviewer approvals",
      );
    }
    const waiver = approvals.ownerWaiver;
    if (
      !waiver ||
      waiver.waivedBy !== "repository-owner" ||
      waiver.waivedHead !== head ||
      waiver.scope !== "two-independent-reviewers" ||
      waiver.acceptedCredentialExposureDisposition !==
        approvals.credentialExposureDisposition
    ) {
      throw new Error("owner waiver is incomplete or not bound to HEAD");
    }
    const acceptedExceptions = validateExceptionList(
      waiver.acceptedLicenseExceptions,
      "owner waiver license exceptions",
    );
    if (!matchesRequiredExceptions(acceptedExceptions)) {
      throw new Error(
        "owner waiver must explicitly accept all required dependency license exceptions",
      );
    }
    return;
  }
  if (approvals.reviewGateDisposition !== "two-independent-reviewers") {
    throw new Error("release review-gate disposition is invalid");
  }
  if (approvals.ownerWaiver != null) {
    throw new Error(
      "reviewer-approved releases cannot contain an owner waiver",
    );
  }
  if (!Array.isArray(approvals.approvals) || approvals.approvals.length < 2) {
    throw new Error("two independent release approvals are required");
  }

  const reviewerIds = new Set();
  for (const approval of approvals.approvals) {
    if (!/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(approval.reviewerId ?? "")) {
      throw new Error(
        "release approval contains an invalid reviewer identifier",
      );
    }
    reviewerIds.add(approval.reviewerId);
    if (approval.reviewedHead !== head) {
      throw new Error("every reviewer approval must be bound to HEAD");
    }
    if (
      approval.reviewedCredentialExposureDisposition !==
      approvals.credentialExposureDisposition
    ) {
      throw new Error(
        "every reviewer must confirm the credential exposure disposition",
      );
    }
    for (const attestation of [
      "privacyTreeAndHistoryReviewed",
      "syntheticMediaReviewed",
      "selfHostedOnlyReviewed",
      "dependencyLicensesReviewed",
    ]) {
      if (approval[attestation] !== true) {
        throw new Error(
          "every reviewer must complete every release attestation",
        );
      }
    }
    const reviewedExceptions = validateExceptionList(
      approval.reviewedLicenseExceptions,
      "reviewed dependency license exceptions",
    );
    if (!matchesRequiredExceptions(reviewedExceptions)) {
      throw new Error(
        "every reviewer must approve exactly the required dependency license exceptions",
      );
    }
  }
  if (reviewerIds.size < 2)
    throw new Error("release approvals must use independent reviewers");
}

function releaseReviewStatus(isPreflight, releaseApprovals) {
  if (isPreflight) return "pending";
  return releaseApprovals.reviewGateDisposition === "owner-waived"
    ? "owner-waived"
    : "verified";
}

async function requireReleaseApprovals(head) {
  const approvalsPath = await requireExternalRegularFile(
    process.env.REPLICANTOS_RELEASE_APPROVALS_FILE,
    "release approvals",
  );
  let approvals;
  try {
    approvals = JSON.parse(await readFile(approvalsPath, "utf8"));
  } catch {
    throw new Error("release approvals file is invalid");
  }
  // The base approval shape, credential exposure disposition, namespace
  // authorization, and reviewer attestations can be checked before the
  // expensive archive audit.
  // Package-specific exceptions are checked later against the dependency
  // inventory generated from the fresh frozen installation. This avoids
  // requiring approval for optional packages that are not in the release.
  validateReleaseApprovals(approvals, head, null);
  return approvals;
}

function requiredLicenseExceptionsFromInventory(inventory) {
  if (!inventory || !Array.isArray(inventory.licenseExceptions)) {
    throw new Error("release license inventory is invalid");
  }
  return inventory.licenseExceptions
    .filter((exception) => exception?.requiresReleaseApproval === true)
    .map((exception) => exception.id)
    .filter((id) => typeof id === "string" && id.length > 0)
    .sort();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeAtomic(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, value, { mode: 0o644 });
  await rename(temporary, path);
}

async function copyAtomic(source, destination) {
  const temporary = `${destination}.tmp`;
  await copyFile(source, temporary);
  await rename(temporary, destination);
}

async function assertReleaseIdentity() {
  const packageJson = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  if (packageJson.license !== EXPECTED_LICENSE) {
    throw new Error(
      `public release requires the ${EXPECTED_LICENSE} package license`,
    );
  }
  if (
    packageJson.repository?.type !== "git" ||
    packageJson.repository?.url !==
      "https://github.com/replicantos/replicantos.git"
  ) {
    throw new Error(
      "public release package metadata targets the wrong repository",
    );
  }
  let license;
  try {
    license = await readFile(join(root, "LICENSE"), "utf8");
  } catch {
    throw new Error("public release requires a committed LICENSE file");
  }
  if (
    !/MIT License/u.test(license) ||
    !/Permission is hereby granted/u.test(license)
  ) {
    throw new Error("LICENSE does not contain the MIT license grant");
  }
}

async function main() {
  const mode = auditModeForArguments(process.argv.slice(2));
  const isPreflight = mode === "preflight";
  requireIntentionalAudit(mode);

  const denylistPath = await requireExternalRegularFile(
    process.env.REPLICANTOS_PRIVATE_TERMS_FILE,
    "private denylist",
  );
  await assertReleaseIdentity();
  const head = run(
    "resolve release HEAD",
    "git",
    ["rev-parse", "--verify", "HEAD"],
    {
      capture: true,
    },
  ).stdout.trim();
  if (!/^[a-f0-9]{40,64}$/u.test(head))
    throw new Error("release HEAD is invalid");
  const releaseApprovals = isPreflight
    ? null
    : await requireReleaseApprovals(head);

  const status = run(
    "inspect release worktree",
    "git",
    ["status", "--porcelain=v1"],
    {
      capture: true,
    },
  );
  if (status.stdout.trim())
    throw new Error("release verification requires a clean Git worktree");

  run("release tree and Git-history privacy scan", process.execPath, [
    join(root, "scripts/privacy-check.mjs"),
    root,
    "--release",
    "--denylist",
    denylistPath,
  ]);

  const temporary = await mkdtemp(
    join(process.env.TMPDIR ?? "/tmp", "replicantos-release-"),
  );
  const archive = join(temporary, "source.tar");
  const extracted = join(temporary, "tree");
  const outputDirectory = resolve(
    process.env.REPLICANTOS_RELEASE_OUTPUT_DIR ??
      join(
        root,
        isPreflight ? "artifacts/release-preflight" : "artifacts/release-audit",
      ),
  );

  try {
    await mkdir(extracted, { recursive: true });
    await mkdir(outputDirectory, { recursive: true });
    run("create committed source archive", "git", [
      "archive",
      "--format=tar",
      `--output=${archive}`,
      head,
    ]);
    run("extract committed source archive", "tar", [
      "-xf",
      archive,
      "-C",
      extracted,
    ]);

    run("archive privacy scan", process.execPath, [
      join(extracted, "scripts/privacy-check.mjs"),
      extracted,
      "--release",
      "--tree-only",
      "--denylist",
      denylistPath,
    ]);
    run(
      "frozen dependency installation",
      "pnpm",
      ["install", "--frozen-lockfile"],
      {
        cwd: extracted,
      },
    );
    run("fresh archive verification", "pnpm", ["verify"], { cwd: extracted });
    run(
      "fresh Chromium installation",
      "pnpm",
      [
        "--filter",
        "@replicantos/e2e",
        "exec",
        "playwright",
        "install",
        "chromium",
      ],
      { cwd: extracted },
    );
    run("fresh archive end-to-end tests", "pnpm", ["test:e2e"], {
      cwd: extracted,
    });
    run(
      "release launch-content validation",
      process.execPath,
      [join(extracted, "scripts/validate-launch-content.mjs"), "--release"],
      { cwd: extracted },
    );
    run("dependency vulnerability audit", "pnpm", ["security:audit"], {
      cwd: extracted,
    });
    run(
      "dependency license and SBOM generation",
      process.execPath,
      [
        join(extracted, "scripts/generate-dependency-artifacts.mjs"),
        "--output-dir",
        outputDirectory,
      ],
      { cwd: extracted },
    );

    const [archiveBuffer, inventory, sbom] = await Promise.all([
      readFile(archive),
      readFile(join(outputDirectory, "licenses.json")),
      readFile(join(outputDirectory, "sbom.cdx.json")),
    ]);
    let parsedInventory;
    try {
      parsedInventory = JSON.parse(inventory.toString("utf8"));
    } catch {
      throw new Error("release license inventory is invalid");
    }
    const requiredLicenseExceptions =
      requiredLicenseExceptionsFromInventory(parsedInventory);
    if (releaseApprovals) {
      validateReleaseApprovals(
        releaseApprovals,
        head,
        requiredLicenseExceptions,
      );
    }
    const manifest = {
      version: 1,
      repository: EXPECTED_REPOSITORY,
      distribution: EXPECTED_DISTRIBUTION,
      head,
      license: EXPECTED_LICENSE,
      reviewStatus: releaseReviewStatus(isPreflight, releaseApprovals),
      requiredLicenseExceptions,
      sourceArchiveSha256: sha256(archiveBuffer),
      licenseInventorySha256: sha256(inventory),
      sbomSha256: sha256(sbom),
    };
    await Promise.all([
      copyAtomic(archive, join(outputDirectory, "source.tar")),
      writeAtomic(
        join(outputDirectory, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      ),
    ]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  const finalStatus = run(
    "confirm unchanged release worktree",
    "git",
    ["status", "--porcelain=v1"],
    { capture: true },
  );
  if (finalStatus.stdout.trim()) {
    throw new Error("release verification changed the committed worktree");
  }
  console.log(
    `${isPreflight ? "Release preflight" : "Release verification"} passed for ${head}.`,
  );
}

function isExecutedAsMain(
  argumentPath = process.argv[1],
  modulePath = fileURLToPath(import.meta.url),
) {
  if (!argumentPath) return false;
  try {
    return realpathSync(resolve(argumentPath)) === realpathSync(modulePath);
  } catch {
    return false;
  }
}

if (isExecutedAsMain()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export const releaseVerifierInternalsForTest = Object.freeze({
  auditModeForArguments,
  isExecutedAsMain,
  minimalChildEnvironment,
  releaseReviewStatus,
  requireIntentionalAudit,
  requiredLicenseExceptionsFromInventory,
});
