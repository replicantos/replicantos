#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { stripPngMetadata } from "./lib/png.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function parseArguments(argumentsList) {
  const values = {
    output: join(root, "launch/screenshots"),
    source: join(root, "artifacts/screenshots"),
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument !== "--source" && argument !== "--output") {
      throw new Error(`unknown option: ${argument}`);
    }
    const value = argumentsList[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`${argument} requires a path`);
    values[argument.slice(2)] = resolve(value);
    index += 1;
  }
  return values;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function validatePolicy(policy, posts) {
  if (
    policy.version !== 1 ||
    !Array.isArray(policy.frames) ||
    policy.frames.length !== 10
  ) {
    throw new Error(
      "screenshot policy must contain exactly ten version-1 frames",
    );
  }
  const policyNames = policy.frames.map((frame) => frame.name);
  const postNames = posts.posts?.map((post) => post.screenshot) ?? [];
  if (JSON.stringify(policyNames) !== JSON.stringify(postNames)) {
    throw new Error(
      "screenshot policy must exactly match the ordered X post screenshot plan",
    );
  }
  for (const frame of policy.frames) {
    if (
      basename(frame.name) !== frame.name ||
      !/^\d{2}-[a-z0-9-]+\.png$/u.test(frame.name) ||
      !Number.isInteger(frame.width) ||
      !Number.isInteger(frame.height) ||
      frame.width < 1 ||
      frame.height < 1
    ) {
      throw new Error("screenshot policy contains an invalid frame");
    }
  }
}

async function assertRegularFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("screenshot source is not a regular file");
}

async function compareExisting(outputDirectory, stagedDirectory, names) {
  let existing;
  try {
    existing = (await readdir(outputDirectory)).sort();
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT")
      return false;
    throw error;
  }
  const expected = [...names, "manifest.json"].sort();
  if (JSON.stringify(existing) !== JSON.stringify(expected)) {
    throw new Error(
      "launch/screenshots already exists with unexpected contents; review it manually",
    );
  }
  for (const name of expected) {
    const [current, staged] = await Promise.all([
      readFile(join(outputDirectory, name)),
      readFile(join(stagedDirectory, name)),
    ]);
    if (!current.equals(staged)) {
      throw new Error(
        "launch/screenshots differs from the deterministic promotion; review it manually",
      );
    }
  }
  return true;
}

async function main() {
  if (process.env.REPLICANTOS_PROMOTE_SCREENSHOTS !== "1") {
    throw new Error(
      "set REPLICANTOS_PROMOTE_SCREENSHOTS=1 only after human review of the synthetic capture",
    );
  }
  const paths = parseArguments(process.argv.slice(2));
  const policyPath = join(root, "privacy/screenshot-policy.json");
  const postsPath = join(root, "launch/x-posts.json");
  const [policyBuffer, policy, posts] = await Promise.all([
    readFile(policyPath),
    readJson(policyPath),
    readJson(postsPath),
  ]);
  validatePolicy(policy, posts);

  await mkdir(dirname(paths.output), { recursive: true });
  const staging = await mkdtemp(
    join(dirname(paths.output), ".screenshots-stage-"),
  );
  try {
    const manifestFiles = [];
    for (const frame of policy.frames) {
      const source = join(paths.source, frame.name);
      await assertRegularFile(source);
      const sanitized = stripPngMetadata(await readFile(source));
      if (
        sanitized.width !== frame.width ||
        sanitized.height !== frame.height
      ) {
        throw new Error(
          `${frame.name} must be ${frame.width}x${frame.height}; received ${sanitized.width}x${sanitized.height}`,
        );
      }
      await writeFile(join(staging, frame.name), sanitized.buffer, {
        flag: "wx",
        mode: 0o644,
      });
      manifestFiles.push({
        height: sanitized.height,
        name: frame.name,
        sha256: sha256(sanitized.buffer),
        width: sanitized.width,
      });
    }

    const manifest = {
      version: 1,
      policySha256: sha256(policyBuffer),
      files: manifestFiles,
    };
    await writeFile(
      join(staging, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        flag: "wx",
        mode: 0o644,
      },
    );

    if (
      await compareExisting(
        paths.output,
        staging,
        policy.frames.map((frame) => frame.name),
      )
    ) {
      console.log(
        "Launch screenshots already match the deterministic sanitized promotion.",
      );
      return;
    }
    await rename(staging, paths.output);
    console.log(
      "Promoted ten sanitized synthetic launch screenshots to launch/screenshots.",
    );
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
