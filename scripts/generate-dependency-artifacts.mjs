#!/usr/bin/env node

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = fileURLToPath(new URL("..", import.meta.url));
const outputFlag = process.argv.indexOf("--output-dir");
if (outputFlag >= 0 && !process.argv[outputFlag + 1]) {
  throw new Error("--output-dir requires a path");
}
const outputDirectory = resolve(
  outputFlag >= 0
    ? process.argv[outputFlag + 1]
    : join(root, "release/artifacts"),
);

function commandJson(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const diagnostic = summarizeCommandFailure(result.stderr || result.stdout);
    throw new Error(
      `${command} ${args.join(" ")} failed without producing release evidence: ${diagnostic}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${command} ${args.join(" ")} returned invalid JSON`);
  }
}

function summarizeCommandFailure(stderr) {
  const normalized = String(stderr ?? "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r\n?/gu, "\n")
    .replace(
      /\/(?:Users|home)\/[^/\s"'()]+(?:\/[^\s"'()]*)?/gu,
      "<redacted-path>",
    )
    .replace(
      /[A-Z]:\\Users\\[^\\\s"'()]+(?:\\[^\s"'()]*)?/giu,
      "<redacted-path>",
    )
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length === 0) return "no diagnostic output";
  return normalized.slice(0, 1_000);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function purl(name, version) {
  let encodedName;
  if (name.startsWith("@") && name.includes("/")) {
    const slash = name.indexOf("/");
    encodedName = `${encodeURIComponent(name.slice(0, slash))}/${encodeURIComponent(name.slice(slash + 1))}`;
  } else encodedName = encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function dependencyGroups(node) {
  return [
    node.dependencies,
    node.devDependencies,
    node.optionalDependencies,
  ].filter((group) => group && typeof group === "object");
}

function collectInstalledGraph(listing) {
  const workspaceVersions = new Map(
    listing
      .filter(
        (node) =>
          typeof node.name === "string" && typeof node.version === "string",
      )
      .map((node) => [node.name, node.version]),
  );
  const components = new Map();
  const edges = new Map();

  function visit(node, fallbackName) {
    const name =
      typeof node.name === "string" ? node.name : (node.from ?? fallbackName);
    let version = node.version;
    if (typeof version === "string" && version.startsWith("link:")) {
      version = workspaceVersions.get(name);
    }
    if (
      typeof name !== "string" ||
      typeof version !== "string" ||
      version.length === 0
    )
      return;
    const reference = purl(name, version);
    components.set(reference, { name, version, reference });
    if (!edges.has(reference)) edges.set(reference, new Set());

    for (const group of dependencyGroups(node)) {
      for (const [dependencyName, dependency] of Object.entries(group)) {
        if (!dependency || typeof dependency !== "object") continue;
        const child = visit(dependency, dependencyName);
        if (child) edges.get(reference).add(child);
      }
    }
    return reference;
  }

  const roots = [];
  for (const node of listing) {
    const reference = visit(node, node.name);
    if (reference) roots.push(reference);
  }
  return {
    components,
    edges,
    roots: [...new Set(roots)],
    workspaceNames: new Set(workspaceVersions.keys()),
  };
}

function matchLicensePolicy(name, version, declaredLicense, policy) {
  if (policy.allowedSpdxLicenses.includes(declaredLicense)) {
    return { concludedLicense: declaredLicense };
  }
  const exception = policy.exceptions.find(
    (candidate) =>
      candidate.version === version &&
      candidate.declaredLicense === declaredLicense &&
      new RegExp(candidate.packagePattern, "u").test(name),
  );
  if (!exception) {
    throw new Error(
      `dependency license is not approved: ${name}@${version} (${declaredLicense})`,
    );
  }
  return {
    concludedLicense: exception.concludedLicense,
    exceptionId: exception.id,
  };
}

function collectLicenses(rawLicenses, policy) {
  const packages = [];
  for (const [declaredLicense, entries] of Object.entries(rawLicenses)) {
    if (!Array.isArray(entries))
      throw new Error("pnpm license inventory has an invalid shape");
    for (const entry of entries) {
      for (const version of entry.versions ?? []) {
        const conclusion = matchLicensePolicy(
          entry.name,
          version,
          declaredLicense,
          policy,
        );
        const lockedDeclaration = policy.lockedPackageLicenses.find(
          (candidate) =>
            candidate.versions.includes(version) &&
            new RegExp(candidate.packagePattern, "u").test(entry.name),
        );
        if (
          lockedDeclaration &&
          lockedDeclaration.declaredLicense !== declaredLicense
        ) {
          throw new Error(
            `locked license declaration changed for ${entry.name}@${version}`,
          );
        }
        packages.push({
          concludedLicense: conclusion.concludedLicense,
          declaredLicense,
          ...(lockedDeclaration
            ? { declarationSource: "locked-package-policy" }
            : {}),
          ...(conclusion.exceptionId
            ? {
                declarationSource: "locked-exception-policy",
                exceptionId: conclusion.exceptionId,
              }
            : {}),
          name: entry.name,
          version,
        });
      }
    }
  }
  packages.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.version.localeCompare(right.version),
  );
  return packages;
}

function cyclonedxLicense(entry) {
  if (entry.concludedLicense.startsWith("LicenseRef-")) {
    return { license: { name: entry.concludedLicense } };
  }
  return { license: { id: entry.concludedLicense } };
}

function repositoryCyclonedxLicense(repositoryLicense, policy) {
  return policy.allowedSpdxLicenses.includes(repositoryLicense)
    ? { license: { id: repositoryLicense } }
    : { license: { name: repositoryLicense } };
}

function assertNoAbsolutePaths(serialized) {
  const patterns = [
    /\/Users\/[A-Za-z0-9._-]+(?:\/|\b)/u,
    /\/home\/[A-Za-z0-9._-]+(?:\/|\b)/u,
    /[A-Z]:\\Users\\/iu,
  ];
  if (patterns.some((pattern) => pattern.test(serialized))) {
    throw new Error("dependency artifact contains an absolute user-home path");
  }
}

function createArtifacts({
  listing,
  lockfile,
  policy,
  policyBuffer,
  rawLicenses,
  rootPackage,
}) {
  const graph = collectInstalledGraph(listing);
  const licenses = collectLicenses(rawLicenses, policy);
  const licenseByPackage = new Map(
    licenses.map((entry) => [`${entry.name}\0${entry.version}`, entry]),
  );

  for (const component of graph.components.values()) {
    const key = `${component.name}\0${component.version}`;
    if (licenseByPackage.has(key) || graph.workspaceNames.has(component.name))
      continue;
    const lockedLicense = policy.lockedPackageLicenses.find(
      (candidate) =>
        candidate.versions.includes(component.version) &&
        new RegExp(candidate.packagePattern, "u").test(component.name),
    );
    if (lockedLicense) {
      const inferred = {
        concludedLicense: lockedLicense.declaredLicense,
        declarationSource: "locked-package-policy",
        declaredLicense: lockedLicense.declaredLicense,
        name: component.name,
        version: component.version,
      };
      licenses.push(inferred);
      licenseByPackage.set(key, inferred);
      continue;
    }
    const exception = policy.exceptions.find(
      (candidate) =>
        candidate.version === component.version &&
        new RegExp(candidate.packagePattern, "u").test(component.name),
    );
    if (!exception) {
      throw new Error(
        `no license declaration was found for installed dependency ${component.name}@${component.version}`,
      );
    }
    const inferred = {
      concludedLicense: exception.concludedLicense,
      declaredLicense: exception.declaredLicense,
      exceptionId: exception.id,
      declarationSource: "locked-exception-policy",
      name: component.name,
      version: component.version,
    };
    licenses.push(inferred);
    licenseByPackage.set(key, inferred);
  }
  licenses.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.version.localeCompare(right.version),
  );

  for (const entry of licenses) {
    const reference = purl(entry.name, entry.version);
    if (!graph.components.has(reference)) {
      graph.components.set(reference, {
        name: entry.name,
        reference,
        version: entry.version,
      });
      graph.edges.set(reference, new Set());
    }
  }

  const rootVersion = rootPackage.version ?? "0.0.0";
  const rootReference = purl(rootPackage.name, rootVersion);
  const repositoryLicense = rootPackage.license ?? "UNLICENSED";
  const components = [...graph.components.values()]
    .filter((component) => component.reference !== rootReference)
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.version.localeCompare(right.version),
    )
    .map((component) => {
      const license = licenseByPackage.get(
        `${component.name}\0${component.version}`,
      );
      if (!license && !graph.workspaceNames.has(component.name)) {
        throw new Error(
          `no license declaration was found for installed dependency ${component.name}@${component.version}`,
        );
      }
      const properties = [];
      if (license) {
        properties.push({
          name: "replicantos:declaredLicense",
          value: license.declaredLicense,
        });
        if (license.declarationSource) {
          properties.push({
            name: "replicantos:licenseDeclarationSource",
            value: license.declarationSource,
          });
        }
        if (license.exceptionId) {
          properties.push({
            name: "replicantos:licenseException",
            value: license.exceptionId,
          });
        }
      }
      return {
        "bom-ref": component.reference,
        type: "library",
        name: component.name,
        version: component.version,
        purl: component.reference,
        licenses: license
          ? [cyclonedxLicense(license)]
          : [repositoryCyclonedxLicense(repositoryLicense, policy)],
        ...(properties.length > 0 ? { properties } : {}),
      };
    });

  const dependencies = [...graph.edges.entries()]
    .map(([reference, dependencyReferences]) => ({
      ref: reference,
      dependsOn: [...dependencyReferences].sort(),
    }))
    .sort((left, right) => left.ref.localeCompare(right.ref));
  const lockfileSha256 = sha256(lockfile);
  const policySha256 = sha256(policyBuffer);
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        "bom-ref": rootReference,
        type: "application",
        name: rootPackage.name,
        version: rootVersion,
        licenses: [repositoryCyclonedxLicense(repositoryLicense, policy)],
        purl: rootReference,
      },
      properties: [
        { name: "replicantos:lockfileSha256", value: lockfileSha256 },
        { name: "replicantos:licensePolicySha256", value: policySha256 },
      ],
    },
    components,
    dependencies,
  };
  const inventory = {
    version: 1,
    lockfileSha256,
    policySha256,
    repositoryLicense,
    licenseExceptions: policy.exceptions
      .filter((exception) =>
        licenses.some((entry) => entry.exceptionId === exception.id),
      )
      .map((exception) => ({
        concludedLicense: exception.concludedLicense,
        id: exception.id,
        requiresReleaseApproval: exception.requiresReleaseApproval,
        termsUrl: exception.termsUrl,
      })),
    packages: licenses,
  };
  return { inventory, sbom };
}

async function writeAtomic(path, content) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, content, { mode: 0o644 });
  await rename(temporary, path);
}

async function main() {
  const [lockfile, policyBuffer, rootPackageBuffer] = await Promise.all([
    readFile(join(root, "pnpm-lock.yaml")),
    readFile(join(root, "privacy/license-policy.json")),
    readFile(join(root, "package.json")),
  ]);
  const policy = JSON.parse(policyBuffer.toString("utf8"));
  if (
    policy.version !== 1 ||
    !Array.isArray(policy.allowedSpdxLicenses) ||
    !Array.isArray(policy.lockedPackageLicenses) ||
    !Array.isArray(policy.exceptions)
  ) {
    throw new Error("privacy/license-policy.json is malformed");
  }
  const listing = commandJson("pnpm", [
    "list",
    "--recursive",
    "--depth",
    "Infinity",
    "--json",
  ]);
  // pnpm's optional-dependency scanner can require store entries for packages
  // that were intentionally pruned on the current platform. Scan the portable
  // dependency set here; every omitted optional node must match an exact
  // declaration in the reviewed policy below or artifact generation fails.
  const rawLicenses = commandJson("pnpm", [
    "licenses",
    "list",
    "--json",
    "--no-optional",
  ]);
  const artifacts = createArtifacts({
    listing,
    lockfile,
    policy,
    policyBuffer,
    rawLicenses,
    rootPackage: JSON.parse(rootPackageBuffer.toString("utf8")),
  });
  const inventory = `${JSON.stringify(artifacts.inventory, null, 2)}\n`;
  const sbom = `${JSON.stringify(artifacts.sbom, null, 2)}\n`;
  assertNoAbsolutePaths(inventory);
  assertNoAbsolutePaths(sbom);

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeAtomic(join(outputDirectory, "licenses.json"), inventory),
    writeAtomic(join(outputDirectory, "sbom.cdx.json"), sbom),
  ]);
  console.log(
    `Generated deterministic license inventory and CycloneDX SBOM for ${artifacts.inventory.packages.length} lockfile-reachable package versions.`,
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

export const dependencyArtifactInternalsForTest = Object.freeze({
  assertNoAbsolutePaths,
  collectInstalledGraph,
  collectLicenses,
  createArtifacts,
  isExecutedAsMain,
  matchLicensePolicy,
  purl,
  summarizeCommandFailure,
});
