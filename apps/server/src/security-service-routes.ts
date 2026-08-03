import { createHash } from "node:crypto";
import { basename } from "node:path";

import type { Artifact } from "@replicantos/core";
import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  appendAudit,
  can,
  createAuditRecord,
  nextId,
  parseEntityId,
  requireAuthentication,
  requirePermission,
  requireServices,
} from "./auth.js";
import type { ServerConfig } from "./config.js";
import type { ServerDependencies } from "./dependencies.js";
import { HttpError, parseInput } from "./errors.js";
import {
  databaseRowsQuery,
  databaseTableParams,
  documentIndexBody,
  documentListQuery,
  fileListQuery,
  fileTextQuery,
  fileWriteBody,
  resourceParams,
} from "./schemas.js";

function data<Value>(value: Value): { data: Value } {
  return { data: value };
}

function notFound(): never {
  throw new HttpError(
    404,
    "not_found",
    "The requested resource does not exist.",
  );
}

function requireApprovedReadSource(
  request: FastifyRequest,
  config: ServerConfig,
): void {
  const origin = request.headers.origin;
  const fetchSite = request.headers["sec-fetch-site"];
  const approvedFetchSite = fetchSite === "same-origin" || fetchSite === "none";
  if (fetchSite !== undefined && !approvedFetchSite) {
    throw new HttpError(
      403,
      "origin_rejected",
      "The request origin is not allowed.",
    );
  }
  if (origin !== undefined && config.allowedOrigins.has(origin)) return;
  if (origin === undefined && approvedFetchSite) return;

  throw new HttpError(
    403,
    "origin_rejected",
    "The request origin is not allowed.",
  );
}

function requireFileService(dependencies: ServerDependencies) {
  const services = requireServices(dependencies);
  if (dependencies.files === null) {
    throw new HttpError(
      503,
      "service_unavailable",
      "The file service is not configured.",
    );
  }
  return { ...services, files: dependencies.files };
}

function requireDatabaseViewer(dependencies: ServerDependencies) {
  const services = requireServices(dependencies);
  if (dependencies.databaseViewer === null) {
    throw new HttpError(
      503,
      "service_unavailable",
      "The database viewer is not configured.",
    );
  }
  return { ...services, databaseViewer: dependencies.databaseViewer };
}

function requireDocumentIndex(dependencies: ServerDependencies) {
  const services = requireFileService(dependencies);
  if (dependencies.documentIndex === null) {
    throw new HttpError(
      503,
      "service_unavailable",
      "The document index is not configured.",
    );
  }
  return { ...services, documentIndex: dependencies.documentIndex };
}

function appendReadAudit(
  dependencies: ServerDependencies,
  request: FastifyRequest,
  actor: Awaited<ReturnType<typeof requireAuthentication>>["actor"],
  action: string,
  resourceType: string,
  resourceId: string | null,
  detail: Parameters<typeof appendAudit>[6] = {},
): void {
  const { database } = requireServices(dependencies);
  database.transaction(() => {
    appendAudit(
      dependencies,
      request,
      actor,
      action,
      resourceType,
      resourceId,
      detail,
    );
  });
}

export async function registerSecurityServiceRoutes(
  app: FastifyInstance,
  config: ServerConfig,
  dependencies: ServerDependencies,
): Promise<void> {
  app.get("/api/v1/files", async (request) => {
    const { actor } = await requireAuthentication(request, dependencies);
    requireApprovedReadSource(request, config);
    const query = parseInput(fileListQuery, request.query);
    const { files } = requireFileService(dependencies);
    const resourceId = files.resourceId(query.root, query.path);
    requirePermission(
      actor,
      {
        permission: "file:read",
        resourceType: "file",
        resourceId,
      },
      dependencies,
    );
    const items = (await files.list(query.root, query.path)).filter((entry) =>
      can(
        actor,
        {
          permission: "file:read",
          resourceType: "file",
          resourceId: files.resourceId(query.root, entry.path),
        },
        dependencies,
      ),
    );
    appendReadAudit(
      dependencies,
      request,
      actor,
      "file.listed",
      "file",
      resourceId,
      { count: items.length, root: query.root },
    );
    return data({ items });
  });

  app.get("/api/v1/files/text", async (request) => {
    const { actor } = await requireAuthentication(request, dependencies);
    requireApprovedReadSource(request, config);
    const query = parseInput(fileTextQuery, request.query);
    const { files } = requireFileService(dependencies);
    const resourceId = files.resourceId(query.root, query.path);
    requirePermission(
      actor,
      {
        permission: "file:read",
        resourceType: "file",
        resourceId,
      },
      dependencies,
    );
    const file = await files.readText(query.root, query.path);
    appendReadAudit(
      dependencies,
      request,
      actor,
      "file.read",
      "file",
      resourceId,
      { byteSize: file.byteSize, root: query.root },
    );
    return data(file);
  });

  app.put("/api/v1/files/text", async (request) => {
    const { actor } = await requireAuthentication(request, dependencies);
    const body = parseInput(fileWriteBody, request.body);
    const { files } = requireFileService(dependencies);
    const resourceId = files.resourceId(body.root, body.path);
    requirePermission(
      actor,
      {
        permission: "file:write",
        resourceType: "file",
        resourceId,
      },
      dependencies,
    );
    appendReadAudit(
      dependencies,
      request,
      actor,
      "file.write.requested",
      "file",
      resourceId,
      {
        byteSize: Buffer.byteLength(body.content, "utf8"),
        root: body.root,
        sha256: createHash("sha256").update(body.content, "utf8").digest("hex"),
      },
    );
    let written: Awaited<ReturnType<typeof files.writeText>>;
    try {
      written = await files.writeText(body.root, body.path, body.content);
    } catch (error) {
      try {
        appendReadAudit(
          dependencies,
          request,
          actor,
          "file.write.failed",
          "file",
          resourceId,
          {
            errorCode:
              error instanceof HttpError ? error.code : "internal_error",
            root: body.root,
          },
        );
      } catch {
        // The durable request record above remains available for reconciliation.
      }
      throw error;
    }
    appendReadAudit(
      dependencies,
      request,
      actor,
      "file.written",
      "file",
      resourceId,
      { byteSize: written.byteSize, root: body.root },
    );
    return data(written);
  });

  app.post("/api/v1/documents/index", async (request, reply) => {
    const { actor } = await requireAuthentication(request, dependencies);
    const body = parseInput(documentIndexBody, request.body);
    const { documentIndex, files } = requireDocumentIndex(dependencies);
    const fileId = files.resourceId("library", body.path);
    requirePermission(
      actor,
      {
        permission: "file:read",
        resourceType: "file",
        resourceId: fileId,
      },
      dependencies,
    );
    const indexedPath = fileId.slice("library:".length);
    const relativePath = `library/${indexedPath}`;
    const existing = documentIndex.getByPath(actor.workspaceId, relativePath);
    requirePermission(
      actor,
      existing === null
        ? { permission: "artifact:create", resourceType: "artifact" }
        : {
            permission: "artifact:write",
            resourceType: "artifact",
            resourceId: existing.id,
          },
      dependencies,
    );
    const file = await files.readText("library", body.path);
    const now = dependencies.now();
    const artifact: Artifact = {
      id: nextId("artifact"),
      workspaceId: actor.workspaceId,
      kind: "document",
      name: body.name ?? basename(file.path),
      mediaType: body.mediaType,
      relativePath,
      byteSize: file.byteSize,
      sha256: createHash("sha256").update(file.content, "utf8").digest("hex"),
      searchable: true,
      createdByUserId: actor.id,
      createdByReplicantId: null,
      metadata: { root: "library" },
      createdAt: now,
      updatedAt: now,
    };
    const result = documentIndex.upsert(
      artifact,
      existing?.id ?? null,
      (stored, created) =>
        createAuditRecord(
          dependencies,
          request,
          actor,
          created ? "document.indexed" : "document.reindexed",
          "artifact",
          stored.id,
          { byteSize: stored.byteSize, path: indexedPath },
        ),
    );
    await reply.code(result.created ? 201 : 200).send(data(result.artifact));
  });

  app.get("/api/v1/documents", async (request) => {
    const { actor } = await requireAuthentication(request, dependencies);
    requireApprovedReadSource(request, config);
    const query = parseInput(documentListQuery, request.query);
    const { repositories } = requireServices(dependencies);
    const items = repositories.artifacts
      .list(actor.workspaceId, {
        searchableOnly: true,
        kind: "document",
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      })
      .filter((artifact) =>
        can(
          actor,
          {
            permission: "artifact:read",
            resourceType: "artifact",
            resourceId: artifact.id,
          },
          dependencies,
        ),
      );
    if (items.length === 0) {
      requirePermission(
        actor,
        { permission: "artifact:read", resourceType: "artifact" },
        dependencies,
      );
    }
    appendReadAudit(
      dependencies,
      request,
      actor,
      "document.listed",
      "artifact",
      null,
      { count: items.length },
    );
    return data({ items });
  });

  app.get("/api/v1/documents/:id/text", async (request) => {
    const { actor } = await requireAuthentication(request, dependencies);
    requireApprovedReadSource(request, config);
    const params = parseInput(resourceParams, request.params);
    const artifactId = parseEntityId("artifact", params.id);
    const { files, repositories } = requireFileService(dependencies);
    const artifact = repositories.artifacts.get(artifactId);
    if (
      artifact === null ||
      artifact.workspaceId !== actor.workspaceId ||
      artifact.kind !== "document" ||
      !artifact.relativePath.startsWith("library/")
    ) {
      notFound();
    }
    requirePermission(
      actor,
      {
        permission: "artifact:read",
        resourceType: "artifact",
        resourceId: artifact.id,
      },
      dependencies,
    );
    const path = artifact.relativePath.slice("library/".length);
    requirePermission(
      actor,
      {
        permission: "file:read",
        resourceType: "file",
        resourceId: files.resourceId("library", path),
      },
      dependencies,
    );
    const file = await files.readText("library", path);
    const currentSha256 = createHash("sha256")
      .update(file.content, "utf8")
      .digest("hex");
    if (
      file.byteSize !== artifact.byteSize ||
      currentSha256 !== artifact.sha256
    ) {
      appendReadAudit(
        dependencies,
        request,
        actor,
        "document.stale",
        "artifact",
        artifact.id,
        { actualByteSize: file.byteSize, indexedByteSize: artifact.byteSize },
      );
      throw new HttpError(
        409,
        "conflict",
        "The indexed document changed. Reindex it before reading.",
      );
    }
    appendReadAudit(
      dependencies,
      request,
      actor,
      "document.read",
      "artifact",
      artifact.id,
      { byteSize: file.byteSize },
    );
    return data({ artifact, file });
  });

  app.get("/api/v1/database/tables", async (request) => {
    const { actor } = await requireAuthentication(request, dependencies);
    requireApprovedReadSource(request, config);
    const { databaseViewer } = requireDatabaseViewer(dependencies);
    const items = databaseViewer.tables().filter((table) =>
      can(
        actor,
        {
          permission: "database:inspect",
          resourceType: "database",
          resourceId: table.name,
        },
        dependencies,
      ),
    );
    if (items.length === 0) {
      requirePermission(
        actor,
        { permission: "database:inspect", resourceType: "database" },
        dependencies,
      );
    }
    appendReadAudit(
      dependencies,
      request,
      actor,
      "database.tables.viewed",
      "database",
      null,
      { count: items.length },
    );
    return data({ items });
  });

  app.get("/api/v1/database/tables/:table/rows", async (request) => {
    const { actor } = await requireAuthentication(request, dependencies);
    requireApprovedReadSource(request, config);
    const params = parseInput(databaseTableParams, request.params);
    const query = parseInput(databaseRowsQuery, request.query);
    requirePermission(
      actor,
      {
        permission: "database:inspect",
        resourceType: "database",
        resourceId: params.table,
      },
      dependencies,
    );
    const { databaseViewer } = requireDatabaseViewer(dependencies);
    const page = databaseViewer.rows(
      params.table,
      actor.workspaceId,
      query.limit,
      query.offset,
    );
    appendReadAudit(
      dependencies,
      request,
      actor,
      "database.rows.viewed",
      "database",
      params.table,
      { limit: query.limit, offset: query.offset, rowCount: page.rows.length },
    );
    return data(page);
  });
}
