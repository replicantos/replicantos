import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  type AccessGrant,
  type ApprovalId,
  type Channel,
  type IsoTimestamp,
  type JsonValue,
  type Replicant,
  type ResourceKind,
  type Run,
  type RunEvent,
  type Schedule,
  type Task,
  type User,
  type Workspace,
} from "@replicantos/core";
import type { RuntimeRunProjectionRecord } from "@replicantos/db";
import {
  CronExpressionError,
  CronSearchExhaustedError,
  buildReplicantSystemPrompt,
  nextCronOccurrence,
  parseRetryPolicy,
} from "@replicantos/runtime";
import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  appendAudit,
  can,
  nextId,
  parseEntityId,
  requireAuthentication,
  requirePermission,
  requireServices,
  type AuthenticatedActor,
} from "./auth.js";
import type { ServerConfig } from "./config.js";
import {
  queueConversationRuns,
  type QueuedConversationRun,
} from "./conversation-runs.js";
import type { ServerDependencies } from "./dependencies.js";
import { HttpError, parseInput } from "./errors.js";
import {
  approvalDecisionBody,
  approvalParams,
  auditQuery,
  bootstrapBody,
  createBindingBody,
  createChannelBody,
  createGrantBody,
  createMessageBody,
  createReplicantBody,
  createScheduleBody,
  createTaskBody,
  createUserBody,
  emptyBody,
  listQuery,
  loginBody,
  messageQuery,
  resourceParams,
  scheduleQuery,
  settingBody,
  settingParams,
  taskQuery,
  updateTaskStatusBody,
  updateUserStatusBody,
} from "./schemas.js";
import {
  clearSessionCookie,
  createSessionToken,
  hashSessionToken,
  SESSION_LIFETIME_SECONDS,
  setSessionCookie,
} from "./security.js";
import { registerSecurityServiceRoutes } from "./security-service-routes.js";

function data<Value>(value: Value): { data: Value } {
  return { data: value };
}

function expiresAt(now: IsoTimestamp): IsoTimestamp {
  return new Date(
    Date.parse(now) + SESSION_LIFETIME_SECONDS * 1_000,
  ).toISOString() as IsoTimestamp;
}

function permissionResourceType(
  permission: AccessGrant["permission"],
): ResourceKind {
  return permission.slice(0, permission.indexOf(":")) as ResourceKind;
}

function normalizedGrantResourceId(
  permission: AccessGrant["permission"],
  resourceId: string | null,
  dependencies: ServerDependencies,
): string | null {
  if (
    resourceId === null ||
    (permission !== "file:read" && permission !== "file:write")
  ) {
    return resourceId;
  }
  if (dependencies.files === null) {
    throw new HttpError(
      503,
      "service_unavailable",
      "The file service is not configured.",
    );
  }
  return dependencies.files.grantResourceId(resourceId);
}

function assertWorkspace(actor: AuthenticatedActor, workspaceId: string): void {
  if (actor.workspaceId !== workspaceId) {
    throw new HttpError(
      404,
      "not_found",
      "The requested resource does not exist.",
    );
  }
}

function notFound(): never {
  throw new HttpError(
    404,
    "not_found",
    "The requested resource does not exist.",
  );
}

type PublicRun = Omit<Run, "harnessSessionKey">;
type PublicRunProjection = Omit<RuntimeRunProjectionRecord, "harnessSessionId">;

function publicRun(run: Run): PublicRun {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    replicantId: run.replicantId,
    channelId: run.channelId,
    taskId: run.taskId,
    scheduleId: run.scheduleId,
    parentRunId: run.parentRunId,
    trigger: run.trigger,
    status: run.status,
    harness: run.harness,
    model: run.model,
    effort: run.effort,
    requestedBy: run.requestedBy,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    costMicros: run.costMicros,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
  };
}

function publicRunProjection(
  projection: RuntimeRunProjectionRecord,
): PublicRunProjection {
  return {
    runId: projection.runId,
    status: projection.status,
    inputTokens: projection.inputTokens,
    outputTokens: projection.outputTokens,
    cachedInputTokens: projection.cachedInputTokens,
    costMicros: projection.costMicros,
    assistantText: projection.assistantText,
    cancellationRequestedAt: projection.cancellationRequestedAt,
  };
}

const protectedEventKeys = new Set([
  "cwd",
  "prompt",
  "sessionid",
  "systemprompt",
  "threadid",
  "workingdirectory",
]);

function publicEventPayload(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(publicEventPayload);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      protectedEventKeys.has(key.replaceAll(/[-_]/gu, "").toLowerCase())
        ? "[redacted]"
        : publicEventPayload(entry),
    ]),
  );
}

function publicRunEvent(event: RunEvent): RunEvent {
  return { ...event, payload: publicEventPayload(event.payload) };
}

function requireRuntime(
  dependencies: ServerDependencies,
): NonNullable<ServerDependencies["runtime"]> {
  if (dependencies.runtime === null) {
    throw new HttpError(
      503,
      "service_unavailable",
      "The local runtime is unavailable.",
    );
  }
  return dependencies.runtime;
}

function requireFiles(
  dependencies: ServerDependencies,
): NonNullable<ServerDependencies["files"]> {
  if (dependencies.files === null) {
    throw new HttpError(
      503,
      "service_unavailable",
      "The workspace file service is unavailable.",
    );
  }
  return dependencies.files;
}

async function provisionReplicantDirectories(
  dependencies: ServerDependencies,
  replicant: Pick<Replicant, "relativeMemoryPath" | "relativeWorkspacePath">,
): Promise<void> {
  const files = requireFiles(dependencies);
  try {
    await Promise.all([
      files.ensureDirectory("workspace", replicant.relativeWorkspacePath),
      files.ensureDirectory("workspace", replicant.relativeMemoryPath),
    ]);
  } catch {
    throw new HttpError(
      503,
      "service_unavailable",
      "The Replicant directories could not be provisioned.",
    );
  }
}

function resolvedWorkspaceCwd(
  dependencies: ServerDependencies,
  relativeWorkspacePath: string,
): string {
  const root = requireFiles(dependencies).roots.workspace;
  const candidate = resolve(root, ...relativeWorkspacePath.split("/"));
  const relationship = relative(root, candidate);
  if (
    relationship === ".." ||
    relationship.startsWith(`..${sep}`) ||
    isAbsolute(relationship)
  ) {
    throw new HttpError(
      503,
      "service_unavailable",
      "The Replicant workspace could not be resolved.",
    );
  }
  return candidate;
}

async function context(
  request: FastifyRequest,
  dependencies: ServerDependencies,
) {
  return requireAuthentication(request, dependencies);
}

export async function registerApiRoutes(
  app: FastifyInstance,
  config: ServerConfig,
  dependencies: ServerDependencies,
): Promise<void> {
  app.get("/api/v1/system/bootstrap-status", async () =>
    data({
      bootstrapped:
        dependencies.repositories !== null &&
        dependencies.repositories.workspaces.getOnly() !== null,
    }),
  );

  app.post(
    "/api/v1/system/bootstrap",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 hour" } },
    },
    async (request, reply) => {
      const body = parseInput(bootstrapBody, request.body);
      const { database, repositories, passwords } =
        requireServices(dependencies);
      if (repositories.workspaces.getOnly() !== null) {
        throw new HttpError(
          409,
          "conflict",
          "This installation is already configured.",
        );
      }
      const passwordHash = await passwords.hashPassword(body.password);
      const now = dependencies.now();
      const workspace: Workspace = {
        id: nextId("workspace"),
        slug: "workspace",
        displayName: body.workspaceName,
        createdAt: now,
        updatedAt: now,
      };
      const owner: User = {
        id: nextId("user"),
        workspaceId: workspace.id,
        kind: "human",
        handle: body.handle,
        displayName: body.displayName,
        role: "owner",
        status: "active",
        createdAt: now,
        updatedAt: now,
      };

      database.transaction(() => {
        if (repositories.workspaces.getOnly() !== null) {
          throw new HttpError(
            409,
            "conflict",
            "This installation is already configured.",
          );
        }
        repositories.workspaces.create(workspace);
        repositories.users.create({ user: owner, passwordHash });
        appendAudit(
          dependencies,
          request,
          owner,
          "installation.bootstrapped",
          "workspace",
          workspace.id,
          { ownerId: owner.id },
        );
      });

      await reply.code(201).send(data({ workspace, owner }));
    },
  );

  app.post(
    "/api/v1/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = parseInput(loginBody, request.body);
      const { database, repositories, passwords } =
        requireServices(dependencies);
      const workspace = repositories.workspaces.getOnly();
      const user =
        workspace === null
          ? null
          : repositories.users.getByHandle(workspace.id, body.handle);
      const passwordHash =
        user === null ? null : await dependencies.readPasswordHash(user.id);
      const valid = await passwords.verifyPassword(passwordHash, body.password);
      if (
        !valid ||
        user === null ||
        user.kind !== "human" ||
        user.status !== "active"
      ) {
        throw new HttpError(
          401,
          "invalid_credentials",
          "The credentials are invalid.",
        );
      }

      const now = dependencies.now();
      const token = createSessionToken();
      const session = {
        id: nextId("session"),
        userId: user.id,
        tokenHash: hashSessionToken(token),
        createdAt: now,
        expiresAt: expiresAt(now),
        lastSeenAt: now,
        revokedAt: null,
      };
      database.transaction(() => {
        repositories.sessions.create(session);
        appendAudit(
          dependencies,
          request,
          user,
          "session.created",
          "session",
          session.id,
        );
      });
      setSessionCookie(reply, token, config.secureCookies);
      await reply.send(data({ actor: user, expiresAt: session.expiresAt }));
    },
  );

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const authentication = await context(request, dependencies);
    const { database, repositories } = requireServices(dependencies);
    database.transaction(() => {
      repositories.sessions.revoke(
        authentication.session.id,
        dependencies.now(),
      );
      appendAudit(
        dependencies,
        request,
        authentication.actor,
        "session.revoked",
        "session",
        authentication.session.id,
      );
    });
    clearSessionCookie(reply, config.secureCookies);
    await reply.send(data({ loggedOut: true }));
  });

  const meHandler = async (request: FastifyRequest) => {
    const authentication = await context(request, dependencies);
    return data({
      actor: authentication.actor,
      expiresAt: authentication.session.expiresAt,
    });
  };
  app.get("/api/v1/auth/me", meHandler);
  app.get("/api/v1/session", meHandler);

  app.get("/api/v1/channels", async (request) => {
    const { actor } = await context(request, dependencies);
    const { repositories } = requireServices(dependencies);
    const items = repositories.channels
      .list(actor.workspaceId)
      .filter((channel) =>
        can(
          actor,
          {
            permission: "channel:read",
            resourceType: "channel",
            resourceId: channel.id,
          },
          dependencies,
        ),
      );
    return data({ items });
  });

  app.post("/api/v1/channels", async (request, reply) => {
    const { actor } = await context(request, dependencies);
    requirePermission(
      actor,
      { permission: "channel:create", resourceType: "channel" },
      dependencies,
    );
    const body = parseInput(createChannelBody, request.body);
    const { database, repositories } = requireServices(dependencies);
    const now = dependencies.now();
    const channel: Channel = {
      id: nextId("channel"),
      workspaceId: actor.workspaceId,
      categoryId:
        body.categoryId === null
          ? null
          : parseEntityId("category", body.categoryId),
      kind: body.kind,
      slug: body.slug,
      name: body.name,
      description: body.description,
      archivedAt: null,
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now,
    };
    database.transaction(() => {
      repositories.channels.create(channel);
      appendAudit(
        dependencies,
        request,
        actor,
        "channel.created",
        "channel",
        channel.id,
      );
    });
    await reply.code(201).send(data(channel));
  });

  app.get("/api/v1/channels/:id/messages", async (request) => {
    const { actor } = await context(request, dependencies);
    const params = parseInput(resourceParams, request.params);
    const query = parseInput(messageQuery, request.query);
    const channelId = parseEntityId("channel", params.id);
    const { repositories } = requireServices(dependencies);
    const channel = repositories.channels.get(channelId);
    if (channel === null) notFound();
    assertWorkspace(actor, channel.workspaceId);
    requirePermission(
      actor,
      {
        permission: "channel:read",
        resourceType: "channel",
        resourceId: channel.id,
      },
      dependencies,
    );
    return data({
      items: repositories.messages.list(channel.id, {
        ...(query.before === undefined
          ? {}
          : { before: query.before as IsoTimestamp }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      }),
    });
  });

  app.post("/api/v1/channels/:id/messages", async (request, reply) => {
    const { actor } = await context(request, dependencies);
    const params = parseInput(resourceParams, request.params);
    const body = parseInput(createMessageBody, request.body);
    const channelId = parseEntityId("channel", params.id);
    const { database, repositories } = requireServices(dependencies);
    const channel = repositories.channels.get(channelId);
    if (channel === null) notFound();
    assertWorkspace(actor, channel.workspaceId);
    requirePermission(
      actor,
      {
        permission: "channel:write",
        resourceType: "channel",
        resourceId: channel.id,
      },
      dependencies,
    );
    const replyToId =
      body.replyToId === null ? null : parseEntityId("message", body.replyToId);
    if (replyToId !== null) {
      const parent = repositories.messages.get(replyToId);
      if (parent === null || parent.channelId !== channel.id) {
        throw new HttpError(
          400,
          "invalid_request",
          "The reply target is invalid.",
        );
      }
    }
    const message = {
      id: nextId("message"),
      channelId: channel.id,
      replyToId,
      authorKind:
        actor.kind === "service" ? ("system" as const) : ("user" as const),
      authorUserId: actor.kind === "service" ? null : actor.id,
      authorReplicantId: null,
      content: body.content,
      editedAt: null,
      deletedAt: null,
      createdAt: dependencies.now(),
    };
    database.transaction(() => {
      repositories.messages.create(message);
      appendAudit(
        dependencies,
        request,
        actor,
        "message.created",
        "message",
        message.id,
        {
          channelId: channel.id,
        },
      );
    });

    let dispatchStatus: "failed" | "not-requested" | "queued" = "not-requested";
    let queuedRuns: readonly QueuedConversationRun[] = [];
    if (actor.kind === "human") {
      try {
        queuedRuns = await queueConversationRuns(
          {
            workspaceId: actor.workspaceId,
            channelId: channel.id,
            requesterId: actor.id,
            triggeringMessage: message,
          },
          {
            listBindings: (id) => repositories.replicants.listBindings(id),
            getReplicant: (id) => repositories.replicants.get(id),
            listNewestMessages: (id, limit) =>
              repositories.messages.list(id, { limit }),
            canInteract: (replicant) =>
              can(
                actor,
                {
                  permission: "replicant:interact",
                  resourceType: "replicant",
                  resourceId: replicant.id,
                },
                dependencies,
              ),
            async ensureDirectory(relativePath) {
              await requireFiles(dependencies).ensureDirectory(
                "workspace",
                relativePath,
              );
            },
            resolveWorkspaceCwd: (relativePath) =>
              resolvedWorkspaceCwd(dependencies, relativePath),
            findLatestSuccessfulSession: (query) =>
              repositories.runs.findLatestSession(
                query.workspaceId,
                query.replicantId,
                query.channelId,
                query.harness,
              ),
            enqueueRuns(inputs) {
              const runtime = requireRuntime(dependencies);
              database.transaction(() => {
                for (const input of inputs) {
                  runtime.enqueue(input);
                  appendAudit(
                    dependencies,
                    request,
                    actor,
                    "message.run.queued",
                    "run",
                    input.run.id,
                    {
                      messageId: message.id,
                      replicantId: input.run.replicantId,
                    },
                  );
                }
              });
            },
            nextRunId: () => nextId("run"),
            now: dependencies.now,
          },
        );
        dispatchStatus = queuedRuns.length === 0 ? "not-requested" : "queued";
      } catch {
        dispatchStatus = "failed";
        // The message transaction has already committed. Observability is
        // best-effort here so a secondary audit/notification failure cannot
        // turn a successfully persisted message into an HTTP failure.
        try {
          database.transaction(() => {
            appendAudit(
              dependencies,
              request,
              actor,
              "message.dispatch.failed",
              "message",
              message.id,
              {
                channelId: channel.id,
                reason: "runtime_dispatch_failed",
              },
            );
            repositories.notifications.create({
              id: nextId("notification"),
              workspaceId: actor.workspaceId,
              recipientUserId: actor.id,
              kind: "replicant-dispatch-failed",
              title: "Replicant dispatch was not queued",
              body: "Your message was saved, but bound Replicants could not be queued. Check the local runtime and try again.",
              resourceType: "message",
              resourceId: message.id,
              createdAt: dependencies.now(),
              readAt: null,
            });
          });
        } catch {
          // Persistence of the original human message remains authoritative.
        }
      }
    }
    await reply.code(201).send({
      data: message,
      meta: { dispatch: { status: dispatchStatus, queuedRuns } },
    });
  });

  app.get("/api/v1/replicants", async (request) => {
    const { actor } = await context(request, dependencies);
    const { repositories } = requireServices(dependencies);
    const items = repositories.replicants
      .list(actor.workspaceId)
      .filter((replicant) =>
        can(
          actor,
          {
            permission: "replicant:read",
            resourceType: "replicant",
            resourceId: replicant.id,
          },
          dependencies,
        ),
      );
    return data({ items });
  });

  app.post("/api/v1/replicants", async (request, reply) => {
    const { actor } = await context(request, dependencies);
    requirePermission(
      actor,
      { permission: "replicant:create", resourceType: "replicant" },
      dependencies,
    );
    const body = parseInput(createReplicantBody, request.body);
    const { database, repositories } = requireServices(dependencies);
    const now = dependencies.now();
    const replicant: Replicant = {
      id: nextId("replicant"),
      workspaceId: actor.workspaceId,
      slug: body.slug,
      name: body.name,
      description: body.description,
      persona: body.persona,
      defaultHarness: body.defaultHarness,
      defaultModel: body.defaultModel,
      relativeWorkspacePath: `replicants/${body.slug}/workspace`,
      relativeMemoryPath: `replicants/${body.slug}/workspace/memory`,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    await provisionReplicantDirectories(dependencies, replicant);
    database.transaction(() => {
      repositories.replicants.create(replicant);
      appendAudit(
        dependencies,
        request,
        actor,
        "replicant.created",
        "replicant",
        replicant.id,
      );
    });
    await reply.code(201).send(data(replicant));
  });

  app.get("/api/v1/replicants/:id/bindings", async (request) => {
    const { actor } = await context(request, dependencies);
    const params = parseInput(resourceParams, request.params);
    const replicantId = parseEntityId("replicant", params.id);
    const { repositories } = requireServices(dependencies);
    const replicant = repositories.replicants.get(replicantId);
    if (replicant === null) notFound();
    assertWorkspace(actor, replicant.workspaceId);
    requirePermission(
      actor,
      {
        permission: "replicant:read",
        resourceType: "replicant",
        resourceId: replicant.id,
      },
      dependencies,
    );
    const items = repositories.channels
      .list(actor.workspaceId)
      .flatMap((channel) => repositories.replicants.listBindings(channel.id))
      .filter((binding) => binding.replicantId === replicant.id);
    return data({ items });
  });

  app.post("/api/v1/replicants/:id/bindings", async (request, reply) => {
    const { actor } = await context(request, dependencies);
    const params = parseInput(resourceParams, request.params);
    const body = parseInput(createBindingBody, request.body);
    const replicantId = parseEntityId("replicant", params.id);
    const channelId = parseEntityId("channel", body.channelId);
    const { database, repositories } = requireServices(dependencies);
    const replicant = repositories.replicants.get(replicantId);
    const channel = repositories.channels.get(channelId);
    if (replicant === null || channel === null) notFound();
    assertWorkspace(actor, replicant.workspaceId);
    assertWorkspace(actor, channel.workspaceId);
    requirePermission(
      actor,
      {
        permission: "replicant:manage",
        resourceType: "replicant",
        resourceId: replicant.id,
      },
      dependencies,
    );
    requirePermission(
      actor,
      {
        permission: "channel:manage",
        resourceType: "channel",
        resourceId: channel.id,
      },
      dependencies,
    );
    const now = dependencies.now();
    const binding = {
      id: nextId("binding"),
      channelId: channel.id,
      replicantId: replicant.id,
      behavior: body.behavior,
      createdAt: now,
      updatedAt: now,
    };
    database.transaction(() => {
      repositories.replicants.bind(binding);
      appendAudit(
        dependencies,
        request,
        actor,
        "replicant.binding.updated",
        "replicant",
        replicant.id,
        { channelId: channel.id, behavior: binding.behavior },
      );
    });
    await reply.code(201).send(data(binding));
  });

  app.get("/api/v1/tasks", async (request) => {
    const { actor } = await context(request, dependencies);
    const query = parseInput(taskQuery, request.query);
    const { repositories } = requireServices(dependencies);
    const items = repositories.tasks
      .list(actor.workspaceId, {
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.projectId === undefined
          ? {}
          : { projectId: parseEntityId("project", query.projectId) }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      })
      .filter((task) =>
        can(
          actor,
          {
            permission: "task:read",
            resourceType: "task",
            resourceId: task.id,
          },
          dependencies,
        ),
      );
    return data({ items });
  });

  app.post("/api/v1/tasks", async (request, reply) => {
    const { actor } = await context(request, dependencies);
    requirePermission(
      actor,
      { permission: "task:create", resourceType: "task" },
      dependencies,
    );
    const body = parseInput(createTaskBody, request.body);
    const { database, repositories } = requireServices(dependencies);
    const now = dependencies.now();
    const task: Task = {
      id: nextId("task"),
      workspaceId: actor.workspaceId,
      projectId:
        body.projectId === null
          ? null
          : parseEntityId("project", body.projectId),
      title: body.title,
      notes: body.notes,
      status: body.status,
      priority: body.priority,
      dueAt: body.dueAt as IsoTimestamp | null,
      assigneeUserId:
        body.assigneeUserId === null
          ? null
          : parseEntityId("user", body.assigneeUserId),
      assigneeReplicantId:
        body.assigneeReplicantId === null
          ? null
          : parseEntityId("replicant", body.assigneeReplicantId),
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now,
      completedAt: body.status === "done" ? now : null,
    };
    database.transaction(() => {
      repositories.tasks.create(task);
      appendAudit(
        dependencies,
        request,
        actor,
        "task.created",
        "task",
        task.id,
      );
    });
    await reply.code(201).send(data(task));
  });

  app.patch("/api/v1/tasks/:id/status", async (request) => {
    const { actor } = await context(request, dependencies);
    const params = parseInput(resourceParams, request.params);
    const body = parseInput(updateTaskStatusBody, request.body);
    const taskId = parseEntityId("task", params.id);
    const { database, repositories } = requireServices(dependencies);
    const existing = repositories.tasks.get(taskId);
    if (existing === null) notFound();
    assertWorkspace(actor, existing.workspaceId);
    requirePermission(
      actor,
      {
        permission: "task:write",
        resourceType: "task",
        resourceId: existing.id,
      },
      dependencies,
    );
    const updated = database.transaction(() => {
      const result = repositories.tasks.setStatus(
        existing.id,
        body.status,
        dependencies.now(),
      );
      appendAudit(
        dependencies,
        request,
        actor,
        "task.status.updated",
        "task",
        result.id,
        {
          from: existing.status,
          to: result.status,
        },
      );
      return result;
    });
    return data(updated);
  });

  app.get("/api/v1/schedules", async (request) => {
    const { actor } = await context(request, dependencies);
    const query = parseInput(scheduleQuery, request.query);
    const { repositories } = requireServices(dependencies);
    const items = repositories.schedules
      .list(actor.workspaceId, query.limit)
      .filter((schedule) =>
        can(
          actor,
          {
            permission: "schedule:read",
            resourceType: "schedule",
            resourceId: schedule.id,
          },
          dependencies,
        ),
      );
    return data({ items });
  });

  app.post("/api/v1/schedules", async (request, reply) => {
    const { actor } = await context(request, dependencies);
    requirePermission(
      actor,
      { permission: "schedule:create", resourceType: "schedule" },
      dependencies,
    );
    const body = parseInput(createScheduleBody, request.body);
    const { database, repositories } = requireServices(dependencies);
    const replicantId = parseEntityId("replicant", body.replicantId);
    const replicant = repositories.replicants.get(replicantId);
    if (replicant === null) notFound();
    assertWorkspace(actor, replicant.workspaceId);
    const now = dependencies.now();
    let nextRunAt: IsoTimestamp | null = null;
    if (body.status === "enabled") {
      try {
        nextRunAt = nextCronOccurrence(
          body.cronExpression,
          body.timezone,
          now,
        ).toISOString() as IsoTimestamp;
      } catch (error) {
        if (
          error instanceof CronExpressionError ||
          error instanceof CronSearchExhaustedError
        ) {
          throw new HttpError(
            400,
            "invalid_request",
            "The schedule expression is invalid.",
          );
        }
        throw error;
      }
    }
    const schedule: Schedule = {
      id: nextId("schedule"),
      workspaceId: actor.workspaceId,
      name: body.name,
      description: body.description,
      cronExpression: body.cronExpression,
      timezone: body.timezone,
      status: body.status,
      replicantId,
      channelId:
        body.channelId === null
          ? null
          : parseEntityId("channel", body.channelId),
      taskId: body.taskId === null ? null : parseEntityId("task", body.taskId),
      harnessOverride: body.harnessOverride,
      modelOverride: body.modelOverride,
      effortOverride: body.effortOverride,
      prompt: body.prompt,
      retryPolicy: body.retryPolicy,
      outcomeAssertions: body.outcomeAssertions,
      nextRunAt,
      lastRunAt: null,
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now,
    };
    database.transaction(() => {
      repositories.schedules.create(schedule);
      appendAudit(
        dependencies,
        request,
        actor,
        "schedule.created",
        "schedule",
        schedule.id,
      );
    });
    await reply.code(201).send(data(schedule));
  });

  app.get("/api/v1/schedules/:id", async (request) => {
    const { actor } = await context(request, dependencies);
    const params = parseInput(resourceParams, request.params);
    const { repositories } = requireServices(dependencies);
    const schedule = repositories.schedules.get(
      parseEntityId("schedule", params.id),
    );
    if (schedule === null) notFound();
    assertWorkspace(actor, schedule.workspaceId);
    requirePermission(
      actor,
      {
        permission: "schedule:read",
        resourceType: "schedule",
        resourceId: schedule.id,
      },
      dependencies,
    );
    return data(schedule);
  });

  app.post("/api/v1/schedules/:id/run-now", async (request, reply) => {
    const { actor } = await context(request, dependencies);
    const params = parseInput(resourceParams, request.params);
    parseInput(emptyBody, request.body);
    const { database, repositories } = requireServices(dependencies);
    const schedule = repositories.schedules.get(
      parseEntityId("schedule", params.id),
    );
    if (schedule === null) notFound();
    assertWorkspace(actor, schedule.workspaceId);
    requirePermission(
      actor,
      {
        permission: "schedule:run",
        resourceType: "schedule",
        resourceId: schedule.id,
      },
      dependencies,
    );
    const replicant = repositories.replicants.get(schedule.replicantId);
    if (replicant === null) notFound();
    if (replicant.status !== "active") {
      throw new HttpError(
        409,
        "conflict",
        "The scheduled Replicant is not active.",
      );
    }
    const runtime = requireRuntime(dependencies);
    let systemPrompt: string;
    try {
      systemPrompt = buildReplicantSystemPrompt(replicant);
    } catch {
      throw new HttpError(
        503,
        "service_unavailable",
        "The stored Replicant profile is invalid.",
      );
    }
    await provisionReplicantDirectories(dependencies, replicant);
    const cwd = resolvedWorkspaceCwd(
      dependencies,
      replicant.relativeWorkspacePath,
    );
    let retryPolicy;
    try {
      retryPolicy = parseRetryPolicy(schedule.retryPolicy);
    } catch {
      throw new HttpError(
        503,
        "service_unavailable",
        "The stored schedule retry policy is invalid.",
      );
    }
    const run: Run = {
      id: nextId("run"),
      workspaceId: actor.workspaceId,
      replicantId: schedule.replicantId,
      channelId: schedule.channelId,
      taskId: schedule.taskId,
      scheduleId: schedule.id,
      parentRunId: null,
      trigger: "schedule",
      status: "queued",
      harness: schedule.harnessOverride ?? replicant.defaultHarness,
      model: schedule.modelOverride ?? replicant.defaultModel,
      effort: schedule.effortOverride,
      harnessSessionKey: null,
      requestedBy: actor.id,
      createdAt: dependencies.now(),
      startedAt: null,
      finishedAt: null,
      inputTokens: null,
      outputTokens: null,
      costMicros: null,
      errorCode: null,
      errorMessage: null,
    };
    try {
      database.transaction(() => {
        runtime.enqueue({
          run,
          execution: {
            prompt: schedule.prompt,
            cwd,
            systemPrompt,
            approvalMode: "ask",
            retryPolicy,
          },
        });
        appendAudit(
          dependencies,
          request,
          actor,
          "schedule.run.queued",
          "run",
          run.id,
          {
            scheduleId: schedule.id,
          },
        );
      });
    } catch {
      throw new HttpError(
        503,
        "service_unavailable",
        "The scheduled run could not be queued.",
      );
    }
    await reply.code(202).send(data(publicRun(run)));
  });

  app.get("/api/v1/harnesses", async (request) => {
    const { actor } = await context(request, dependencies);
    requirePermission(
      actor,
      { permission: "replicant:manage", resourceType: "replicant" },
      dependencies,
    );
    const runtime = requireRuntime(dependencies);
    try {
      return data({ items: runtime.manifests() });
    } catch {
      throw new HttpError(
        503,
        "service_unavailable",
        "Harness manifests are unavailable.",
      );
    }
  });

  app.post("/api/v1/harnesses/doctor", async (request) => {
    const { actor } = await context(request, dependencies);
    parseInput(emptyBody, request.body);
    requirePermission(
      actor,
      { permission: "replicant:manage", resourceType: "replicant" },
      dependencies,
    );
    const runtime = requireRuntime(dependencies);
    try {
      return data({ items: await runtime.doctors() });
    } catch {
      throw new HttpError(
        503,
        "service_unavailable",
        "Harness diagnostics could not be completed.",
      );
    }
  });

  app.get("/api/v1/runs", async (request) => {
    const { actor } = await context(request, dependencies);
    const query = parseInput(listQuery, request.query);
    const { repositories } = requireServices(dependencies);
    const items = repositories.runs
      .list(actor.workspaceId, query.limit)
      .filter((run) =>
        can(
          actor,
          { permission: "run:read", resourceType: "run", resourceId: run.id },
          dependencies,
        ),
      )
      .map(publicRun);
    return data({ items });
  });

  app.get("/api/v1/runs/:id", async (request) => {
    const { actor } = await context(request, dependencies);
    const params = parseInput(resourceParams, request.params);
    const query = parseInput(listQuery, request.query);
    const { repositories } = requireServices(dependencies);
    const run = repositories.runs.get(parseEntityId("run", params.id));
    if (run === null) notFound();
    assertWorkspace(actor, run.workspaceId);
    requirePermission(
      actor,
      {
        permission: "run:read",
        resourceType: "run",
        resourceId: run.id,
      },
      dependencies,
    );
    let projection: PublicRunProjection | null = null;
    if (dependencies.runtime !== null) {
      try {
        const stored = dependencies.runtime.getProjection(run.id);
        projection = stored === null ? null : publicRunProjection(stored);
      } catch {
        throw new HttpError(
          503,
          "service_unavailable",
          "The run projection is temporarily unavailable.",
        );
      }
    }
    return data({
      run: publicRun(run),
      projection,
      events: repositories.runs
        .listEvents(run.id, -1, query.limit ?? 200)
        .map(publicRunEvent),
    });
  });

  app.post("/api/v1/runs/:id/cancel", async (request, reply) => {
    const { actor } = await context(request, dependencies);
    const params = parseInput(resourceParams, request.params);
    parseInput(emptyBody, request.body);
    const { database, repositories } = requireServices(dependencies);
    const run = repositories.runs.get(parseEntityId("run", params.id));
    if (run === null) notFound();
    assertWorkspace(actor, run.workspaceId);
    requirePermission(
      actor,
      {
        permission: "run:cancel",
        resourceType: "run",
        resourceId: run.id,
      },
      dependencies,
    );
    const runtime = requireRuntime(dependencies);
    let cancellation: "not-found" | "recorded" | "terminal";
    try {
      cancellation = await runtime.cancel(run.id);
    } catch {
      throw new HttpError(
        503,
        "service_unavailable",
        "The cancellation request could not be recorded.",
      );
    }
    database.transaction(() => {
      appendAudit(
        dependencies,
        request,
        actor,
        cancellation === "recorded"
          ? "run.cancellation.requested"
          : "run.cancellation.noop",
        "run",
        run.id,
        { result: cancellation },
      );
    });
    if (cancellation === "not-found") {
      throw new HttpError(
        409,
        "conflict",
        "The run is not cancellable by the local runtime.",
      );
    }
    await reply
      .code(cancellation === "recorded" ? 202 : 200)
      .send(data({ runId: run.id, cancellation }));
  });

  app.get("/api/v1/users", async (request) => {
    const { actor } = await context(request, dependencies);
    const query = parseInput(listQuery, request.query);
    const { repositories } = requireServices(dependencies);
    const items = repositories.users
      .list(actor.workspaceId, query.limit)
      .filter((user) =>
        can(
          actor,
          {
            permission: "user:read",
            resourceType: "user",
            resourceId: user.id,
            resourceOwnerId: user.id,
          },
          dependencies,
        ),
      );
    return data({ items });
  });

  app.post("/api/v1/users", async (request, reply) => {
    const { actor } = await context(request, dependencies);
    requirePermission(
      actor,
      { permission: "user:manage", resourceType: "user" },
      dependencies,
    );
    const body = parseInput(createUserBody, request.body);
    const { database, repositories, passwords } = requireServices(dependencies);
    const passwordHash =
      body.kind === "human"
        ? await passwords.hashPassword(body.password)
        : null;
    const now = dependencies.now();
    const user: User = {
      id: nextId("user"),
      workspaceId: actor.workspaceId,
      kind: body.kind,
      handle: body.handle,
      displayName: body.displayName,
      role: body.role,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    database.transaction(() => {
      repositories.users.create({ user, passwordHash });
      appendAudit(
        dependencies,
        request,
        actor,
        "user.created",
        "user",
        user.id,
        {
          role: user.role,
        },
      );
    });
    await reply.code(201).send(data(user));
  });

  app.patch("/api/v1/users/:id/status", async (request) => {
    const { actor } = await context(request, dependencies);
    requirePermission(
      actor,
      { permission: "user:manage", resourceType: "user" },
      dependencies,
    );
    const params = parseInput(resourceParams, request.params);
    const body = parseInput(updateUserStatusBody, request.body);
    const { database, repositories } = requireServices(dependencies);
    const user = repositories.users.get(parseEntityId("user", params.id));
    if (user === null) notFound();
    assertWorkspace(actor, user.workspaceId);
    if (user.id === actor.id && body.status !== "active") {
      throw new HttpError(
        400,
        "invalid_request",
        "You cannot suspend your current account.",
      );
    }
    const updated = database.transaction(() => {
      const result = repositories.users.setStatus(
        user.id,
        body.status,
        dependencies.now(),
      );
      if (body.status !== "active") {
        repositories.sessions.revokeAllForUser(user.id, dependencies.now());
      }
      appendAudit(
        dependencies,
        request,
        actor,
        "user.status.updated",
        "user",
        user.id,
        {
          from: user.status,
          to: result.status,
        },
      );
      return result;
    });
    return data(updated);
  });

  app.post("/api/v1/grants", async (request, reply) => {
    const { actor } = await context(request, dependencies);
    requirePermission(
      actor,
      { permission: "access:manage", resourceType: "access" },
      dependencies,
    );
    const body = parseInput(createGrantBody, request.body);
    const { database, repositories } = requireServices(dependencies);
    const grant: AccessGrant = {
      id: nextId("grant"),
      workspaceId: actor.workspaceId,
      subjectType: body.subjectType,
      subjectUserId:
        body.subjectUserId === null
          ? null
          : parseEntityId("user", body.subjectUserId),
      subjectRole: body.subjectRole,
      permission: body.permission,
      resourceType: permissionResourceType(body.permission),
      resourceId: normalizedGrantResourceId(
        body.permission,
        body.resourceId,
        dependencies,
      ),
      effect: body.effect,
      reason: body.reason,
      createdBy: actor.id,
      createdAt: dependencies.now(),
      expiresAt: body.expiresAt as IsoTimestamp | null,
      revokedAt: null,
    };
    if (grant.subjectUserId !== null) {
      const target = repositories.users.get(grant.subjectUserId);
      if (target === null) notFound();
      assertWorkspace(actor, target.workspaceId);
    }
    database.transaction(() => {
      repositories.accessGrants.create(grant);
      appendAudit(
        dependencies,
        request,
        actor,
        "grant.created",
        "access",
        grant.id,
        {
          effect: grant.effect,
          permission: grant.permission,
          resourceId: grant.resourceId,
        },
      );
    });
    await reply.code(201).send(data(grant));
  });

  app.get("/api/v1/users/:id/grants", async (request) => {
    const { actor } = await context(request, dependencies);
    requirePermission(
      actor,
      { permission: "access:manage", resourceType: "access" },
      dependencies,
    );
    const params = parseInput(resourceParams, request.params);
    const { repositories } = requireServices(dependencies);
    const user = repositories.users.get(parseEntityId("user", params.id));
    if (user === null) notFound();
    assertWorkspace(actor, user.workspaceId);
    return data({
      items: repositories.accessGrants.listForActor(
        user.id,
        user.role,
        dependencies.now(),
      ),
    });
  });

  app.get("/api/v1/approvals", async (request) => {
    const { actor } = await context(request, dependencies);
    requirePermission(
      actor,
      { permission: "approval:read", resourceType: "approval" },
      dependencies,
    );
    const query = parseInput(listQuery, request.query);
    const { repositories } = requireServices(dependencies);
    return data({
      items: repositories.approvals.listPending(
        actor.workspaceId,
        dependencies.now(),
        query.limit,
      ),
    });
  });

  app.post("/api/v1/approvals/:id/decision", async (request) => {
    const { actor } = await context(request, dependencies);
    const params = parseInput(approvalParams, request.params);
    const body = parseInput(approvalDecisionBody, request.body);
    const { database, repositories } = requireServices(dependencies);
    const approval = repositories.approvals.get(params.id as ApprovalId);
    if (approval === null) notFound();
    assertWorkspace(actor, approval.workspaceId);
    if (
      approval.status !== "pending" ||
      approval.expiresAt <= dependencies.now()
    ) {
      throw new HttpError(
        409,
        "conflict",
        "The approval is no longer pending.",
      );
    }
    requirePermission(
      actor,
      {
        permission: "approval:decide",
        resourceType: "approval",
        resourceId: approval.id,
      },
      dependencies,
    );
    if (approval.runId !== null) {
      if (dependencies.runtime === null) {
        throw new HttpError(
          503,
          "service_unavailable",
          "The runtime is unavailable for this approval decision.",
        );
      }
      try {
        await dependencies.runtime.respondToApproval(
          approval.runId,
          approval.id,
          { outcome: body.decision === "approved" ? "allow" : "deny" },
        );
      } catch {
        throw new HttpError(
          503,
          "service_unavailable",
          "The approval decision could not be dispatched.",
        );
      }
    }
    const updated = database.transaction(() => {
      const result = repositories.approvals.decide(
        approval.id,
        body.decision,
        actor.id,
        dependencies.now(),
      );
      appendAudit(
        dependencies,
        request,
        actor,
        "approval.decided",
        "approval",
        result.id,
        {
          decision: result.status,
          actionDigest: createHash("sha256")
            .update(result.actionDigest)
            .digest("hex"),
        },
      );
      return result;
    });
    return data(updated);
  });

  app.get("/api/v1/notifications", async (request) => {
    const { actor } = await context(request, dependencies);
    requirePermission(
      actor,
      {
        permission: "notification:read",
        resourceType: "notification",
        resourceOwnerId: actor.id,
      },
      dependencies,
    );
    const query = parseInput(listQuery, request.query);
    const { repositories } = requireServices(dependencies);
    return data({
      items: repositories.notifications.listForUser(actor.id, {
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      }),
    });
  });

  app.post("/api/v1/notifications/:id/read", async (request) => {
    const { actor } = await context(request, dependencies);
    const params = parseInput(resourceParams, request.params);
    requirePermission(
      actor,
      {
        permission: "notification:manage",
        resourceType: "notification",
        resourceId: params.id,
        resourceOwnerId: actor.id,
      },
      dependencies,
    );
    const { database, repositories } = requireServices(dependencies);
    const notificationId = parseEntityId("notification", params.id);
    const changed = database.transaction(() => {
      const result = repositories.notifications.markRead(
        notificationId,
        actor.id,
        dependencies.now(),
      );
      if (!result) notFound();
      appendAudit(
        dependencies,
        request,
        actor,
        "notification.read",
        "notification",
        notificationId,
      );
      return result;
    });
    return data({ changed });
  });

  app.get("/api/v1/audit", async (request) => {
    const { actor } = await context(request, dependencies);
    requirePermission(
      actor,
      { permission: "audit:read", resourceType: "audit" },
      dependencies,
    );
    const query = parseInput(auditQuery, request.query);
    const { repositories } = requireServices(dependencies);
    return data({
      items: repositories.audit.listForResource(
        actor.workspaceId,
        query.resourceType,
        query.resourceId,
        query.limit,
      ),
    });
  });

  app.get("/api/v1/settings", async (request) => {
    const { actor } = await context(request, dependencies);
    requirePermission(
      actor,
      {
        permission: "workspace:read",
        resourceType: "workspace",
        resourceId: actor.workspaceId,
      },
      dependencies,
    );
    const { repositories } = requireServices(dependencies);
    return data({
      "ui.theme": repositories.workspaces.getSetting(
        actor.workspaceId,
        "ui.theme",
      ),
      "ui.timezone": repositories.workspaces.getSetting(
        actor.workspaceId,
        "ui.timezone",
      ),
      "terminal.enabled":
        repositories.workspaces.getSetting(
          actor.workspaceId,
          "terminal.enabled",
        ) ?? false,
      "telemetry.enabled":
        repositories.workspaces.getSetting(
          actor.workspaceId,
          "telemetry.enabled",
        ) ?? false,
    });
  });

  app.put("/api/v1/settings/:key", async (request) => {
    const { actor } = await context(request, dependencies);
    requirePermission(
      actor,
      {
        permission: "workspace:manage",
        resourceType: "workspace",
        resourceId: actor.workspaceId,
      },
      dependencies,
    );
    const params = parseInput(settingParams, request.params);
    const body = parseInput(settingBody, request.body);
    if (
      (params.key === "terminal.enabled" ||
        params.key === "telemetry.enabled") &&
      typeof body.value !== "boolean"
    ) {
      throw new HttpError(400, "invalid_request", "The request is invalid.");
    }
    if (
      (params.key === "ui.theme" || params.key === "ui.timezone") &&
      typeof body.value !== "string"
    ) {
      throw new HttpError(400, "invalid_request", "The request is invalid.");
    }
    const { database, repositories } = requireServices(dependencies);
    database.transaction(() => {
      repositories.workspaces.setSetting(
        actor.workspaceId,
        params.key,
        body.value,
        actor.id,
        dependencies.now(),
      );
      appendAudit(
        dependencies,
        request,
        actor,
        "workspace.setting.updated",
        "workspace",
        actor.workspaceId,
        { key: params.key },
      );
    });
    return data({ key: params.key, value: body.value });
  });

  await registerSecurityServiceRoutes(app, config, dependencies);
}
