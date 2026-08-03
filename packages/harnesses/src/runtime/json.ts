import type { JsonObject, JsonValue } from "@replicantos/protocol";

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asJsonObject(value: unknown): JsonObject | undefined {
  const object = record(value);
  if (!object) return undefined;
  try {
    return JSON.parse(JSON.stringify(object)) as JsonObject;
  } catch {
    return undefined;
  }
}

export function compactPublicText(
  value: unknown,
  fallback: string,
  max = 300,
): string {
  const text = string(value)?.replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, max);
}

export function jsonObject(entries: Record<string, JsonValue>): JsonObject {
  return entries;
}
