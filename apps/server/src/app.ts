import { randomUUID } from "node:crypto";

import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import {
  makeRealtimeEnvelope,
  REALTIME_SUBPROTOCOL,
} from "@replicantos/protocol";
import Fastify, { LogController, type FastifyInstance } from "fastify";

import { authenticateToken, sessionTokenFromRequest } from "./auth.js";
import type { ServerConfig } from "./config.js";
import {
  createProductionDependencies,
  lockedDependencies,
  type ProductionDependencyOptions,
  type ServerDependencies,
} from "./dependencies.js";
import { HttpError } from "./errors.js";
import { registerApiRoutes } from "./routes.js";
import {
  assertServerStartupConfig,
  registerResponsePolicy,
  registerUnsafePathRejection,
  registerWebApplication,
  sendNotFoundOrApplicationShell,
  validateWebRoot,
} from "./web-app.js";

const MUTATING_METHODS = new Set(["DELETE", "PATCH", "POST", "PUT"]);
const MUTATION_RATE_LIMIT_MAX = 120;

function failure(code: string, message: string) {
  return { error: { code, message } };
}

function hasRealtimeSubprotocol(header: string | undefined): boolean {
  return (
    header
      ?.split(",")
      .map((value) => value.trim())
      .includes(REALTIME_SUBPROTOCOL) === true
  );
}

export async function createApp(
  config: ServerConfig,
  dependencies: ServerDependencies = lockedDependencies,
): Promise<FastifyInstance> {
  assertServerStartupConfig(config);
  const app = Fastify({
    bodyLimit: 2 * 1024 * 1024,
    routerOptions: { maxParamLength: 1_000 },
    logController: new LogController({ disableRequestLogging: true }),
    logger: config.isProduction
      ? {
          level: "info",
          redact: [
            "req.headers.cookie",
            "req.headers.authorization",
            "request.headers.cookie",
            "request.body.password",
          ],
        }
      : false,
    trustProxy: false,
  });
  registerResponsePolicy(app, config);
  registerUnsafePathRejection(app);

  await app.register(cookie, { hook: "onRequest" });
  await app.register(cors, {
    credentials: true,
    origin(origin, callback) {
      callback(null, origin === undefined || config.allowedOrigins.has(origin));
    },
  });
  await app.register(rateLimit, { global: false });
  const limitMutation = app.rateLimit({
    max: MUTATION_RATE_LIMIT_MAX,
    timeWindow: "1 minute",
  });
  await app.register(websocket, {
    options: {
      maxPayload: 64 * 1024,
      perMessageDeflate: false,
      handleProtocols(protocols: Set<string>) {
        return protocols.has(REALTIME_SUBPROTOCOL)
          ? REALTIME_SUBPROTOCOL
          : false;
      },
    },
  });
  const webApplicationRegistered = await registerWebApplication(
    app,
    config.webRoot,
  );

  app.addHook("onRequest", async (request, reply) => {
    if (!MUTATING_METHODS.has(request.method)) return;
    const origin = request.headers.origin;
    if (origin === undefined || !config.allowedOrigins.has(origin)) {
      await reply
        .code(403)
        .send(failure("origin_rejected", "The request origin is not allowed."));
    }
  });

  app.addHook("preHandler", async (request, reply) => {
    if (
      request.url.startsWith("/api/v1/") &&
      MUTATING_METHODS.has(request.method)
    ) {
      await limitMutation.call(app, request, reply);
    }
  });

  app.get("/api/v1/health", async () => ({
    data: { service: "replicantos-server", status: "ok" },
  }));

  await registerApiRoutes(app, config, dependencies);

  app.get(
    "/api/v1/realtime",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        const origin = request.headers.origin;
        if (origin === undefined || !config.allowedOrigins.has(origin)) {
          await reply
            .code(403)
            .send(
              failure("origin_rejected", "The request origin is not allowed."),
            );
          return;
        }
        if (
          !hasRealtimeSubprotocol(request.headers["sec-websocket-protocol"])
        ) {
          await reply
            .code(400)
            .send(
              failure("invalid_request", "The realtime protocol is required."),
            );
          return;
        }
        const authentication = await authenticateToken(
          dependencies,
          sessionTokenFromRequest(request),
        );
        if (authentication === null) {
          await reply
            .code(401)
            .send(
              failure("authentication_required", "Authentication is required."),
            );
        }
      },
    },
    (socket, request) => {
      const token = sessionTokenFromRequest(request);
      socket.on("message", () => {
        socket.close(1_008, "Server-push connection");
      });
      const revalidation = setInterval(() => {
        void authenticateToken(dependencies, token).then(
          (authentication) => {
            if (authentication === null)
              socket.close(4_401, "Authentication required");
          },
          () => socket.close(1_011, "Session check failed"),
        );
      }, 30_000);
      revalidation.unref();
      socket.once("close", () => clearInterval(revalidation));

      void authenticateToken(dependencies, token).then((authentication) => {
        if (authentication === null) {
          socket.close(4_401, "Authentication required");
          return;
        }
        setImmediate(() => {
          if (socket.readyState !== socket.OPEN) return;
          socket.send(
            JSON.stringify({
              ...makeRealtimeEnvelope({
                eventId: randomUUID(),
                workspaceId: authentication.actor.workspaceId,
                sequence: 0,
                occurredAt: dependencies.now(),
                type: "presence.updated",
                data: { actorId: authentication.actor.id, state: "connected" },
              }),
            }),
          );
        });
      });
    },
  );

  app.addHook("onClose", async () => {
    await dependencies.close();
  });

  app.setNotFoundHandler(async (request, reply) => {
    await sendNotFoundOrApplicationShell(
      request,
      reply,
      webApplicationRegistered,
    );
  });

  app.setErrorHandler(async (error: unknown, _request, reply) => {
    if (error instanceof HttpError) {
      await reply
        .code(error.statusCode)
        .send(failure(error.code, error.message));
      return;
    }

    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400
        ? error.statusCode
        : undefined;
    if (statusCode === 429) {
      await reply
        .code(429)
        .send(failure("rate_limited", "Too many requests. Try again later."));
      return;
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      (error.code.startsWith("ERR_SQLITE_CONSTRAINT") ||
        (error.code === "ERR_SQLITE_ERROR" &&
          "message" in error &&
          typeof error.message === "string" &&
          error.message.startsWith("UNIQUE constraint failed:")))
    ) {
      await reply
        .code(409)
        .send(failure("conflict", "The request conflicts with existing data."));
      return;
    }
    if (statusCode !== undefined && statusCode < 500) {
      await reply
        .code(statusCode)
        .send(failure("invalid_request", "The request is invalid."));
      return;
    }
    await reply
      .code(500)
      .send(
        failure("internal_error", "The server could not complete the request."),
      );
  });

  return app;
}

export async function createProductionApp(
  config: ServerConfig,
  options: ProductionDependencyOptions = {},
): Promise<FastifyInstance> {
  assertServerStartupConfig(config);
  if (config.webRoot !== null) await validateWebRoot(config.webRoot);
  const dependencies = await createProductionDependencies(config, options);
  try {
    const app = await createApp(config, dependencies);
    if (config.runtimeEnabled) await dependencies.runtime?.start();
    return app;
  } catch (error) {
    await dependencies.close();
    throw error;
  }
}
