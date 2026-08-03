import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { loadServerConfig, type ServerConfig } from "./config.js";

const ORIGIN = "https://replicantos.example.invalid";
const SHELL_MARKER = "synthetic-application-shell";
const OUTSIDE_MARKER = "synthetic-private-file";

interface WebFixture {
  app: FastifyInstance;
  directory: string;
  webRoot: string;
}

const fixtures: WebFixture[] = [];
const temporaryDirectories: string[] = [];

const baseConfig: ServerConfig = {
  allowedOrigins: new Set([ORIGIN]),
  allowedOriginsConfigured: true,
  approvedFileRoots: {
    library: "/tmp/replicantos-library",
    workspace: "/tmp/replicantos-workspace",
  },
  dataDirectory: "/tmp/replicantos-data",
  host: "127.0.0.1",
  isProduction: true,
  port: 8_787,
  runtimeEnabled: false,
  secureCookies: true,
  webRoot: null,
};

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    await fixture.app.close();
  }
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      await rm(directory, { force: true, recursive: true });
    }
  }
});

async function makeWebBuild(): Promise<{
  directory: string;
  webRoot: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "replicantos-web-test-"));
  temporaryDirectories.push(directory);
  const webRoot = join(directory, "dist");
  await mkdir(join(webRoot, "assets"), { recursive: true });
  await writeFile(
    join(webRoot, "index.html"),
    `<!doctype html><html><body>${SHELL_MARKER}</body></html>`,
  );
  await writeFile(
    join(webRoot, "assets/application-ABCDEF12.js"),
    "globalThis.syntheticApplication = true;",
  );
  await writeFile(join(webRoot, "plain.txt"), "synthetic-public-file");
  await mkdir(join(webRoot, "api/v1"), { recursive: true });
  await writeFile(join(webRoot, "api/v1/static-leak"), "must not be served");
  await writeFile(join(webRoot, "sw.js"), "// synthetic service worker");
  await writeFile(
    join(webRoot, "manifest.webmanifest"),
    JSON.stringify({ name: "Synthetic application" }),
  );
  await writeFile(join(webRoot, ".env"), "SHOULD_NOT_BE_SERVED=true");
  await writeFile(join(directory, "private.txt"), OUTSIDE_MARKER);
  return { directory, webRoot };
}

async function createWebFixture(): Promise<WebFixture> {
  const { directory, webRoot } = await makeWebBuild();
  const app = await createApp({ ...baseConfig, webRoot });
  const fixture = { app, directory, webRoot };
  fixtures.push(fixture);
  return fixture;
}

describe("production server configuration", () => {
  it("requires an explicit canonical production origin", () => {
    expect(() => loadServerConfig({ NODE_ENV: "production" })).toThrow(
      /REPLICANTOS_ALLOWED_ORIGINS must be explicitly configured/u,
    );
    expect(() =>
      loadServerConfig({
        NODE_ENV: "production",
        REPLICANTOS_ALLOWED_ORIGINS: "   ",
      }),
    ).toThrow(/REPLICANTOS_ALLOWED_ORIGINS must be explicitly configured/u);
  });

  it("uses the built web application by default only in production", () => {
    const production = loadServerConfig({
      NODE_ENV: "production",
      REPLICANTOS_ALLOWED_ORIGINS: ORIGIN,
    });
    const development = loadServerConfig({ NODE_ENV: "development" });

    expect(production.allowedOriginsConfigured).toBe(true);
    expect(production.allowedOrigins).toEqual(new Set([ORIGIN]));
    expect(production.secureCookies).toBe(true);
    expect(production.webRoot).toBe(
      resolve(import.meta.dirname, "../../web/dist"),
    );
    expect(development.allowedOriginsConfigured).toBe(false);
    expect(development.secureCookies).toBe(false);
    expect(development.webRoot).toBeNull();
  });

  it("permits non-Secure cookies only for production loopback HTTP", () => {
    for (const origin of [
      "http://127.0.0.1:8787",
      "http://127.0.0.2:8787",
      "http://localhost:8787",
      "http://[::1]:8787",
    ]) {
      const configured = loadServerConfig({
        NODE_ENV: "production",
        REPLICANTOS_ALLOWED_ORIGINS: origin,
      });
      expect(configured.secureCookies, origin).toBe(false);
    }

    expect(() =>
      loadServerConfig({
        NODE_ENV: "production",
        REPLICANTOS_ALLOWED_ORIGINS: "http://192.0.2.1:8787",
      }),
    ).toThrow(/Use HTTPS for network access/u);
    expect(() =>
      loadServerConfig({
        NODE_ENV: "production",
        REPLICANTOS_ALLOWED_ORIGINS: `${ORIGIN},http://127.0.0.1:8787`,
      }),
    ).toThrow(/cannot mix HTTPS with loopback HTTP/u);
    expect(() =>
      loadServerConfig({
        NODE_ENV: "production",
        REPLICANTOS_ALLOWED_ORIGINS: "http://127.0.0.1:8787",
        REPLICANTOS_HOST: "0.0.0.0",
      }),
    ).toThrow(/require a loopback REPLICANTOS_HOST/u);
    expect(
      loadServerConfig({
        NODE_ENV: "production",
        REPLICANTOS_ALLOWED_ORIGINS: ORIGIN,
        REPLICANTOS_HOST: "0.0.0.0",
      }).secureCookies,
    ).toBe(true);
  });

  it("accepts only an explicit absolute web build path", () => {
    expect(() =>
      loadServerConfig({ REPLICANTOS_WEB_ROOT: "relative/web/dist" }),
    ).toThrow(/absolute paths/u);

    const configured = loadServerConfig({
      REPLICANTOS_WEB_ROOT: "/tmp/../tmp/web",
    });
    expect(configured.webRoot).toBe("/tmp/web");
  });

  it("rejects manually constructed unsafe production startup settings", async () => {
    const { webRoot } = await makeWebBuild();
    await expect(
      createApp({
        ...baseConfig,
        allowedOriginsConfigured: false,
        webRoot,
      }),
    ).rejects.toThrow(/REPLICANTOS_ALLOWED_ORIGINS/u);
    await expect(
      createApp({
        ...baseConfig,
        allowedOrigins: new Set(),
        webRoot,
      }),
    ).rejects.toThrow(/REPLICANTOS_ALLOWED_ORIGINS/u);
    await expect(
      createApp({
        ...baseConfig,
        allowedOrigins: new Set(["https://replicantos.example.invalid/path"]),
        webRoot,
      }),
    ).rejects.toThrow(/canonical HTTP origins/u);
    await expect(
      createApp({ ...baseConfig, secureCookies: false, webRoot }),
    ).rejects.toThrow(/session cookie policy/u);
    await expect(
      createApp({
        ...baseConfig,
        allowedOrigins: new Set(["http://127.0.0.1:8787"]),
        host: "0.0.0.0",
        secureCookies: false,
        webRoot,
      }),
    ).rejects.toThrow(/loopback REPLICANTOS_HOST/u);
    await expect(createApp({ ...baseConfig, webRoot: null })).rejects.toThrow(
      /production web build is required/u,
    );
  });

  it("fails startup when the web build or its regular index is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "replicantos-empty-web-"));
    temporaryDirectories.push(directory);

    await expect(
      createApp({ ...baseConfig, webRoot: join(directory, "missing") }),
    ).rejects.toThrow(/web build directory does not exist/u);
    await expect(
      createApp({ ...baseConfig, webRoot: directory }),
    ).rejects.toThrow(/missing index\.html/u);

    await writeFile(join(directory, "target.html"), "synthetic index");
    await symlink("target.html", join(directory, "index.html"));
    await expect(
      createApp({ ...baseConfig, webRoot: directory }),
    ).rejects.toThrow(/index\.html must be a regular file/u);
  });
});

describe("same-origin web application serving", () => {
  it("serves static assets and falls back to the shell only for HTML routes", async () => {
    const fixture = await createWebFixture();
    const root = await fixture.app.inject({
      method: "GET",
      url: "/",
      headers: { accept: "text/html" },
    });
    const nestedRoute = await fixture.app.inject({
      method: "GET",
      url: "/workspace/tasks",
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    const headRoute = await fixture.app.inject({
      method: "HEAD",
      url: "/workspace/tasks",
      headers: { accept: "text/html" },
    });
    const asset = await fixture.app.inject({
      method: "GET",
      url: "/assets/application-ABCDEF12.js",
    });

    expect(root.statusCode).toBe(200);
    expect(root.body).toContain(SHELL_MARKER);
    expect(nestedRoute.statusCode).toBe(200);
    expect(nestedRoute.body).toContain(SHELL_MARKER);
    expect(headRoute.statusCode).toBe(200);
    expect(headRoute.body).toBe("");
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain("syntheticApplication");
  });

  it("preserves JSON API 404s and does not mask missing assets", async () => {
    const fixture = await createWebFixture();
    const api = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/does-not-exist",
      headers: { accept: "text/html" },
    });
    const collidingApiFile = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/static-leak",
      headers: { accept: "text/html" },
    });
    const jsonPage = await fixture.app.inject({
      method: "GET",
      url: "/workspace/tasks",
      headers: { accept: "application/json" },
    });
    const missingAsset = await fixture.app.inject({
      method: "GET",
      url: "/assets/missing.js",
      headers: { accept: "text/html" },
    });

    for (const response of [api, collidingApiFile, jsonPage, missingAsset]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: {
          code: "not_found",
          message: "The requested resource does not exist.",
        },
      });
      expect(response.body).not.toContain(SHELL_MARKER);
    }
  });

  it("rejects encoded traversal, hidden files, and symlink escapes", async () => {
    const fixture = await createWebFixture();
    await symlink(
      join(fixture.directory, "private.txt"),
      join(fixture.webRoot, "linked-private.txt"),
    );
    const paths = [
      "/%2e%2e/private.txt",
      "/%252e%252e%252fprivate.txt",
      "/.env",
      "/%2eenv",
      "/assets/%2e%2e%2findex.html",
      "/linked-private.txt",
    ];

    for (const path of paths) {
      const response = await fixture.app.inject({
        method: "GET",
        url: path,
        headers: { accept: "text/html" },
      });
      expect(response.statusCode, path).toBe(404);
      expect(response.body, path).not.toContain(OUTSIDE_MARKER);
      expect(response.body, path).not.toContain(SHELL_MARKER);
    }
  });

  it("sets browser isolation and explicit cache policy headers", async () => {
    const fixture = await createWebFixture();
    const shell = await fixture.app.inject({
      method: "GET",
      url: "/workspace",
      headers: { accept: "text/html" },
    });
    const api = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/health",
    });
    const asset = await fixture.app.inject({
      method: "GET",
      url: "/assets/application-ABCDEF12.js",
    });
    const serviceWorker = await fixture.app.inject({
      method: "GET",
      url: "/sw.js",
    });
    const manifest = await fixture.app.inject({
      method: "GET",
      url: "/manifest.webmanifest",
    });

    const policy = String(shell.headers["content-security-policy"]);
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("ws:");
    expect(shell.headers["x-content-type-options"]).toBe("nosniff");
    expect(shell.headers["x-frame-options"]).toBe("DENY");
    expect(shell.headers["referrer-policy"]).toBe("no-referrer");
    expect(shell.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(shell.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(shell.headers["strict-transport-security"]).toBe("max-age=31536000");
    expect(shell.headers["cache-control"]).toBe(
      "no-cache, max-age=0, must-revalidate",
    );
    expect(api.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(api.headers.pragma).toBe("no-cache");
    expect(api.headers.expires).toBe("0");
    expect(asset.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(serviceWorker.headers["cache-control"]).toBe(
      "no-cache, max-age=0, must-revalidate",
    );
    expect(manifest.headers["cache-control"]).toBe(
      "no-cache, max-age=0, must-revalidate",
    );
  });
});
