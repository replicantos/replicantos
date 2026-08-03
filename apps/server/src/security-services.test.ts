import {
  mkdir,
  link,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createEntityId } from "@replicantos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "./app.js";
import { loadServerConfig, type ServerConfig } from "./config.js";
import {
  createProductionDependencies,
  type ServerDependencies,
} from "./dependencies.js";
import { SafeDatabaseViewer } from "./database-viewer.js";
import { MAX_TEXT_FILE_BYTES, SafeFileService } from "./file-service.js";

const ORIGIN = "http://localhost:4310";
const OWNER_PASSWORD = "synthetic-owner-password";
const MEMBER_PASSWORD = "synthetic-member-password";

interface Fixture {
  app: Awaited<ReturnType<typeof createApp>>;
  config: ServerConfig;
  dependencies: ServerDependencies;
  directory: string;
}

const fixtures: Fixture[] = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    await fixture.app.close();
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

async function createFixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "replicantos-security-test-"));
  const config: ServerConfig = {
    allowedOrigins: new Set([ORIGIN]),
    allowedOriginsConfigured: true,
    approvedFileRoots: {
      library: join(directory, "approved/library"),
      workspace: join(directory, "approved/workspace"),
    },
    dataDirectory: directory,
    host: "127.0.0.1",
    isProduction: false,
    port: 8_787,
    runtimeEnabled: false,
    secureCookies: false,
    webRoot: null,
  };
  const dependencies = await createProductionDependencies(config, {
    databasePath: join(directory, "server.sqlite"),
  });
  const app = await createApp(config, dependencies);
  const fixture = { app, config, dependencies, directory };
  fixtures.push(fixture);
  return fixture;
}

function cookieHeader(
  response: Awaited<ReturnType<Fixture["app"]["inject"]>>,
): string {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) throw new Error("Response did not set a cookie");
  return value.split(";", 1)[0] ?? "";
}

function authenticatedHeaders(cookie: string) {
  return { cookie, origin: ORIGIN };
}

async function bootstrapAndLogin(fixture: Fixture): Promise<string> {
  const bootstrap = await fixture.app.inject({
    method: "POST",
    url: "/api/v1/system/bootstrap",
    headers: { origin: ORIGIN },
    payload: {
      workspaceName: "Synthetic Workspace",
      handle: "owner",
      displayName: "Workspace Owner",
      password: OWNER_PASSWORD,
    },
  });
  expect(bootstrap.statusCode).toBe(201);
  const login = await fixture.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin: ORIGIN },
    payload: { handle: "owner", password: OWNER_PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  return cookieHeader(login);
}

async function writeText(
  fixture: Fixture,
  cookie: string,
  root: "library" | "workspace",
  path: string,
  content: string,
) {
  return fixture.app.inject({
    method: "PUT",
    url: "/api/v1/files/text",
    headers: authenticatedHeaders(cookie),
    payload: { root, path, content },
  });
}

describe("approved-root file service", () => {
  it("accepts browser same-origin read metadata and rejects unproven or cross-site reads", async () => {
    const fixture = await createFixture();
    const cookie = await bootstrapAndLogin(fixture);
    const read = (url: string, headers: Record<string, string>) =>
      fixture.app.inject({
        method: "GET",
        url,
        headers: { cookie, ...headers },
      });
    const filesUrl = "/api/v1/files?root=workspace";

    for (const url of [
      filesUrl,
      "/api/v1/documents",
      "/api/v1/database/tables",
    ]) {
      expect(
        (await read(url, { "sec-fetch-site": "same-origin" })).statusCode,
        url,
      ).toBe(200);
    }
    expect(
      (await read(filesUrl, { "sec-fetch-site": "none" })).statusCode,
    ).toBe(200);
    expect((await read(filesUrl, { origin: ORIGIN })).statusCode).toBe(200);
    expect((await read(filesUrl, {})).statusCode).toBe(403);
    expect(
      (await read(filesUrl, { "sec-fetch-site": "same-site" })).statusCode,
    ).toBe(403);
    expect(
      (await read(filesUrl, { "sec-fetch-site": "cross-site" })).statusCode,
    ).toBe(403);
    expect(
      (
        await read(filesUrl, {
          origin: ORIGIN,
          "sec-fetch-site": "cross-site",
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await read(filesUrl, {
          origin: "https://outside.example.invalid",
          "sec-fetch-site": "same-origin",
        })
      ).statusCode,
    ).toBe(403);

    const mutationWithoutOrigin = await fixture.app.inject({
      method: "PUT",
      url: "/api/v1/files/text",
      headers: { cookie, "sec-fetch-site": "same-origin" },
      payload: {
        root: "workspace",
        path: "metadata-must-not-authorize-writes.txt",
        content: "synthetic content",
      },
    });
    expect(mutationWithoutOrigin.statusCode).toBe(403);
    expect(mutationWithoutOrigin.json()).toEqual({
      error: {
        code: "origin_rejected",
        message: "The request origin is not allowed.",
      },
    });
  });

  it("loads configurable roots and rejects overlapping or symlinked roots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "replicantos-root-test-"));
    try {
      const configured = loadServerConfig({
        NODE_ENV: "test",
        REPLICANTOS_DATA_DIR: join(directory, "data"),
        REPLICANTOS_LIBRARY_ROOT: join(directory, "documents"),
        REPLICANTOS_WORKSPACE_ROOT: join(directory, "workspaces"),
      });
      expect(configured.approvedFileRoots).toEqual({
        library: resolve(directory, "documents"),
        workspace: resolve(directory, "workspaces"),
      });
      expect(() =>
        loadServerConfig({ REPLICANTOS_WORKSPACE_ROOT: "   " }),
      ).toThrow();
      expect(() =>
        loadServerConfig({ REPLICANTOS_LIBRARY_ROOT: "relative/library" }),
      ).toThrow();

      expect(
        () =>
          new SafeFileService({
            workspace: join(directory, "overlap"),
            library: join(directory, "overlap/library"),
          }),
      ).toThrow(/must not overlap/u);

      await mkdir(join(directory, "real-root"));
      await symlink(join(directory, "real-root"), join(directory, "root-link"));
      expect(
        () =>
          new SafeFileService({
            workspace: join(directory, "root-link"),
            library: join(directory, "separate-library"),
          }),
      ).toThrow(/must not be symbolic links/u);

      const identityProbe = new SafeFileService({
        workspace: join(directory, "identity-workspace"),
        library: join(directory, "identity-library"),
      });
      if (identityProbe.identityPolicies.workspace.caseInsensitive) {
        expect(
          () =>
            new SafeFileService({
              workspace: join(directory, "CaseRoot"),
              library: join(directory, "caseroot/library"),
            }),
        ).toThrow(/must not overlap/u);
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("provisions bounded Replicant directories without following symlinks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "replicantos-dir-test-"));
    try {
      const service = new SafeFileService({
        workspace: join(directory, "workspace"),
        library: join(directory, "library"),
      });
      await service.ensureDirectory("workspace", "replicants/atlas/workspace");
      await service.ensureDirectory("workspace", "replicants/atlas/workspace");
      await expect(
        service.resolveDirectory("workspace", "replicants/atlas/workspace"),
      ).resolves.toBe(
        join(service.roots.workspace, "replicants", "atlas", "workspace"),
      );
      expect(await service.list("workspace", "replicants/atlas")).toEqual([
        expect.objectContaining({ kind: "directory", name: "workspace" }),
      ]);

      await expect(
        service.ensureDirectory("workspace", "../outside"),
      ).rejects.toThrow();
      await expect(
        service.ensureDirectory("workspace", "replicants/runtime/workspace"),
      ).rejects.toThrow();

      await mkdir(join(directory, "outside"));
      await symlink(
        join(directory, "outside"),
        join(service.roots.workspace, "replicants", "linked"),
      );
      await expect(
        service.ensureDirectory("workspace", "replicants/linked/workspace"),
      ).rejects.toThrow();
      await expect(
        service.resolveDirectory("workspace", "replicants/linked"),
      ).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("bounds text operations and rejects traversal, hidden, denied, and symlink paths", async () => {
    const fixture = await createFixture();
    const cookie = await bootstrapAndLogin(fixture);
    const headers = authenticatedHeaders(cookie);
    const workspaceRoot = fixture.config.approvedFileRoots.workspace;

    const firstWrite = await writeText(
      fixture,
      cookie,
      "workspace",
      "note.txt",
      "first version",
    );
    expect(firstWrite.statusCode).toBe(200);
    const overwrite = await writeText(
      fixture,
      cookie,
      "workspace",
      "note.txt",
      "public fixture text",
    );
    expect(overwrite.statusCode).toBe(200);
    expect(await readFile(join(workspaceRoot, "note.txt"), "utf8")).toBe(
      "public fixture text",
    );
    expect(
      (await readdir(workspaceRoot)).filter((name) =>
        name.startsWith(".replicantos-write-"),
      ),
    ).toEqual([]);

    const read = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/files/text?root=workspace&path=note.txt",
      headers,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().data).toMatchObject({
      path: "note.txt",
      content: "public fixture text",
      byteSize: 19,
    });
    expect(
      (
        await writeText(
          fixture,
          cookie,
          "workspace",
          "Report.txt",
          "case-sensitive permission canary",
        )
      ).statusCode,
    ).toBe(200);

    await writeFile(
      join(fixture.directory, "outside.txt"),
      "outside-sensitive",
    );
    await symlink(
      join(fixture.directory, "outside.txt"),
      join(workspaceRoot, "escape-link.txt"),
    );
    await link(
      join(fixture.directory, "outside.txt"),
      join(workspaceRoot, "hard-link.txt"),
    );
    await writeFile(join(workspaceRoot, ".hidden.txt"), "hidden-sensitive");
    await mkdir(join(workspaceRoot, "runtime"));
    await writeFile(
      join(workspaceRoot, "runtime/state.txt"),
      "runtime-sensitive",
    );
    await writeFile(join(workspaceRoot, "visible.txt"), "visible");
    const owner = fixture.dependencies.repositories?.users.list(
      fixture.dependencies.repositories.workspaces.getOnly()!.id,
    )[0];
    const denyNote = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/grants",
      headers,
      payload: {
        subjectType: "user",
        subjectUserId: owner!.id,
        permission: "file:read",
        resourceId: "workspace:note.txt",
        effect: "deny",
      },
    });
    expect(denyNote.statusCode).toBe(201);
    const denyReport = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/grants",
      headers,
      payload: {
        subjectType: "user",
        subjectUserId: owner!.id,
        permission: "file:read",
        resourceId: "workspace:Report.txt",
        effect: "deny",
      },
    });
    expect(denyReport.statusCode).toBe(201);
    const reportResourceId = fixture.dependencies.files!.resourceId(
      "workspace",
      "Report.txt",
    );
    const alternateReportResourceId = fixture.dependencies.files!.resourceId(
      "workspace",
      "report.txt",
    );
    expect(denyReport.json().data.resourceId).toBe(reportResourceId);
    expect(reportResourceId === alternateReportResourceId).toBe(
      fixture.dependencies.files!.identityPolicies.workspace.caseInsensitive,
    );

    const alternateCase = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/files/text?root=workspace&path=report.txt",
      headers,
    });
    expect(alternateCase.statusCode).toBe(
      reportResourceId === alternateReportResourceId ? 403 : 404,
    );

    const listing = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/files?root=workspace",
      headers,
    });
    expect(listing.statusCode).toBe(200);
    expect(
      listing.json().data.items.map((entry: { name: string }) => entry.name),
    ).toEqual(["visible.txt"]);

    for (const path of [
      "..%2Foutside.txt",
      ".hidden.txt",
      "runtime%2Fstate.txt",
      "escape-link.txt",
      "hard-link.txt",
    ]) {
      const response = await fixture.app.inject({
        method: "GET",
        url: `/api/v1/files/text?root=workspace&path=${path}`,
        headers,
      });
      expect(response.statusCode, path).toBe(400);
      expect(JSON.stringify(response.json()), path).not.toContain("sensitive");
    }

    for (const path of [
      "..%2Foutside-write.txt",
      ".hidden-write.txt",
      "auth%2Fstate.txt",
      "credentials%2Fstate.txt",
      "backups%2Fstate.txt",
      "runtime%2Fstate.txt",
      "escape-link.txt",
      "hard-link.txt",
    ]) {
      const response = await writeText(
        fixture,
        cookie,
        "workspace",
        decodeURIComponent(path),
        "unauthorized replacement",
      );
      expect(response.statusCode, path).toBe(400);
    }
    expect(await readFile(join(fixture.directory, "outside.txt"), "utf8")).toBe(
      "outside-sensitive",
    );
    expect(
      (await readdir(workspaceRoot)).filter((name) =>
        name.startsWith(".replicantos-write-"),
      ),
    ).toEqual([]);

    await writeFile(
      join(workspaceRoot, "too-large.txt"),
      Buffer.alloc(MAX_TEXT_FILE_BYTES + 1, 97),
    );
    const oversizedRead = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/files/text?root=workspace&path=too-large.txt",
      headers,
    });
    expect(oversizedRead.statusCode).toBe(413);

    const oversizedPath = await fixture.app.inject({
      method: "GET",
      url: `/api/v1/files/text?root=workspace&path=${"a".repeat(111)}`,
      headers,
    });
    expect(oversizedPath.statusCode).toBe(400);
    const oversizedComponentBytes = await writeText(
      fixture,
      cookie,
      "workspace",
      `${"界".repeat(100)}.txt`,
      "x",
    );
    expect(oversizedComponentBytes.statusCode).toBe(400);
    const nonCanonicalUnicode = await writeText(
      fixture,
      cookie,
      "workspace",
      "e\u0301.txt",
      "x",
    );
    expect(nonCanonicalUnicode.statusCode).toBe(400);

    const oversizedUtf8Write = await writeText(
      fixture,
      cookie,
      "workspace",
      "utf8-too-large.txt",
      "é".repeat(MAX_TEXT_FILE_BYTES / 2 + 1),
    );
    expect(oversizedUtf8Write.statusCode).toBe(413);
    expect(await readdir(workspaceRoot)).not.toContain("utf8-too-large.txt");

    const missingOrigin = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/files/text?root=workspace&path=note.txt",
      headers: { cookie },
    });
    expect(missingOrigin.statusCode).toBe(403);

    const workspace = fixture.dependencies.repositories?.workspaces.getOnly();
    expect(workspace).not.toBeNull();
    const audits = fixture.dependencies.repositories?.audit.listForResource(
      workspace!.id,
      "file",
      "workspace:note.txt",
    );
    expect(audits?.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(["file.read", "file.written"]),
    );
    expect(JSON.stringify(audits)).not.toContain("public fixture text");
  });

  it("refuses oversized directory listings", async () => {
    const fixture = await createFixture();
    const cookie = await bootstrapAndLogin(fixture);
    await Promise.all(
      Array.from({ length: 201 }, async (_, index) =>
        writeFile(
          join(
            fixture.config.approvedFileRoots.workspace,
            `entry-${String(index).padStart(3, "0")}.txt`,
          ),
          "x",
        ),
      ),
    );
    const response = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/files?root=workspace",
      headers: authenticatedHeaders(cookie),
    });
    expect(response.statusCode).toBe(413);
  });

  it("persists a write intent before touching the filesystem", async () => {
    const fixture = await createFixture();
    const cookie = await bootstrapAndLogin(fixture);
    expect(
      (await writeText(fixture, cookie, "workspace", "guarded.txt", "original"))
        .statusCode,
    ).toBe(200);
    const audit = fixture.dependencies.repositories!.audit;
    const append = vi.spyOn(audit, "append").mockImplementation(() => {
      throw new Error("injected audit failure");
    });
    try {
      const response = await writeText(
        fixture,
        cookie,
        "workspace",
        "guarded.txt",
        "must not be committed",
      );
      expect(response.statusCode).toBe(500);
      expect(
        await readFile(
          join(fixture.config.approvedFileRoots.workspace, "guarded.txt"),
          "utf8",
        ),
      ).toBe("original");
    } finally {
      append.mockRestore();
    }
  });

  it("leaves a committed write as an unresolved intent when success audit fails", async () => {
    const fixture = await createFixture();
    const cookie = await bootstrapAndLogin(fixture);
    const audit = fixture.dependencies.repositories!.audit;
    const originalAppend = audit.append.bind(audit);
    let appendCount = 0;
    const append = vi.spyOn(audit, "append").mockImplementation((record) => {
      appendCount += 1;
      if (appendCount === 2) throw new Error("injected completion failure");
      return originalAppend(record);
    });
    try {
      const response = await writeText(
        fixture,
        cookie,
        "workspace",
        "unresolved.txt",
        "committed bytes",
      );
      expect(response.statusCode).toBe(500);
    } finally {
      append.mockRestore();
    }
    expect(
      await readFile(
        join(fixture.config.approvedFileRoots.workspace, "unresolved.txt"),
        "utf8",
      ),
    ).toBe("committed bytes");
    const workspace = fixture.dependencies.repositories!.workspaces.getOnly()!;
    const audits = audit.listForResource(
      workspace.id,
      "file",
      fixture.dependencies.files!.resourceId("workspace", "unresolved.txt"),
    );
    expect(audits.map((entry) => entry.action)).toEqual([
      "file.write.requested",
    ]);
    expect(JSON.stringify(audits[0]!.detail)).toMatch(/[0-9a-f]{64}/u);
  });
});

describe("document index and allowlisted database viewer", () => {
  it("indexes approved library text and exposes masked, bounded database pages", async () => {
    const fixture = await createFixture();
    const cookie = await bootstrapAndLogin(fixture);
    const headers = authenticatedHeaders(cookie);
    const documentText = "# Synthetic handbook\n\nNo private fixture data.";

    expect(
      (await writeText(fixture, cookie, "library", "handbook.md", documentText))
        .statusCode,
    ).toBe(200);
    const indexed = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/documents/index",
      headers,
      payload: {
        path: "handbook.md",
        name: "Synthetic handbook",
        mediaType: "text/markdown",
      },
    });
    expect(indexed.statusCode).toBe(201);
    expect(indexed.json().data).toMatchObject({
      kind: "document",
      name: "Synthetic handbook",
      relativePath: "library/handbook.md",
      searchable: true,
    });
    expect(indexed.json().data.relativePath).not.toContain(fixture.directory);

    const documents = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/documents",
      headers,
    });
    expect(documents.statusCode).toBe(200);
    expect(documents.json().data.items).toHaveLength(1);
    const documentId = indexed.json().data.id as string;
    const document = await fixture.app.inject({
      method: "GET",
      url: `/api/v1/documents/${documentId}/text`,
      headers,
    });
    expect(document.statusCode).toBe(200);
    expect(document.json().data.file.content).toBe(documentText);
    expect(
      (
        await writeText(
          fixture,
          cookie,
          "library",
          "handbook.md",
          "changed after indexing",
        )
      ).statusCode,
    ).toBe(200);
    const staleDocument = await fixture.app.inject({
      method: "GET",
      url: `/api/v1/documents/${documentId}/text`,
      headers,
    });
    expect(staleDocument.statusCode).toBe(409);
    const staleReindex = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/documents/index",
      headers,
      payload: { path: "handbook.md", mediaType: "text/markdown" },
    });
    expect(staleReindex.statusCode).toBe(200);
    expect(staleReindex.json().data.id).toBe(documentId);
    const reindexedDocument = await fixture.app.inject({
      method: "GET",
      url: `/api/v1/documents/${documentId}/text`,
      headers,
    });
    expect(reindexedDocument.statusCode).toBe(200);
    expect(reindexedDocument.json().data.file.content).toBe(
      "changed after indexing",
    );
    const ownerId = fixture.dependencies.repositories?.users.list(
      fixture.dependencies.repositories.workspaces.getOnly()!.id,
    )[0]!.id;
    const denyDocument = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/grants",
      headers,
      payload: {
        subjectType: "user",
        subjectUserId: ownerId,
        permission: "artifact:read",
        resourceId: documentId,
        effect: "deny",
      },
    });
    expect(denyDocument.statusCode).toBe(201);
    const filteredDocuments = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/documents",
      headers,
    });
    expect(filteredDocuments.statusCode).toBe(200);
    expect(filteredDocuments.json().data.items).toEqual([]);
    const documentsWithoutOrigin = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/documents",
      headers: { cookie },
    });
    expect(documentsWithoutOrigin.statusCode).toBe(403);

    const tables = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/database/tables",
      headers,
    });
    expect(tables.statusCode).toBe(200);
    const tableNames = tables
      .json()
      .data.items.map((table: { name: string }) => table.name);
    expect(tableNames).toEqual(
      expect.arrayContaining(["users", "messages", "artifacts", "audit_log"]),
    );
    expect(tableNames).not.toEqual(
      expect.arrayContaining([
        "sessions",
        "access_grants",
        "approvals",
        "run_events",
        "workspace_settings",
      ]),
    );
    const usersDescription = tables
      .json()
      .data.items.find((table: { name: string }) => table.name === "users");
    expect(usersDescription.columns).toContainEqual({
      name: "password_hash",
      masked: true,
    });

    const actualPasswordHash = await fixture.dependencies.readPasswordHash(
      fixture.dependencies.repositories!.users.list(
        fixture.dependencies.repositories!.workspaces.getOnly()!.id,
      )[0]!.id,
    );
    const users = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/database/tables/users/rows?limit=1&offset=0",
      headers,
    });
    expect(users.statusCode).toBe(200);
    expect(users.json().data.rows[0].password_hash).toBe("[masked]");
    expect(JSON.stringify(users.json())).not.toContain(actualPasswordHash);

    for (const [slug, name] of [
      ["alpha", "Alpha"],
      ["beta", "Beta"],
    ]) {
      const channel = await fixture.app.inject({
        method: "POST",
        url: "/api/v1/channels",
        headers,
        payload: { slug, name },
      });
      expect(channel.statusCode).toBe(201);
    }
    const channelPage = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/database/tables/channels/rows?limit=1&offset=0",
      headers,
    });
    expect(channelPage.statusCode).toBe(200);
    expect(channelPage.json().data.rows).toHaveLength(1);
    expect(channelPage.json().data.rows[0].name).toBe("[masked]");
    expect(channelPage.json().data.nextOffset).toBe(1);

    const channels = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/channels",
      headers: { cookie },
    });
    const channelId = channels.json().data.items[0].id as string;
    const secretMessage = "viewer-must-not-return-this-message";
    expect(
      (
        await fixture.app.inject({
          method: "POST",
          url: `/api/v1/channels/${channelId}/messages`,
          headers,
          payload: { content: secretMessage },
        })
      ).statusCode,
    ).toBe(201);
    const messages = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/database/tables/messages/rows",
      headers,
    });
    expect(messages.statusCode).toBe(200);
    expect(messages.json().data.rows[0].content).toBe("[masked]");
    expect(JSON.stringify(messages.json())).not.toContain(secretMessage);

    const artifacts = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/database/tables/artifacts/rows",
      headers,
    });
    expect(artifacts.statusCode).toBe(200);
    expect(artifacts.json().data.rows[0].sha256).toBe("[masked]");
    expect(artifacts.json().data.rows[0].name).toBe("[masked]");
    expect(artifacts.json().data.rows[0].relative_path).toBe("[masked]");

    expect(
      (
        await fixture.app.inject({
          method: "GET",
          url: "/api/v1/database/tables/sessions/rows",
          headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await fixture.app.inject({
          method: "GET",
          url: "/api/v1/database/tables/constructor/rows",
          headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await fixture.app.inject({
          method: "GET",
          url: "/api/v1/database/tables/users%22%3BDELETE%20FROM%20users/rows",
          headers,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await fixture.app.inject({
          method: "GET",
          url: "/api/v1/database/tables/users/rows?limit=101",
          headers,
        })
      ).statusCode,
    ).toBe(400);
    const denyUsersTable = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/grants",
      headers,
      payload: {
        subjectType: "user",
        subjectUserId: ownerId,
        permission: "database:inspect",
        resourceId: "users",
        effect: "deny",
      },
    });
    expect(denyUsersTable.statusCode).toBe(201);
    const filteredTables = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/database/tables",
      headers,
    });
    expect(
      filteredTables
        .json()
        .data.items.map((table: { name: string }) => table.name),
    ).not.toContain("users");
    expect(
      (
        await fixture.app.inject({
          method: "GET",
          url: "/api/v1/database/tables/users/rows",
          headers,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      fixture.dependencies.repositories?.workspaces.getOnly(),
    ).not.toBeNull();
    expect(
      fixture.dependencies.repositories?.users.list(
        fixture.dependencies.repositories.workspaces.getOnly()!.id,
      ),
    ).toHaveLength(1);
    const documentAudits =
      fixture.dependencies.repositories!.audit.listForResource(
        fixture.dependencies.repositories!.workspaces.getOnly()!.id,
        "artifact",
        documentId,
      );
    expect(documentAudits.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        "document.indexed",
        "document.reindexed",
        "document.read",
        "document.stale",
      ]),
    );
  });

  it("applies workspace predicates to direct and joined viewer tables", async () => {
    const directory = await mkdtemp(join(tmpdir(), "replicantos-viewer-test-"));
    const databasePath = join(directory, "viewer.sqlite");
    const workspaceA = createEntityId("workspace", "viewerwsa");
    const workspaceB = createEntityId("workspace", "viewerwsb");
    const writer = new DatabaseSync(databasePath);
    let viewer: SafeDatabaseViewer | null = null;
    try {
      writer.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL,
          handle TEXT NOT NULL, display_name TEXT NOT NULL, role TEXT NOT NULL,
          status TEXT NOT NULL, password_hash TEXT, created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE channels (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL
        );
        CREATE TABLE messages (
          id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, reply_to_id TEXT,
          author_kind TEXT NOT NULL, author_user_id TEXT,
          author_replicant_id TEXT, content TEXT NOT NULL, edited_at TEXT,
          deleted_at TEXT, created_at TEXT NOT NULL
        );
      `);
      const insertUser = writer.prepare(
        `INSERT INTO users VALUES (?, ?, 'human', ?, ?, 'admin', 'active', ?, ?, ?)`,
      );
      insertUser.run(
        "user-workspace-a",
        workspaceA,
        "handle-a-canary",
        "name-a-canary",
        "hash-a-canary",
        "2030-01-01T00:00:00.000Z",
        "2030-01-01T00:00:00.000Z",
      );
      insertUser.run(
        "user-workspace-b",
        workspaceB,
        "handle-b-canary",
        "name-b-canary",
        "hash-b-canary",
        "2030-01-01T00:00:00.000Z",
        "2030-01-01T00:00:00.000Z",
      );
      writer
        .prepare("INSERT INTO channels VALUES (?, ?)")
        .run("channel-workspace-a", workspaceA);
      writer
        .prepare("INSERT INTO channels VALUES (?, ?)")
        .run("channel-workspace-b", workspaceB);
      const insertMessage = writer.prepare(
        `INSERT INTO messages VALUES (?, ?, NULL, 'system', NULL, NULL, ?, NULL, NULL, ?)`,
      );
      insertMessage.run(
        "message-workspace-a",
        "channel-workspace-a",
        "message-a-canary",
        "2030-01-01T00:00:00.000Z",
      );
      insertMessage.run(
        "message-workspace-b",
        "channel-workspace-b",
        "message-b-canary",
        "2030-01-01T00:00:00.000Z",
      );
      writer.close();

      viewer = new SafeDatabaseViewer(databasePath);
      expect(viewer.rows("users", workspaceA, 100, 0).rows).toEqual([
        expect.objectContaining({
          id: "user-workspace-a",
          handle: "[masked]",
          display_name: "[masked]",
          password_hash: "[masked]",
        }),
      ]);
      expect(viewer.rows("messages", workspaceA, 100, 0).rows).toEqual([
        expect.objectContaining({
          id: "message-workspace-a",
          content: "[masked]",
        }),
      ]);
      expect(
        JSON.stringify([
          viewer.rows("users", workspaceA, 100, 0),
          viewer.rows("messages", workspaceA, 100, 0),
        ]),
      ).not.toContain("workspace-b");
    } finally {
      viewer?.close();
      try {
        writer.close();
      } catch {
        // The writer is normally closed before opening the read-only viewer.
      }
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("denies member reads and writes before either service can be used", async () => {
    const fixture = await createFixture();
    const ownerCookie = await bootstrapAndLogin(fixture);
    const ownerHeaders = authenticatedHeaders(ownerCookie);
    expect(
      (
        await writeText(
          fixture,
          ownerCookie,
          "workspace",
          "owner-only.txt",
          "owner content",
        )
      ).statusCode,
    ).toBe(200);
    const member = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/users",
      headers: ownerHeaders,
      payload: {
        kind: "human",
        handle: "member",
        displayName: "Synthetic Member",
        role: "member",
        password: MEMBER_PASSWORD,
      },
    });
    expect(member.statusCode).toBe(201);
    const memberLogin = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { handle: "member", password: MEMBER_PASSWORD },
    });
    expect(memberLogin.statusCode).toBe(200);
    const memberCookie = cookieHeader(memberLogin);
    const memberHeaders = authenticatedHeaders(memberCookie);

    const attempts = await Promise.all([
      fixture.app.inject({
        method: "GET",
        url: "/api/v1/files?root=workspace",
        headers: memberHeaders,
      }),
      fixture.app.inject({
        method: "GET",
        url: "/api/v1/files/text?root=workspace&path=owner-only.txt",
        headers: memberHeaders,
      }),
      fixture.app.inject({
        method: "PUT",
        url: "/api/v1/files/text",
        headers: memberHeaders,
        payload: {
          root: "workspace",
          path: "owner-only.txt",
          content: "member overwrite",
        },
      }),
      fixture.app.inject({
        method: "POST",
        url: "/api/v1/documents/index",
        headers: memberHeaders,
        payload: { path: "owner-only.txt" },
      }),
      fixture.app.inject({
        method: "GET",
        url: "/api/v1/documents",
        headers: memberHeaders,
      }),
      fixture.app.inject({
        method: "GET",
        url: "/api/v1/database/tables/users/rows",
        headers: memberHeaders,
      }),
      fixture.app.inject({
        method: "GET",
        url: "/api/v1/database/tables",
        headers: memberHeaders,
      }),
    ]);
    expect(attempts.map((response) => response.statusCode)).toEqual([
      403, 403, 403, 403, 403, 403, 403,
    ]);
    expect(
      await readFile(
        join(fixture.config.approvedFileRoots.workspace, "owner-only.txt"),
        "utf8",
      ),
    ).toBe("owner content");
    const workspace = fixture.dependencies.repositories!.workspaces.getOnly()!;
    expect(
      fixture.dependencies
        .repositories!.audit.listForResource(workspace.id, "artifact", null)
        .some((entry) => entry.action === "document.listed"),
    ).toBe(false);
    expect(
      fixture.dependencies
        .repositories!.audit.listForResource(workspace.id, "database", null)
        .some((entry) => entry.action === "database.tables.viewed"),
    ).toBe(false);
  });
});
