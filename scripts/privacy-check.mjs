#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { inspectPng } from "./lib/png.mjs";

function parseArguments(argumentsList) {
  const options = {
    denylistPath: undefined,
    release: false,
    root: ".",
    treeOnly: false,
  };
  let rootSeen = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--release") options.release = true;
    else if (argument === "--tree-only") options.treeOnly = true;
    else if (argument === "--denylist") {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error("--denylist requires a file path");
      options.denylistPath = value;
      index += 1;
    } else if (argument.startsWith("-"))
      throw new Error(`unknown option: ${argument}`);
    else if (rootSeen)
      throw new Error("privacy check accepts only one release-tree path");
    else {
      options.root = argument;
      rootSeen = true;
    }
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
const ROOT = resolve(options.root);
const DENYLIST_PATH =
  options.denylistPath ?? process.env.REPLICANTOS_PRIVATE_TERMS_FILE;

const SKIP_DIRECTORIES = new Set([
  ".git",
  ".astro",
  ".next",
  ".turbo",
  "artifacts",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

const DENIED_EXTENSIONS = new Set([
  ".bundle",
  ".db",
  ".gz",
  ".jks",
  ".keystore",
  ".key",
  ".log",
  ".m4a",
  ".mobileprovision",
  ".mov",
  ".mp3",
  ".mp4",
  ".p12",
  ".pem",
  ".pfx",
  ".shm",
  ".sqlite",
  ".sqlite3",
  ".tar",
  ".tgz",
  ".wal",
  ".wav",
  ".zip",
]);

const APPROVED_BINARY_ROOTS = [
  "apps/site/public/",
  "apps/site/src/assets/",
  "apps/web/public/",
  "docs/assets/",
  "launch/screenshots/",
  "packages/ui/assets/",
];

const APPROVED_BINARY_EXTENSIONS = new Set([
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
  ".woff2",
]);
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

const EMAIL_PATTERN =
  /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,}|example\.invalid)\b/giu;
const ABSOLUTE_PATH_PATTERNS = [
  /\/Users\/[A-Za-z0-9._-]+(?:\/|\b)/gu,
  /\/home\/[A-Za-z0-9._-]+(?:\/|\b)/gu,
  /[A-Z]:\\Users\\[A-Za-z0-9._-]+(?:\\|\b)/giu,
];

const SECRET_PATTERNS = [
  {
    label: "private key material",
    pattern: new RegExp(
      ["-{5}", "BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY", "-{5}"].join(""),
      "gu",
    ),
  },
  {
    label: "JWT-like token",
    pattern:
      /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/gu,
  },
  {
    label: "OpenAI or xAI key-like token",
    pattern: /\b(?:sk-(?:proj-)?|xai-)[A-Za-z0-9_-]{20,}\b/gu,
  },
  {
    label: "Anthropic key-like token",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/gu,
  },
  {
    label: "GitHub token-like value",
    pattern: /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{30,}\b/gu,
  },
  {
    label: "AWS access key-like value",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  },
  {
    label: "Google API key-like value",
    pattern: /\bAIza[A-Za-z0-9_-]{30,}\b/gu,
  },
  {
    label: "Slack token-like value",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu,
  },
];

const findings = [];
let resolvedDenylistPath;

function normalizePath(path) {
  return path.split(sep).join("/");
}

function addFinding(path, reason, detail) {
  findings.push({ path, reason, ...(detail ? { detail } : {}) });
}

function isAllowedEmail(email) {
  const normalized = email.toLowerCase();
  return (
    normalized.endsWith("@example.invalid") ||
    normalized.endsWith("@replicantos.com")
  );
}

function isWithin(parent, candidate) {
  const relationship = relative(parent, candidate);
  return (
    relationship === "" ||
    (!relationship.startsWith(`..${sep}`) && relationship !== "..")
  );
}

async function loadDenyTerms() {
  if (!DENYLIST_PATH) {
    if (options.release)
      throw new Error("release mode requires an external private denylist");
    return [];
  }

  let rootRealPath;
  let denylistRealPath;
  let content;
  const requestedDenylistPath = resolve(DENYLIST_PATH);
  try {
    [rootRealPath, denylistRealPath] = await Promise.all([
      realpath(ROOT),
      realpath(requestedDenylistPath),
    ]);
    content = await readFile(denylistRealPath, "utf8");
  } catch {
    throw new Error("private denylist could not be read");
  }

  if (
    options.release &&
    (isWithin(rootRealPath, requestedDenylistPath) ||
      isWithin(rootRealPath, denylistRealPath))
  ) {
    throw new Error(
      "release mode requires the private denylist to be outside the repository",
    );
  }
  resolvedDenylistPath = denylistRealPath;

  const terms = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length >= 3 && !line.startsWith("#"));
  if (options.release && terms.length === 0) {
    throw new Error("release mode requires a nonempty private denylist");
  }
  return [...new Set(terms.map((term) => term.normalize("NFKC")))];
}

async function collectFiles(directory, output = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;

    const absolute = resolve(directory, entry.name);
    if (resolvedDenylistPath && absolute === resolvedDenylistPath) continue;
    const repositoryPath = normalizePath(relative(ROOT, absolute));
    const stat = await lstat(absolute);

    if (stat.isSymbolicLink()) {
      addFinding(
        repositoryPath,
        "symbolic links are not allowed in the release tree",
      );
      continue;
    }
    if (stat.isDirectory()) {
      await collectFiles(absolute, output);
      continue;
    }
    if (stat.isFile())
      output.push({ absolute, repositoryPath, size: stat.size });
  }
  return output;
}

function inspectFilename(repositoryPath, findingPath = repositoryPath) {
  const lower = repositoryPath.toLowerCase();
  const filename = lower.slice(lower.lastIndexOf("/") + 1);
  const extension = extname(lower);

  if (DENIED_EXTENSIONS.has(extension)) {
    addFinding(findingPath, `denied release extension: ${extension}`);
  }

  if (
    filename === ".env" ||
    (filename.endsWith(".env") && filename !== ".env.example") ||
    (filename.startsWith(".env.") && filename !== ".env.example")
  ) {
    addFinding(
      findingPath,
      "environment files are forbidden; only .env.example is allowed",
    );
  }

  if (
    /^(?:data|runtime|workspaces|uploads|backups|logs|sessions|browser-profiles)(?:\/|$)/u.test(
      lower,
    )
  ) {
    addFinding(findingPath, "runtime-state path is forbidden");
  }

  if (/(?:auth\.json|settings\.local\.json|credentials\.json)$/u.test(lower)) {
    addFinding(
      findingPath,
      "authentication or local credential store is forbidden",
    );
  }
}

function inspectText(repositoryPath, text, denyTerms) {
  for (const match of text.matchAll(EMAIL_PATTERN)) {
    const email = match[0];
    if (!isAllowedEmail(email))
      addFinding(repositoryPath, "non-project email address", redact(email));
  }

  for (const pattern of ABSOLUTE_PATH_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match)
      addFinding(repositoryPath, "absolute user-home path", redact(match[0]));
  }

  for (const { label, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) addFinding(repositoryPath, label, redact(match[0]));
  }

  const normalized = text.normalize("NFKC").toLocaleLowerCase("en-US");
  for (const term of denyTerms) {
    if (normalized.includes(term.toLocaleLowerCase("en-US"))) {
      addFinding(
        repositoryPath,
        "matched private release denylist",
        hashHint(term),
      );
    }
  }
}

function redact(value) {
  return hashHint(value);
}

function hashHint(value) {
  return `value-${createHash("sha256").update(value.toLocaleLowerCase("en-US")).digest("hex").slice(0, 12)}`;
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

function binaryIsApproved(repositoryPath) {
  const extension = extname(repositoryPath).toLowerCase();
  return (
    APPROVED_BINARY_EXTENSIONS.has(extension) &&
    APPROVED_BINARY_ROOTS.some((root) => repositoryPath.startsWith(root))
  );
}

function inspectBuffer(
  repositoryPath,
  buffer,
  denyTerms,
  policyPath = repositoryPath,
) {
  inspectFilename(policyPath, repositoryPath);
  inspectText(repositoryPath, policyPath, denyTerms);

  if (buffer.length > MAX_TEXT_BYTES && !binaryIsApproved(policyPath)) {
    addFinding(
      repositoryPath,
      `file exceeds ${MAX_TEXT_BYTES} byte source limit`,
    );
    return;
  }

  if (looksBinary(buffer)) {
    if (!binaryIsApproved(policyPath)) {
      addFinding(
        repositoryPath,
        "unexpected binary file outside approved asset roots",
      );
      return;
    }
    if (extname(policyPath).toLowerCase() === ".png") {
      const inspection = inspectPng(buffer);
      for (const error of inspection.errors) addFinding(repositoryPath, error);
    }
    return;
  }

  inspectText(repositoryPath, buffer.toString("utf8"), denyTerms);
}

async function inspectFile(file, denyTerms) {
  inspectBuffer(file.repositoryPath, await readFile(file.absolute), denyTerms);
}

function git(args, { encoding = "utf8" } = {}) {
  return spawnSync("git", args, {
    cwd: ROOT,
    encoding,
    env: {
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      LC_ALL: "C",
      PATH: process.env.PATH,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    },
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function loadAllowedAuthors() {
  let allowed;
  try {
    allowed = JSON.parse(
      await readFile(resolve(ROOT, "privacy/allowed-authors.json"), "utf8"),
    );
  } catch {
    addFinding(
      "privacy/allowed-authors.json",
      "missing or invalid allowed-author policy",
    );
    return [];
  }
  if (
    !Array.isArray(allowed) ||
    allowed.length === 0 ||
    allowed.some(
      (entry) =>
        !entry ||
        typeof entry.name !== "string" ||
        typeof entry.email !== "string" ||
        !isAllowedEmail(entry.email),
    )
  ) {
    addFinding(
      "privacy/allowed-authors.json",
      "allowed-author policy is empty or malformed",
    );
    return [];
  }
  return allowed;
}

function inspectGitIdentity(locator, identityLine, allowed) {
  const match = /^(.*) <([^>]+)> \d+ [+-]\d{4}$/u.exec(identityLine);
  if (!match) {
    addFinding(locator, "malformed Git identity");
    return;
  }
  const [, name, email] = match;
  const accepted = allowed.some(
    (entry) => entry.name === name && entry.email === email,
  );
  if (!accepted)
    addFinding(
      locator,
      "Git object uses a non-approved identity",
      hashHint(identityLine),
    );
}

function inspectCommit(oid, denyTerms, allowed) {
  const object = git(["cat-file", "commit", oid]);
  if (object.status !== 0) {
    addFinding(".git", "unable to inspect a reachable commit object");
    return;
  }
  const separator = object.stdout.indexOf("\n\n");
  const headers =
    separator < 0 ? object.stdout : object.stdout.slice(0, separator);
  const message = separator < 0 ? "" : object.stdout.slice(separator + 2);
  for (const line of headers.split("\n")) {
    if (line.startsWith("author ")) {
      inspectGitIdentity(
        `.git/commit:${oid.slice(0, 12)}`,
        line.slice(7),
        allowed,
      );
    } else if (line.startsWith("committer ")) {
      inspectGitIdentity(
        `.git/commit:${oid.slice(0, 12)}`,
        line.slice(10),
        allowed,
      );
    }
  }
  inspectText(`.git/commit-header:${oid.slice(0, 12)}`, headers, denyTerms);
  inspectText(`.git/commit-message:${oid.slice(0, 12)}`, message, denyTerms);
}

function inspectTag(oid, denyTerms, allowed) {
  const object = git(["cat-file", "tag", oid]);
  if (object.status !== 0) {
    addFinding(".git", "unable to inspect a reachable tag object");
    return undefined;
  }
  const separator = object.stdout.indexOf("\n\n");
  const headers =
    separator < 0 ? object.stdout : object.stdout.slice(0, separator);
  const message = separator < 0 ? "" : object.stdout.slice(separator + 2);
  for (const line of headers.split("\n")) {
    if (line.startsWith("tagger ")) {
      inspectGitIdentity(
        `.git/tag:${oid.slice(0, 12)}`,
        line.slice(7),
        allowed,
      );
    }
  }
  inspectText(`.git/tag-header:${oid.slice(0, 12)}`, headers, denyTerms);
  inspectText(`.git/tag-message:${oid.slice(0, 12)}`, message, denyTerms);
  const target = /^object ([a-f0-9]{40,64})$/mu.exec(headers)?.[1];
  const targetType = /^type (\S+)$/mu.exec(headers)?.[1];
  if (targetType && !["commit", "tag"].includes(targetType)) {
    addFinding(
      `.git/tag:${oid.slice(0, 12)}`,
      "release tags may point only to commits or annotated tags",
    );
  }
  return target && targetType ? { oid: target, type: targetType } : undefined;
}

function inspectReachableTrees(commitIds, denyTerms) {
  const inspectedLocations = new Set();
  const blobCache = new Map();
  let reachablePaths = 0;

  for (const commit of commitIds) {
    const tree = git(["ls-tree", "-rlz", "--full-tree", commit], {
      encoding: null,
    });
    if (tree.status !== 0) {
      addFinding(".git", "unable to inspect a reachable Git tree");
      continue;
    }
    for (const record of tree.stdout
      .toString("utf8")
      .split("\0")
      .filter(Boolean)) {
      const tab = record.indexOf("\t");
      if (tab < 0) {
        addFinding(".git", "malformed reachable Git tree entry");
        continue;
      }
      const metadata = record.slice(0, tab).trim().split(/\s+/u);
      const repositoryPath = record.slice(tab + 1);
      const [mode, type, oid] = metadata;
      const locator = `git-history/${repositoryPath}`;
      reachablePaths += 1;
      inspectFilename(repositoryPath, locator);
      inspectText(locator, repositoryPath, denyTerms);

      if (mode === "120000")
        addFinding(locator, "symbolic links are not allowed in Git history");
      if (mode === "160000" || type === "commit") {
        addFinding(
          locator,
          "Git submodules are not allowed in release history",
        );
      }
      if (type !== "blob" || !oid) continue;

      const locationKey = `${oid}\0${repositoryPath}`;
      if (inspectedLocations.has(locationKey)) continue;
      inspectedLocations.add(locationKey);

      let buffer = blobCache.get(oid);
      if (!buffer) {
        const blob = git(["cat-file", "blob", oid], { encoding: null });
        if (blob.status !== 0) {
          addFinding(locator, "unable to inspect a reachable Git blob");
          continue;
        }
        buffer = blob.stdout;
        blobCache.set(oid, buffer);
      }
      inspectBuffer(locator, buffer, denyTerms, repositoryPath);
    }
  }
  return { blobs: blobCache.size, paths: reachablePaths };
}

async function inspectHistory(denyTerms) {
  const repository = git(["rev-parse", "--is-inside-work-tree"]);
  if (repository.status !== 0 || repository.stdout.trim() !== "true") {
    if (options.release && !options.treeOnly) {
      addFinding(".git", "release history scan requires a Git repository");
    }
    return { blobs: 0, commits: 0, paths: 0, refs: 0, tags: 0 };
  }

  const allowed = await loadAllowedAuthors();
  const shallow = git(["rev-parse", "--is-shallow-repository"]);
  if (shallow.status !== 0 || shallow.stdout.trim() === "true") {
    addFinding(
      ".git",
      "release history scan requires a complete non-shallow repository",
    );
  }
  const refs = git([
    "for-each-ref",
    "--format=%(refname)%09%(objectname)%09%(objecttype)",
  ]);
  if (refs.status !== 0) {
    addFinding(".git", "unable to enumerate Git refs");
    return { blobs: 0, commits: 0, paths: 0, refs: 0, tags: 0 };
  }

  const tagObjects = new Set();
  let refCount = 0;
  for (const line of refs.stdout.split(/\r?\n/u).filter(Boolean)) {
    const [name = "", oid = "", type = ""] = line.split("\t");
    refCount += 1;
    inspectText(".git/ref-name", name, denyTerms);
    if (name.startsWith("refs/replace/")) {
      addFinding(
        ".git/ref-name",
        "Git replacement refs are forbidden in release history",
      );
    }
    if (type && !["commit", "tag"].includes(type)) {
      addFinding(
        ".git/ref-name",
        "release refs may point only to commits or annotated tags",
      );
    }
    if (type === "tag" && oid) tagObjects.add(oid);
  }
  const inspectedTags = new Set();
  const queuedTags = [...tagObjects];
  while (queuedTags.length > 0) {
    const oid = queuedTags.pop();
    if (!oid || inspectedTags.has(oid)) continue;
    inspectedTags.add(oid);
    const target = inspectTag(oid, denyTerms, allowed);
    if (target?.type === "tag") queuedTags.push(target.oid);
  }

  const commits = git(["rev-list", "--all"]);
  if (commits.status !== 0) {
    addFinding(".git", "unable to enumerate reachable Git commits");
    return {
      blobs: 0,
      commits: 0,
      paths: 0,
      refs: refCount,
      tags: inspectedTags.size,
    };
  }
  const commitIds = [
    ...new Set(commits.stdout.split(/\r?\n/u).filter(Boolean)),
  ];
  if (options.release && commitIds.length === 0) {
    addFinding(
      ".git",
      "release history requires at least one committed revision",
    );
  }
  for (const oid of commitIds) inspectCommit(oid, denyTerms, allowed);
  const treeCounts = inspectReachableTrees(commitIds, denyTerms);
  return {
    ...treeCounts,
    commits: commitIds.length,
    refs: refCount,
    tags: inspectedTags.size,
  };
}

function locatorIsSensitive(locator, denyTerms) {
  const normalized = locator.normalize("NFKC").toLocaleLowerCase("en-US");
  if (
    denyTerms.some((term) =>
      normalized.includes(term.toLocaleLowerCase("en-US")),
    )
  )
    return true;
  EMAIL_PATTERN.lastIndex = 0;
  const email = EMAIL_PATTERN.exec(locator)?.[0];
  if (email && !isAllowedEmail(email)) return true;
  for (const pattern of [
    ...ABSOLUTE_PATH_PATTERNS,
    ...SECRET_PATTERNS.map(({ pattern }) => pattern),
  ]) {
    pattern.lastIndex = 0;
    if (pattern.test(locator)) return true;
  }
  return false;
}

function printableLocator(locator, denyTerms) {
  return locatorIsSensitive(locator, denyTerms)
    ? `[redacted-location:${createHash("sha256").update(locator).digest("hex").slice(0, 12)}]`
    : locator;
}

async function main() {
  const denyTerms = await loadDenyTerms();
  const files = await collectFiles(ROOT);
  for (const file of files) await inspectFile(file, denyTerms);
  const history = options.treeOnly
    ? { blobs: 0, commits: 0, paths: 0, refs: 0, tags: 0 }
    : await inspectHistory(denyTerms);

  findings.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.reason.localeCompare(right.reason),
  );
  if (findings.length > 0) {
    console.error(`Privacy check failed with ${findings.length} finding(s):`);
    for (const finding of findings) {
      const locator = printableLocator(finding.path, denyTerms);
      console.error(
        `- ${locator}: ${finding.reason}${finding.detail ? ` (${finding.detail})` : ""}`,
      );
    }
    process.exitCode = 1;
    return;
  }

  const historySummary = options.treeOnly
    ? "tree-only archive mode"
    : `${history.refs} refs, ${history.commits} commits, ${history.tags} annotated tags, ${history.blobs} blobs`;
  console.log(
    `Privacy check passed: ${files.length} files; ${historySummary}${denyTerms.length ? `; ${denyTerms.length} private terms` : ""}.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
