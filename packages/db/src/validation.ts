import { isAbsolute, posix, win32 } from "node:path";

import type { JsonValue } from "@replicantos/core";

export function requiredText(
  value: string,
  field: string,
  maximum = 10_000,
): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new TypeError(
      `${field} must contain between 1 and ${maximum} characters`,
    );
  }
  return normalized;
}

export function optionalText(
  value: string | null,
  field: string,
  maximum = 10_000,
): string | null {
  return value === null ? null : requiredText(value, field, maximum);
}

export function safeRelativePath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.includes("\\") ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    value !== value.normalize("NFC")
  ) {
    throw new TypeError(
      "Artifact and workspace paths must be relative POSIX paths",
    );
  }

  const normalized = posix.normalize(value);
  const segments = value.split("/");
  if (
    normalized !== value ||
    normalized === "." ||
    normalized.startsWith("../") ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        Buffer.byteLength(segment, "utf8") > 255,
    )
  ) {
    throw new TypeError("Relative path traversal is not allowed");
  }
  return value;
}

/**
 * Validates two repository-relative POSIX paths and requires `descendant` to
 * live strictly below `parent`. This keeps durable Replicant state inside the
 * workspace directory made available to a sandboxed harness.
 */
export function safeDescendantPath(parent: string, descendant: string): string {
  const safeParent = safeRelativePath(parent);
  const safeDescendant = safeRelativePath(descendant);
  const relationship = posix.relative(safeParent, safeDescendant);
  if (
    relationship.length === 0 ||
    relationship === ".." ||
    relationship.startsWith("../") ||
    posix.isAbsolute(relationship)
  ) {
    throw new TypeError(
      "Replicant memory path must be a strict descendant of its workspace path",
    );
  }
  return safeDescendant;
}

export function jsonText(value: JsonValue): string {
  const result = JSON.stringify(value);
  if (result === undefined)
    throw new TypeError("Value is not JSON serializable");
  return result;
}

export function parseJson(value: string): JsonValue {
  return JSON.parse(value) as JsonValue;
}

export function cappedLimit(
  value: number | undefined,
  fallback = 50,
  maximum = 200,
): number {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new RangeError(`limit must be an integer between 1 and ${maximum}`);
  }
  return limit;
}

export function lowercaseHex(value: string, field: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(
      `${field} must be a 64-character lowercase hexadecimal digest`,
    );
  }
  return value;
}
