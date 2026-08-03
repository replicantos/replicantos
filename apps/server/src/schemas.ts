import { permissions } from "@replicantos/core";
import { z } from "zod";

import { MAX_TEXT_FILE_BYTES } from "./file-service.js";

const id = z.string().min(8).max(80);
const nullableId = id.nullable().optional().default(null);
const optionalNullableText = (maximum: number) =>
  z.string().trim().min(1).max(maximum).nullable().optional().default(null);

export const bootstrapBody = z
  .object({
    workspaceName: z.string().trim().min(1).max(120).default("ReplicantOS"),
    handle: z
      .string()
      .trim()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]*$/u),
    displayName: z.string().trim().min(1).max(120),
    password: z.string().min(12).max(256),
  })
  .strict();

export const loginBody = z
  .object({
    handle: z.string().trim().min(1).max(64),
    password: z.string().min(1).max(256),
  })
  .strict();

export const listQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export const resourceParams = z.object({ id }).strict();

export const emptyBody = z.object({}).strict().optional().default({});

export const createChannelBody = z
  .object({
    categoryId: nullableId,
    kind: z.enum(["standard", "direct", "system"]).default("standard"),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/u),
    name: z.string().trim().min(1).max(120),
    description: optionalNullableText(2_000),
  })
  .strict();

export const createMessageBody = z
  .object({
    replyToId: nullableId,
    content: z.string().trim().min(1).max(100_000),
  })
  .strict();

export const messageQuery = z
  .object({
    before: z.iso.datetime({ offset: false }).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export const createReplicantBody = z
  .object({
    slug: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/u),
    name: z.string().trim().min(1).max(120),
    description: optionalNullableText(2_000),
    persona: z.string().trim().min(1).max(50_000),
    defaultHarness: z.enum(["codex", "claude", "opencode", "grok"]),
    defaultModel: optionalNullableText(200),
  })
  .strict();

export const createBindingBody = z
  .object({
    channelId: id,
    behavior: z.enum(["automatic", "mention-only", "listen-only", "disabled"]),
  })
  .strict();

export const createTaskBody = z
  .object({
    projectId: nullableId,
    title: z.string().trim().min(1).max(500),
    notes: optionalNullableText(50_000),
    status: z
      .enum(["backlog", "ready", "active", "blocked", "done", "canceled"])
      .default("backlog"),
    priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
    dueAt: z.iso
      .datetime({ offset: false })
      .nullable()
      .optional()
      .default(null),
    assigneeUserId: nullableId,
    assigneeReplicantId: nullableId,
  })
  .strict()
  .refine(
    (value) =>
      value.assigneeUserId === null || value.assigneeReplicantId === null,
  );

export const taskQuery = z
  .object({
    status: z
      .enum(["backlog", "ready", "active", "blocked", "done", "canceled"])
      .optional(),
    projectId: id.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export const updateTaskStatusBody = z
  .object({
    status: z.enum([
      "backlog",
      "ready",
      "active",
      "blocked",
      "done",
      "canceled",
    ]),
  })
  .strict();

export const createScheduleBody = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: optionalNullableText(2_000),
    cronExpression: z
      .string()
      .trim()
      .min(5)
      .max(200)
      .refine(
        (value) =>
          value.split(/\s+/u).length === 5 &&
          /^[0-9*/?,\-\sA-Z]+$/iu.test(value),
      ),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value }).format();
          return true;
        } catch {
          return false;
        }
      }),
    status: z.enum(["enabled", "paused"]).default("enabled"),
    replicantId: id,
    channelId: nullableId,
    taskId: nullableId,
    harnessOverride: z
      .enum(["codex", "claude", "opencode", "grok"])
      .nullable()
      .optional()
      .default(null),
    modelOverride: optionalNullableText(200),
    effortOverride: optionalNullableText(80),
    prompt: z.string().trim().min(1).max(100_000),
    retryPolicy: z.json().default({ maxAttempts: 1 }),
    outcomeAssertions: z.json().default({}),
  })
  .strict();

export const scheduleQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const humanUserBody = z
  .object({
    kind: z.literal("human"),
    handle: z
      .string()
      .trim()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]*$/u),
    displayName: z.string().trim().min(1).max(120),
    role: z.enum(["admin", "member"]),
    password: z.string().min(12).max(256),
  })
  .strict();

const serviceUserBody = z
  .object({
    kind: z.literal("service"),
    handle: z
      .string()
      .trim()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]*$/u),
    displayName: z.string().trim().min(1).max(120),
    role: z.literal("service"),
  })
  .strict();

export const createUserBody = z.discriminatedUnion("kind", [
  humanUserBody,
  serviceUserBody,
]);

export const updateUserStatusBody = z
  .object({
    status: z.enum(["active", "suspended", "disabled"]),
  })
  .strict();

export const createGrantBody = z
  .object({
    subjectType: z.enum(["user", "role"]),
    subjectUserId: id.nullable().optional().default(null),
    subjectRole: z
      .enum(["owner", "admin", "member", "service"])
      .nullable()
      .optional()
      .default(null),
    permission: z.enum(permissions),
    resourceId: z.string().min(1).max(120).nullable().optional().default(null),
    effect: z.enum(["allow", "deny"]).default("allow"),
    reason: optionalNullableText(500),
    expiresAt: z.iso
      .datetime({ offset: false })
      .nullable()
      .optional()
      .default(null),
  })
  .strict()
  .refine(
    (value) =>
      (value.subjectType === "user" &&
        value.subjectUserId !== null &&
        value.subjectRole === null) ||
      (value.subjectType === "role" &&
        value.subjectUserId === null &&
        value.subjectRole !== null),
  );

export const approvalDecisionBody = z
  .object({ decision: z.enum(["approved", "denied"]) })
  .strict();

export const approvalParams = z
  .object({ id: z.string().min(1).max(1_000) })
  .strict();

export const auditQuery = z
  .object({
    resourceType: z.string().trim().min(1).max(120),
    resourceId: z.string().min(1).max(120).nullable().optional().default(null),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export const settingParams = z
  .object({
    key: z.enum([
      "ui.theme",
      "ui.timezone",
      "terminal.enabled",
      "telemetry.enabled",
    ]),
  })
  .strict();

export const settingBody = z.object({ value: z.json() }).strict();

const approvedFileRoot = z.enum(["workspace", "library"]);
// `workspace:` plus this path must fit the 120-character access-grant and
// audit-query resource identifier boundary.
const relativeFilePath = z.string().max(110);

export const fileListQuery = z
  .object({
    root: approvedFileRoot,
    path: relativeFilePath.optional().default(""),
  })
  .strict();

export const fileTextQuery = z
  .object({
    root: approvedFileRoot,
    path: relativeFilePath.min(1),
  })
  .strict();

export const fileWriteBody = z
  .object({
    root: approvedFileRoot,
    path: relativeFilePath.min(1),
    content: z.string().max(MAX_TEXT_FILE_BYTES),
  })
  .strict();

export const documentIndexBody = z
  .object({
    path: relativeFilePath.min(1),
    name: z.string().trim().min(1).max(500).optional(),
    mediaType: z.enum(["text/markdown", "text/plain"]).default("text/plain"),
  })
  .strict();

export const documentListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export const databaseTableParams = z
  .object({
    table: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/u),
  })
  .strict();

export const databaseRowsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();
