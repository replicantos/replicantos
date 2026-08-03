export const permissions = [
  "workspace:read",
  "workspace:manage",
  "workspace:transfer",
  "user:read",
  "user:manage",
  "access:manage",
  "channel:create",
  "channel:read",
  "channel:write",
  "channel:manage",
  "message:read",
  "message:write",
  "message:moderate",
  "replicant:create",
  "replicant:read",
  "replicant:interact",
  "replicant:manage",
  "task:create",
  "task:read",
  "task:write",
  "task:manage",
  "schedule:create",
  "schedule:read",
  "schedule:run",
  "schedule:manage",
  "run:create",
  "run:read",
  "run:cancel",
  "run:retry",
  "approval:read",
  "approval:decide",
  "approval:manage",
  "notification:read",
  "notification:manage",
  "artifact:create",
  "artifact:read",
  "artifact:write",
  "artifact:delete",
  "database:inspect",
  "file:read",
  "file:write",
  "terminal:execute",
  "credential:manage",
  "backup:create",
  "backup:restore",
  "audit:read",
] as const;

export type Permission = (typeof permissions)[number];
export type ResourceKind = Permission extends `${infer Kind}:${string}`
  ? Kind
  : never;

export function isPermission(value: unknown): value is Permission {
  return (
    typeof value === "string" &&
    (permissions as readonly string[]).includes(value)
  );
}
