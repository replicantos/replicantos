#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { inspectPng } from "./lib/png.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const releaseMode = process.argv.includes("--release");
const source = JSON.parse(
  await readFile(resolve(root, "launch/x-posts.json"), "utf8"),
);
const policyBuffer = await readFile(
  resolve(root, "privacy/screenshot-policy.json"),
);
const screenshotPolicy = JSON.parse(policyBuffer.toString("utf8"));
const errors = [];

if (source.version !== 1) errors.push("launch content version must be 1");
if (!Array.isArray(source.posts) || source.posts.length !== 10)
  errors.push("exactly 10 X posts are required");

const ids = new Set();
const screenshots = new Set();
for (const [index, post] of (source.posts ?? []).entries()) {
  const label = `post ${index + 1}`;
  if (!post.id || ids.has(post.id))
    errors.push(`${label} must have a unique id`);
  ids.add(post.id);

  if (typeof post.copy !== "string" || post.copy.length === 0)
    errors.push(`${label} has no copy`);
  const measuredCopy = String(post.copy).replace(
    "{{GITHUB_URL}}",
    "https://replicantos.com/github",
  );
  if ([...measuredCopy].length > 280)
    errors.push(`${label} exceeds 280 characters after URL substitution`);

  if (!post.screenshot || screenshots.has(post.screenshot))
    errors.push(`${label} must have a unique screenshot`);
  screenshots.add(post.screenshot);
  if (!/^\d{2}-[a-z0-9-]+\.png$/u.test(post.screenshot ?? ""))
    errors.push(`${label} screenshot name is invalid`);

  if (typeof post.alt !== "string" || post.alt.length < 40)
    errors.push(`${label} needs descriptive alt text`);
  if (post.alt?.length > 1_000)
    errors.push(`${label} alt text exceeds 1000 characters`);

  if (releaseMode) {
    if (post.copy.includes("{{"))
      errors.push(`${label} still contains a placeholder`);
  }
}

const policyNames = screenshotPolicy.frames?.map((frame) => frame.name) ?? [];
if (
  screenshotPolicy.version !== 1 ||
  JSON.stringify(policyNames) !==
    JSON.stringify(source.posts?.map((post) => post.screenshot) ?? [])
) {
  errors.push("screenshot policy must exactly match the ordered X post plan");
}

if (releaseMode) {
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(resolve(root, "launch/screenshots/manifest.json"), "utf8"),
    );
  } catch {
    errors.push("sanitized screenshot manifest is missing or invalid");
  }
  const expectedPolicyHash = createHash("sha256")
    .update(policyBuffer)
    .digest("hex");
  if (
    manifest?.version !== 1 ||
    manifest?.policySha256 !== expectedPolicyHash
  ) {
    errors.push(
      "sanitized screenshot manifest is not bound to the current policy",
    );
  }

  for (const frame of screenshotPolicy.frames ?? []) {
    const path = resolve(root, "launch/screenshots", frame.name);
    let buffer;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("not a regular file");
      buffer = await readFile(path);
    } catch {
      errors.push(`${frame.name} sanitized screenshot is missing`);
      continue;
    }
    const inspection = inspectPng(buffer);
    if (inspection.errors.length > 0) {
      errors.push(`${frame.name} contains forbidden or invalid PNG metadata`);
    }
    if (
      inspection.width !== frame.width ||
      inspection.height !== frame.height
    ) {
      errors.push(`${frame.name} dimensions do not match screenshot policy`);
    }
    const manifestEntry = manifest?.files?.find(
      (entry) => entry.name === frame.name,
    );
    const digest = createHash("sha256").update(buffer).digest("hex");
    if (
      !manifestEntry ||
      manifestEntry.sha256 !== digest ||
      manifestEntry.width !== frame.width ||
      manifestEntry.height !== frame.height
    ) {
      errors.push(
        `${frame.name} does not match the sanitized screenshot manifest`,
      );
    }
  }
}

if (errors.length) {
  console.error(
    `Launch content validation failed:\n${errors.map((error) => `- ${error}`).join("\n")}`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `Launch content validation passed: ${source.posts.length} posts with unique screenshot plans and alt text.`,
  );
}
