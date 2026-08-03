import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fileConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  type Stats,
  unlinkSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";

import { HttpError } from "./errors.js";

export type ApprovedRoot = "library" | "workspace";

export interface ApprovedFileRoots {
  library: string;
  workspace: string;
}

export interface SafeFileEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  byteSize: number | null;
  modifiedAt: string;
}

export interface SafeTextFile {
  path: string;
  content: string;
  byteSize: number;
  modifiedAt: string;
}

export interface SafeWriteResult {
  path: string;
  byteSize: number;
  modifiedAt: string;
}

export const MAX_TEXT_FILE_BYTES = 1_048_576;
const MAX_FILE_RESOURCE_ID_LENGTH = 120;
const MAX_DIRECTORY_ENTRIES = 200;
const MAX_DIRECTORY_SCAN = 1_000;

const deniedSegments = new Set([
  "auth",
  "authentication",
  "backups",
  "browser-profiles",
  "credentials",
  "logs",
  "node_modules",
  "runtime",
  "secrets",
  "sessions",
]);

interface FileIdentityPolicy {
  caseInsensitive: boolean;
  normalizationInsensitive: boolean;
}

function rejectPath(): never {
  throw new HttpError(400, "invalid_request", "The requested path is invalid.");
}

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

function ensureContained(root: string, candidate: string): void {
  if (!isContained(root, candidate)) rejectPath();
}

function allowedSegment(segment: string): boolean {
  return (
    segment !== "" &&
    segment !== "." &&
    segment !== ".." &&
    !segment.startsWith(".") &&
    !deniedSegments.has(segment.toLowerCase())
  );
}

function pathSegments(value: string, allowRoot: boolean): string[] {
  if (value === "" && allowRoot) return [];
  if (
    value === "" ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value) ||
    win32.isAbsolute(value)
  ) {
    rejectPath();
  }
  const segments = value.split("/");
  if (
    !segments.every(
      (segment) =>
        allowedSegment(segment) &&
        segment === segment.normalize("NFC") &&
        Buffer.byteLength(segment, "utf8") <= 255,
    )
  ) {
    rejectPath();
  }
  return segments;
}

function publicPath(segments: readonly string[]): string {
  return segments.join("/");
}

function canonicalFileResourceId(
  root: ApprovedRoot,
  relativePath: string,
  policy: FileIdentityPolicy,
): string {
  const segments = pathSegments(relativePath, relativePath === "");
  const canonicalPath = segments
    .map((segment) =>
      policy.caseInsensitive ? segment.toLowerCase().normalize("NFC") : segment,
    )
    .join("/");
  const resourceId = `${root}:${canonicalPath === "" ? "/" : canonicalPath}`;
  if (resourceId.length > MAX_FILE_RESOURCE_ID_LENGTH) rejectPath();
  return resourceId;
}

function canonicalFileGrantResourceId(
  resourceId: string,
  policies: Readonly<Record<ApprovedRoot, FileIdentityPolicy>>,
): string {
  const separator = resourceId.indexOf(":");
  const root = resourceId.slice(0, separator);
  const path = resourceId.slice(separator + 1);
  if (
    (root !== "library" && root !== "workspace") ||
    separator < 0 ||
    path === ""
  ) {
    rejectPath();
  }
  return canonicalFileResourceId(
    root,
    path === "/" ? "" : path,
    policies[root],
  );
}

function aliasesExistingPath(
  root: string,
  primaryName: string,
  alternateName: string,
): boolean {
  const primary = join(root, primaryName);
  const alternate = join(root, alternateName);
  const descriptor = openSync(
    primary,
    fileConstants.O_CREAT | fileConstants.O_EXCL | fileConstants.O_WRONLY,
    0o600,
  );
  closeSync(descriptor);
  try {
    return existsSync(alternate);
  } finally {
    unlinkSync(primary);
  }
}

function detectIdentityPolicy(root: string): FileIdentityPolicy {
  const token = randomUUID().replaceAll("-", "");
  return Object.freeze({
    caseInsensitive: aliasesExistingPath(
      root,
      `.replicantos-case-${token}-a`,
      `.REPLICANTOS-CASE-${token}-A`,
    ),
    normalizationInsensitive: aliasesExistingPath(
      root,
      `.replicantos-unicode-${token}-é`,
      `.replicantos-unicode-${token}-e\u0301`,
    ),
  });
}

async function verifiedExistingPath(
  root: string,
  segments: readonly string[],
): Promise<{ absolute: string; stats: Stats }> {
  let candidate = root;
  let stats = await lstat(root);
  for (const segment of segments) {
    candidate = join(candidate, segment);
    stats = await lstat(candidate).catch(() => {
      throw new HttpError(
        404,
        "not_found",
        "The requested file does not exist.",
      );
    });
    if (stats.isSymbolicLink()) rejectPath();
  }
  const resolved = await realpath(candidate);
  ensureContained(root, resolved);
  if (stats.isSymbolicLink()) rejectPath();
  return { absolute: resolved, stats };
}

function createApprovedRoots(input: ApprovedFileRoots): ApprovedFileRoots {
  const roots = {
    workspace: resolve(input.workspace),
    library: resolve(input.library),
  };
  mkdirSync(roots.workspace, { recursive: true, mode: 0o700 });
  mkdirSync(roots.library, { recursive: true, mode: 0o700 });
  if (
    lstatSync(roots.workspace).isSymbolicLink() ||
    lstatSync(roots.library).isSymbolicLink()
  ) {
    throw new TypeError("Approved roots must not be symbolic links");
  }
  const resolved = {
    workspace: realpathSync(roots.workspace),
    library: realpathSync(roots.library),
  };
  if (
    physicallyContains(resolved.workspace, resolved.library) ||
    physicallyContains(resolved.library, resolved.workspace)
  ) {
    throw new TypeError(
      "Approved workspace and library roots must not overlap",
    );
  }
  return resolved;
}

function physicallyContains(ancestor: string, candidate: string): boolean {
  const ancestorStats = statSync(ancestor);
  let current = candidate;
  for (;;) {
    const currentStats = statSync(current);
    if (
      currentStats.dev === ancestorStats.dev &&
      currentStats.ino === ancestorStats.ino
    ) {
      return true;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export class SafeFileService {
  readonly roots: Readonly<ApprovedFileRoots>;
  readonly identityPolicies: Readonly<Record<ApprovedRoot, FileIdentityPolicy>>;

  constructor(roots: ApprovedFileRoots) {
    this.roots = Object.freeze(createApprovedRoots(roots));
    this.identityPolicies = Object.freeze({
      library: detectIdentityPolicy(this.roots.library),
      workspace: detectIdentityPolicy(this.roots.workspace),
    });
  }

  #root(root: ApprovedRoot): string {
    return this.roots[root];
  }

  resourceId(root: ApprovedRoot, relativePath: string): string {
    return canonicalFileResourceId(
      root,
      relativePath,
      this.identityPolicies[root],
    );
  }

  grantResourceId(resourceId: string): string {
    return canonicalFileGrantResourceId(resourceId, this.identityPolicies);
  }

  async ensureDirectory(
    rootName: ApprovedRoot,
    relativePath: string,
  ): Promise<void> {
    const segments = pathSegments(relativePath, false);
    const root = this.#root(rootName);
    for (let index = 0; index < segments.length; index += 1) {
      const prefix = segments.slice(0, index + 1);
      const parent = await verifiedExistingPath(root, prefix.slice(0, -1));
      if (!parent.stats.isDirectory()) rejectPath();
      const segment = prefix.at(-1);
      if (segment === undefined) rejectPath();
      const candidate = join(parent.absolute, segment);
      ensureContained(root, candidate);
      await mkdir(candidate, { mode: 0o700 }).catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EEXIST"
        ) {
          return;
        }
        throw error;
      });
      const created = await verifiedExistingPath(root, prefix);
      if (!created.stats.isDirectory()) rejectPath();
    }
  }

  async resolveDirectory(
    rootName: ApprovedRoot,
    relativePath: string,
  ): Promise<string> {
    const segments = pathSegments(relativePath, false);
    const directory = await verifiedExistingPath(
      this.#root(rootName),
      segments,
    );
    if (!directory.stats.isDirectory()) rejectPath();
    return directory.absolute;
  }

  async list(
    rootName: ApprovedRoot,
    relativePath: string,
  ): Promise<SafeFileEntry[]> {
    const segments = pathSegments(relativePath, true);
    const root = this.#root(rootName);
    const target = await verifiedExistingPath(root, segments);
    if (!target.stats.isDirectory()) {
      throw new HttpError(
        400,
        "invalid_request",
        "The requested path is not a directory.",
      );
    }

    const entries: SafeFileEntry[] = [];
    let scanned = 0;
    const directory = await opendir(target.absolute);
    for await (const entry of directory) {
      scanned += 1;
      if (scanned > MAX_DIRECTORY_SCAN) {
        throw new HttpError(
          413,
          "invalid_request",
          "The directory is too large to list.",
        );
      }
      if (!allowedSegment(entry.name) || entry.isSymbolicLink()) continue;
      const entrySegments = [...segments, entry.name];
      const child = await verifiedExistingPath(root, entrySegments);
      if (!child.stats.isDirectory() && !child.stats.isFile()) continue;
      if (child.stats.isFile() && child.stats.nlink !== 1) continue;
      const normalizedName = entry.name.normalize("NFC");
      if (
        normalizedName !== entry.name &&
        !this.identityPolicies[rootName].normalizationInsensitive
      ) {
        continue;
      }
      const publicEntrySegments = [...segments, normalizedName];
      entries.push({
        name: normalizedName,
        path: publicPath(publicEntrySegments),
        kind: child.stats.isDirectory() ? "directory" : "file",
        byteSize: child.stats.isFile() ? child.stats.size : null,
        modifiedAt: child.stats.mtime.toISOString(),
      });
      if (entries.length > MAX_DIRECTORY_ENTRIES) {
        throw new HttpError(
          413,
          "invalid_request",
          "The directory is too large to list.",
        );
      }
    }
    return entries.sort((left, right) => left.name.localeCompare(right.name));
  }

  async readText(
    rootName: ApprovedRoot,
    relativePath: string,
  ): Promise<SafeTextFile> {
    const segments = pathSegments(relativePath, false);
    const root = this.#root(rootName);
    const before = await verifiedExistingPath(root, segments);
    if (!before.stats.isFile()) {
      throw new HttpError(
        400,
        "invalid_request",
        "The requested path is not a file.",
      );
    }
    const handle = await open(
      before.absolute,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
    ).catch(() => rejectPath());
    try {
      const after = await handle.stat();
      if (
        !after.isFile() ||
        after.nlink !== 1 ||
        after.dev !== before.stats.dev ||
        after.ino !== before.stats.ino
      ) {
        rejectPath();
      }
      const resolvedAfterOpen = await realpath(before.absolute);
      ensureContained(root, resolvedAfterOpen);
      const buffer = Buffer.alloc(MAX_TEXT_FILE_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_TEXT_FILE_BYTES) {
        throw new HttpError(
          413,
          "invalid_request",
          "The file is too large to read.",
        );
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, bytesRead),
        );
      } catch {
        throw new HttpError(
          415,
          "invalid_request",
          "Only UTF-8 text files are supported.",
        );
      }
      if (content.includes("\0")) {
        throw new HttpError(
          415,
          "invalid_request",
          "Only UTF-8 text files are supported.",
        );
      }
      return {
        path: publicPath(segments),
        content,
        byteSize: bytesRead,
        modifiedAt: after.mtime.toISOString(),
      };
    } finally {
      await handle.close();
    }
  }

  async writeText(
    rootName: ApprovedRoot,
    relativePath: string,
    content: string,
  ): Promise<SafeWriteResult> {
    const segments = pathSegments(relativePath, false);
    const bytes = Buffer.from(content, "utf8");
    if (bytes.byteLength > MAX_TEXT_FILE_BYTES || content.includes("\0")) {
      throw new HttpError(
        413,
        "invalid_request",
        "The file is too large to write.",
      );
    }
    const root = this.#root(rootName);
    const parentSegments = segments.slice(0, -1);
    const parent = await verifiedExistingPath(root, parentSegments);
    if (!parent.stats.isDirectory()) rejectPath();
    const lastSegment = segments.at(-1);
    if (lastSegment === undefined) rejectPath();
    const name = basename(lastSegment);
    if (!allowedSegment(name)) rejectPath();
    const destination = join(parent.absolute, name);
    ensureContained(root, destination);
    const existing = await lstat(destination).catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    });
    if (
      existing?.isSymbolicLink() === true ||
      (existing !== null && (!existing.isFile() || existing.nlink !== 1))
    ) {
      rejectPath();
    }

    const temporary = join(
      parent.absolute,
      `.replicantos-write-${randomUUID()}.tmp`,
    );
    let temporaryExists = false;
    let temporaryIdentity: Pick<Stats, "dev" | "ino" | "size"> | null = null;
    try {
      const handle = await open(
        temporary,
        fileConstants.O_CREAT |
          fileConstants.O_EXCL |
          fileConstants.O_WRONLY |
          fileConstants.O_NOFOLLOW,
        0o600,
      );
      temporaryExists = true;
      try {
        const temporaryStats = await handle.stat();
        const temporaryPath = await realpath(temporary);
        ensureContained(root, temporaryPath);
        if (!temporaryStats.isFile()) rejectPath();

        const parentAfterOpen = await verifiedExistingPath(
          root,
          parentSegments,
        );
        if (
          parentAfterOpen.absolute !== parent.absolute ||
          parentAfterOpen.stats.dev !== parent.stats.dev ||
          parentAfterOpen.stats.ino !== parent.stats.ino
        ) {
          rejectPath();
        }
        await handle.writeFile(bytes);
        await handle.sync();
        const afterWrite = await handle.stat();
        temporaryIdentity = {
          dev: afterWrite.dev,
          ino: afterWrite.ino,
          size: afterWrite.size,
        };
      } finally {
        await handle.close();
      }

      const parentBeforeRename = await verifiedExistingPath(
        root,
        parentSegments,
      );
      if (
        parentBeforeRename.absolute !== parent.absolute ||
        parentBeforeRename.stats.dev !== parent.stats.dev ||
        parentBeforeRename.stats.ino !== parent.stats.ino
      ) {
        rejectPath();
      }
      await rename(temporary, destination);
      temporaryExists = false;
      const written = await verifiedExistingPath(root, segments);
      if (
        temporaryIdentity === null ||
        !written.stats.isFile() ||
        written.stats.nlink !== 1 ||
        written.stats.dev !== temporaryIdentity.dev ||
        written.stats.ino !== temporaryIdentity.ino ||
        written.stats.size !== temporaryIdentity.size
      ) {
        rejectPath();
      }
      return {
        path: publicPath(segments),
        byteSize: written.stats.size,
        modifiedAt: written.stats.mtime.toISOString(),
      };
    } finally {
      if (temporaryExists) await unlink(temporary).catch(() => undefined);
    }
  }
}
