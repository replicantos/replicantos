export type JsonPrimitive = boolean | null | number | string;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export class ProtocolValidationError extends Error {
  readonly issues: readonly string[];

  constructor(...issues: string[]) {
    super(`Protocol validation failed: ${issues.join("; ")}`);
    this.name = "ProtocolValidationError";
    this.issues = issues;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireRecord(
  value: unknown,
  path = "value",
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ProtocolValidationError(`${path} must be an object`);
  }
  return value;
}

export function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProtocolValidationError(`${path} must be a non-empty string`);
  }
  return value;
}

export function optionalString(
  value: unknown,
  path: string,
): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, path);
}

export function requireInteger(
  value: unknown,
  path: string,
  minimum = 0,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new ProtocolValidationError(
      `${path} must be an integer >= ${minimum}`,
    );
  }
  return value as number;
}

export function requireIsoTimestamp(value: unknown, path: string): string {
  const timestamp = requireString(value, path);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new ProtocolValidationError(`${path} must be an ISO-8601 timestamp`);
  }
  return timestamp;
}

export function isJsonValue(
  value: unknown,
  seen = new Set<object>(),
): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, seen));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((entry) => isJsonValue(entry, seen));
}

export function requireJsonValue(value: unknown, path: string): JsonValue {
  if (!isJsonValue(value)) {
    throw new ProtocolValidationError(`${path} must be JSON-safe`);
  }
  return value;
}

export function requireJsonObject(value: unknown, path: string): JsonObject {
  const object = requireRecord(value, path);
  if (!isJsonValue(object)) {
    throw new ProtocolValidationError(`${path} must be a JSON-safe object`);
  }
  return object as JsonObject;
}
