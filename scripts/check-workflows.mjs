#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = fileURLToPath(new URL("..", import.meta.url));
const workflowDirectory = join(root, ".github/workflows");
const policy = JSON.parse(
  await readFile(join(root, "privacy/github-actions-policy.json"), "utf8"),
);
const allowedActions = new Map(
  policy.actions.map((entry) => [entry.action, entry]),
);
const allowedSecrets = new Set(policy.allowedWorkflowSecrets);
const errors = [];

for (const file of (await readdir(workflowDirectory)).sort()) {
  if (!/\.ya?ml$/u.test(file)) continue;
  const text = await readFile(join(workflowDirectory, file), "utf8");
  if (!/^permissions:\n  contents: read$/mu.test(text)) {
    errors.push(`${file}: top-level permissions must be contents: read only`);
  }
  if (/pull_request_target\s*:/u.test(text)) {
    errors.push(`${file}: pull_request_target is forbidden`);
  }
  if (
    /permissions:[^\n]*write|(?:contents|actions|checks|id-token|packages|pull-requests):\s*write/iu.test(
      text,
    )
  ) {
    errors.push(`${file}: write permissions are forbidden`);
  }
  if (/secrets:\s*inherit/u.test(text))
    errors.push(`${file}: inherited secrets are forbidden`);

  for (const match of text.matchAll(
    /^\s*uses:\s*([^\s#]+)(?:\s*#\s*(\S+))?/gmu,
  )) {
    const reference = match[1];
    if (reference.startsWith("./")) continue;
    const separator = reference.lastIndexOf("@");
    const action = reference.slice(0, separator);
    const sha = reference.slice(separator + 1);
    const approved = allowedActions.get(action);
    if (!approved || !/^[a-f0-9]{40}$/u.test(sha) || approved.sha !== sha) {
      errors.push(
        `${file}: action ${action || "[invalid]"} is not pinned to the approved SHA`,
      );
      continue;
    }
    if (match[2] !== approved.version) {
      errors.push(
        `${file}: action ${action} must carry its reviewed version comment`,
      );
    }
  }

  for (const match of text.matchAll(/secrets\.([A-Z0-9_]+)/gu)) {
    if (!allowedSecrets.has(match[1]))
      errors.push(`${file}: unapproved workflow secret reference`);
  }
  if (file === "ci.yml" && /secrets\./u.test(text)) {
    errors.push("ci.yml: pull-request CI must not consume repository secrets");
  }
  if (file === "release-audit.yml") {
    if (!/^on:\n  workflow_dispatch:/mu.test(text)) {
      errors.push("release-audit.yml: release audit must be manual only");
    }
    if (!/^    environment: public-release$/mu.test(text)) {
      errors.push(
        "release-audit.yml: public-release environment review is required",
      );
    }
  }
}

if (errors.length > 0) {
  console.error(
    `Workflow policy check failed:\n${errors.map((error) => `- ${error}`).join("\n")}`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `Workflow policy check passed for ${allowedActions.size} SHA-pinned actions.`,
  );
}
