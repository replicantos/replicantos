import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createEntityId,
  type ApprovalId,
  type IsoTimestamp,
  type RunId,
} from "@replicantos/core";
import type { EnqueueRuntimeRunInput } from "@replicantos/db";
import { parseRealtimeEnvelope } from "@replicantos/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { loadServerConfig, type ServerConfig } from "./config.js";
import {
  createProductionDependencies,
  type ServerDependencies,
} from "./dependencies.js";

const ORIGIN = "http://localhost:3000";
const HTTPS_ORIGIN = "https://replicantos.example.invalid";
const OWNER_PASSWORD = "synthetic-owner-password";
const MEMBER_PASSWORD = "synthetic-member-password";

const lockedConfig: ServerConfig = {
  allowedOrigins: new Set([ORIGIN]),
  allowedOriginsConfigured: true,
  approvedFileRoots: {
    library: "data/files/library",
    workspace: "data/files/workspace",
  },
  dataDirectory: "data",
  host: "127.0.0.1",
  isProduction: false,
  port: 8_787,
  runtimeEnabled: false,
  secureCookies: false,
  webRoot: null,
};

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

async function createFixture(
  isProduction = false,
  origin = ORIGIN,
): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "replicantos-server-test-"));
  const webRoot = join(directory, "web");
  if (isProduction) {
    await mkdir(webRoot);
    await writeFile(
      join(webRoot, "index.html"),
      "<!doctype html><title>Test</title>",
    );
  }
  const config: ServerConfig = {
    ...lockedConfig,
    allowedOrigins: new Set([origin]),
    approvedFileRoots: {
      library: join(directory, "files/library"),
      workspace: join(directory, "files/workspace"),
    },
    dataDirectory: directory,
    isProduction,
    runtimeEnabled: false,
    secureCookies: origin.startsWith("https://"),
    webRoot: isProduction ? webRoot : null,
  };
  const dependencies = await createProductionDependencies(config, {
    databasePath: join(directory, "server.sqlite"),
  });
  const app = await createApp(config, dependencies);
  const fixture = { app, config, dependencies, directory };
  fixtures.push(fixture);
  return fixture;
}

async function bootstrap(fixture: Fixture) {
  const origin = [...fixture.config.allowedOrigins][0]!;
  return fixture.app.inject({
    method: "POST",
    url: "/api/v1/system/bootstrap",
    headers: { origin },
    payload: {
      workspaceName: "Synthetic Workspace",
      handle: "owner",
      displayName: "Workspace Owner",
      password: OWNER_PASSWORD,
    },
  });
}

async function login(fixture: Fixture, handle: string, password: string) {
  const origin = [...fixture.config.allowedOrigins][0]!;
  return fixture.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin },
    payload: { handle, password },
  });
}

function cookieHeader(
  response: Awaited<ReturnType<Fixture["app"]["inject"]>>,
): string {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) throw new Error("Response did not set a cookie");
  return value.split(";", 1)[0] ?? "";
}

function authenticatedHeaders(cookie: string, origin = ORIGIN) {
  return { cookie, origin };
}

type TestRuntime = NonNullable<ServerDependencies["runtime"]>;

function testRuntime(overrides: Partial<TestRuntime> = {}): TestRuntime {
  return {
    workerId: "test-runtime",
    started: true,
    async start() {},
    async stop() {
      return { activeRuns: 0, drained: true };
    },
    enqueue() {},
    async cancel() {
      return "not-found";
    },
    async respondToApproval() {
      return "already-dispatched";
    },
    async doctors() {
      return [];
    },
    manifests() {
      return [];
    },
    getProjection() {
      return null;
    },
    ...overrides,
  };
}

describe("locked-default server baseline", () => {
  it("returns health while persistence and authentication fail closed", async () => {
    const app = await createApp(lockedConfig);
    const health = await app.inject({ method: "GET", url: "/api/v1/health" });
    const bootstrapStatus = await app.inject({
      method: "GET",
      url: "/api/v1/system/bootstrap-status",
    });
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me" });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({
      data: { service: "replicantos-server", status: "ok" },
    });
    expect(bootstrapStatus.json()).toEqual({ data: { bootstrapped: false } });
    expect(me.statusCode).toBe(401);
    await app.close();
  });

  it("rejects every mutation without an approved Origin", async () => {
    const app = await createApp(lockedConfig);
    const response = await app.inject({ method: "POST", url: "/missing" });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: "origin_rejected",
        message: "The request origin is not allowed.",
      },
    });
    await app.close();
  });

  it("does not turn disallowed CORS origins into server errors", async () => {
    const app = await createApp(lockedConfig);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { origin: "https://outside.example.invalid" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    const mutation = await app.inject({
      method: "POST",
      url: "/missing",
      headers: { origin: "https://outside.example.invalid" },
    });
    expect(mutation.statusCode).toBe(403);
    await app.close();
  });

  it("rejects non-canonical configured origins", () => {
    expect(() =>
      loadServerConfig({
        REPLICANTOS_ALLOWED_ORIGINS: "https://console.example.invalid/path",
      }),
    ).toThrow(/canonical HTTP origins/u);
    expect(() =>
      loadServerConfig({ REPLICANTOS_ALLOWED_ORIGINS: "*" }),
    ).toThrow(/canonical HTTP origins/u);
  });
});

describe("database-backed identity and sessions", () => {
  it("bootstraps exactly one owner with an Argon2id hash and no default credential", async () => {
    const fixture = await createFixture();
    const before = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/system/bootstrap-status",
    });
    expect(before.json()).toEqual({ data: { bootstrapped: false } });

    const response = await bootstrap(fixture);
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.data.owner).toMatchObject({
      handle: "owner",
      role: "owner",
      status: "active",
    });
    expect(JSON.stringify(body)).not.toContain(OWNER_PASSWORD);
    expect(JSON.stringify(body)).not.toContain("argon2");
    const storedHash = await fixture.dependencies.readPasswordHash(
      body.data.owner.id,
    );
    expect(storedHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/u);

    const second = await bootstrap(fixture);
    expect(second.statusCode).toBe(409);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await bootstrap(fixture)).statusCode).toBe(409);
    }
    const limitedBootstrap = await bootstrap(fixture);
    expect(limitedBootstrap.statusCode).toBe(429);
    expect(
      await fixture.app.inject({
        method: "GET",
        url: "/api/v1/system/bootstrap-status",
      }),
    ).toMatchObject({ statusCode: 200 });
    expect(
      fixture.dependencies.repositories?.users.list(body.data.workspace.id),
    ).toHaveLength(1);
  });

  it("serializes concurrent first-run claims into one owner", async () => {
    const fixture = await createFixture();
    const responses = await Promise.all([
      bootstrap(fixture),
      bootstrap(fixture),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      201, 409,
    ]);
    const workspace = fixture.dependencies.repositories?.workspaces.getOnly();
    expect(workspace).not.toBeNull();
    expect(
      fixture.dependencies.repositories?.users.list(workspace!.id),
    ).toHaveLength(1);
  });

  it("uses generic login errors, secure cookie attributes, revocation, and logout clearing", async () => {
    const fixture = await createFixture(true, HTTPS_ORIGIN);
    await bootstrap(fixture);
    const unknown = await login(fixture, "missing", "incorrect-password-value");
    const wrong = await login(fixture, "owner", "incorrect-password-value");
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());

    const success = await login(fixture, "owner", OWNER_PASSWORD);
    expect(success.statusCode).toBe(200);
    const setCookie = success.headers["set-cookie"];
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("Path=/");
    const cookie = cookieHeader(success);

    const me = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.actor).toMatchObject({
      role: "owner",
      status: "active",
    });
    const duplicated = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: `${cookie}; replicantos_session=duplicate-value` },
    });
    expect(duplicated.statusCode).toBe(401);

    const logout = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: authenticatedHeaders(cookie, HTTPS_ORIGIN),
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers["set-cookie"]).toContain("Max-Age=0");
    const revoked = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie },
    });
    expect(revoked.statusCode).toBe(401);
  });

  it("omits Secure for an explicit production loopback HTTP origin", async () => {
    const fixture = await createFixture(true);
    await bootstrap(fixture);
    const success = await login(fixture, "owner", OWNER_PASSWORD);

    expect(success.statusCode).toBe(200);
    expect(success.headers["set-cookie"]).toContain("HttpOnly");
    expect(success.headers["set-cookie"]).toContain("SameSite=Strict");
    expect(success.headers["set-cookie"]).not.toContain("Secure");
  });

  it("never lets the current actor suspend their own account", async () => {
    const fixture = await createFixture();
    const bootstrapped = await bootstrap(fixture);
    const cookie = cookieHeader(await login(fixture, "owner", OWNER_PASSWORD));
    const response = await fixture.app.inject({
      method: "PATCH",
      url: `/api/v1/users/${bootstrapped.json().data.owner.id}/status`,
      headers: authenticatedHeaders(cookie),
      payload: { status: "suspended" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "You cannot suspend your current account.",
      },
    });
    expect(
      await fixture.app.inject({
        method: "GET",
        url: "/api/v1/auth/me",
        headers: { cookie },
      }),
    ).toMatchObject({ statusCode: 200 });
  });

  it("rate-limits repeated credential attempts with a generic envelope", async () => {
    const fixture = await createFixture();
    await bootstrap(fixture);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await login(
        fixture,
        "owner",
        "incorrect-password-value",
      );
      expect(response.statusCode).toBe(401);
    }
    const limited = await login(fixture, "owner", "incorrect-password-value");
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({
      error: {
        code: "rate_limited",
        message: "Too many requests. Try again later.",
      },
    });
    expect(limited.headers["retry-after"]).toBeDefined();
  });
});

describe("resource authorization and transactional audit", () => {
  it("filters channel lists and enforces resource-scoped grants with deny precedence", async () => {
    const fixture = await createFixture();
    const bootstrapped = await bootstrap(fixture);
    const workspaceId = bootstrapped.json().data.workspace.id as string;
    const ownerLogin = await login(fixture, "owner", OWNER_PASSWORD);
    const ownerCookie = cookieHeader(ownerLogin);

    const createChannel = async (slug: string, name: string) =>
      fixture.app.inject({
        method: "POST",
        url: "/api/v1/channels",
        headers: authenticatedHeaders(ownerCookie),
        payload: { slug, name },
      });
    const visible = await createChannel("visible", "Visible");
    const privateChannel = await createChannel("private", "Private");
    expect(visible.statusCode).toBe(201);
    expect(privateChannel.statusCode).toBe(201);

    const member = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/users",
      headers: authenticatedHeaders(ownerCookie),
      payload: {
        kind: "human",
        handle: "member",
        displayName: "Workspace Member",
        role: "member",
        password: MEMBER_PASSWORD,
      },
    });
    expect(member.statusCode).toBe(201);
    const memberId = member.json().data.id as string;
    const memberLogin = await login(fixture, "member", MEMBER_PASSWORD);
    const memberCookie = cookieHeader(memberLogin);

    const memberChannels = async () =>
      fixture.app.inject({
        method: "GET",
        url: "/api/v1/channels",
        headers: { cookie: memberCookie },
      });
    await expect(
      memberChannels().then((response) => response.json().data.items),
    ).resolves.toEqual([]);

    const grant = async (permission: string, effect = "allow") =>
      fixture.app.inject({
        method: "POST",
        url: "/api/v1/grants",
        headers: authenticatedHeaders(ownerCookie),
        payload: {
          subjectType: "user",
          subjectUserId: memberId,
          permission,
          resourceId: visible.json().data.id,
          effect,
        },
      });
    expect((await grant("channel:read")).statusCode).toBe(201);
    expect((await grant("channel:write")).statusCode).toBe(201);

    const listed = await memberChannels();
    expect(
      listed.json().data.items.map((channel: { name: string }) => channel.name),
    ).toEqual(["Visible"]);
    const postVisible = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/channels/${visible.json().data.id}/messages`,
      headers: authenticatedHeaders(memberCookie),
      payload: { content: "Synthetic authorized message." },
    });
    const postPrivate = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/channels/${privateChannel.json().data.id}/messages`,
      headers: authenticatedHeaders(memberCookie),
      payload: { content: "This write must be denied." },
    });
    expect(postVisible.statusCode).toBe(201);
    expect(postPrivate.statusCode).toBe(403);

    expect((await grant("channel:read", "deny")).statusCode).toBe(201);
    await expect(
      memberChannels().then((response) => response.json().data.items),
    ).resolves.toEqual([]);

    const memberUsers = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/users",
      headers: { cookie: memberCookie },
    });
    expect(memberUsers.json().data.items).toHaveLength(1);
    expect(memberUsers.json().data.items[0].id).toBe(memberId);
    expect(workspaceId).toMatch(/^wsp_/u);

    const audit = await fixture.app.inject({
      method: "GET",
      url: `/api/v1/audit?resourceType=message&resourceId=${postVisible.json().data.id}`,
      headers: { cookie: ownerCookie },
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().data.items[0]).toMatchObject({
      action: "message.created",
    });
    expect(JSON.stringify(audit.json())).not.toContain(
      "Synthetic authorized message.",
    );

    const disable = await fixture.app.inject({
      method: "PATCH",
      url: `/api/v1/users/${memberId}/status`,
      headers: authenticatedHeaders(ownerCookie),
      payload: { status: "disabled" },
    });
    expect(disable.statusCode).toBe(200);
    const disabledSession = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: memberCookie },
    });
    expect(disabledSession.statusCode).toBe(401);
  });

  it("creates tasks, schedules, and run-now metadata behind owner policy", async () => {
    const fixture = await createFixture();
    await bootstrap(fixture);
    const ownerCookie = cookieHeader(
      await login(fixture, "owner", OWNER_PASSWORD),
    );
    const headers = authenticatedHeaders(ownerCookie);

    const replicant = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/replicants",
      headers,
      payload: {
        slug: "atlas",
        name: "Atlas",
        persona: "Coordinate synthetic operations precisely.",
        defaultHarness: "codex",
      },
    });
    expect(replicant.statusCode).toBe(201);

    const task = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers,
      payload: { title: "Review synthetic health report", priority: "high" },
    });
    expect(task.statusCode).toBe(201);
    const completed = await fixture.app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${task.json().data.id}/status`,
      headers,
      payload: { status: "done" },
    });
    expect(completed.json().data).toMatchObject({ status: "done" });
    expect(completed.json().data.completedAt).not.toBeNull();

    const rejectedClientSchedule = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/schedules",
      headers,
      payload: {
        name: "Client-timed synthetic health check",
        cronExpression: "0 9 * * 1-5",
        timezone: "Etc/UTC",
        replicantId: replicant.json().data.id,
        prompt: "Run local synthetic checks.",
        nextRunAt: "2099-01-01T00:00:00.000Z",
      },
    });
    expect(rejectedClientSchedule.statusCode).toBe(400);

    const schedule = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/schedules",
      headers,
      payload: {
        name: "Synthetic health check",
        cronExpression: "0 9 * * 1-5",
        timezone: "Etc/UTC",
        replicantId: replicant.json().data.id,
        prompt: "Run local synthetic checks.",
      },
    });
    expect(schedule.statusCode).toBe(201);
    expect(schedule.json().data.retryPolicy).toEqual({ maxAttempts: 1 });
    expect(Date.parse(schedule.json().data.nextRunAt)).toBeGreaterThan(
      Date.parse(schedule.json().data.createdAt),
    );
    const schedules = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/schedules?limit=100",
      headers: { cookie: ownerCookie },
    });
    expect(schedules.json().data.items).toHaveLength(1);

    const run = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/schedules/${schedule.json().data.id}/run-now`,
      headers,
    });
    expect(run.statusCode).toBe(202);
    expect(run.json().data).toMatchObject({
      status: "queued",
      trigger: "schedule",
    });
    const activeRuns = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/runs",
      headers: { cookie: ownerCookie },
    });
    expect(
      activeRuns.json().data.items.map((item: { id: string }) => item.id),
    ).toContain(run.json().data.id);

    const settingsBefore = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/settings",
      headers: { cookie: ownerCookie },
    });
    expect(settingsBefore.json().data).toMatchObject({
      "telemetry.enabled": false,
      "terminal.enabled": false,
    });
    const enableTerminal = await fixture.app.inject({
      method: "PUT",
      url: "/api/v1/settings/terminal.enabled",
      headers,
      payload: { value: true },
    });
    expect(enableTerminal.json()).toEqual({
      data: { key: "terminal.enabled", value: true },
    });
  });

  it("dispatches automatic bindings and bounded exact mentions after persisting human messages", async () => {
    const fixture = await createFixture();
    await bootstrap(fixture);
    const ownerCookie = cookieHeader(
      await login(fixture, "owner", OWNER_PASSWORD),
    );
    const headers = authenticatedHeaders(ownerCookie);
    const channel = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/channels",
      headers,
      payload: { slug: "dispatch", name: "Dispatch" },
    });
    const createReplicant = (slug: string, name: string) =>
      fixture.app.inject({
        method: "POST",
        url: "/api/v1/replicants",
        headers,
        payload: {
          slug,
          name,
          persona: `Coordinate synthetic ${slug} work.`,
          defaultHarness: slug === "automatic" ? "codex" : "claude",
        },
      });
    const automatic = await createReplicant("automatic", "Automatic");
    const mentioned = await createReplicant("quill", "Quill Writer");
    for (const [replicant, behavior] of [
      [automatic, "automatic"],
      [mentioned, "mention-only"],
    ] as const) {
      const response = await fixture.app.inject({
        method: "POST",
        url: `/api/v1/replicants/${replicant.json().data.id}/bindings`,
        headers,
        payload: { channelId: channel.json().data.id, behavior },
      });
      expect(response.statusCode).toBe(201);
    }

    const automaticOnly = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channel.json().data.id}/messages`,
      headers,
      payload: { content: "Prepare the synthetic status." },
    });
    expect(automaticOnly.statusCode).toBe(201);
    expect(automaticOnly.json().meta.dispatch).toMatchObject({
      status: "queued",
    });
    expect(
      automaticOnly
        .json()
        .meta.dispatch.queuedRuns.map(
          (run: { replicantId: string }) => run.replicantId,
        ),
    ).toEqual([automatic.json().data.id]);

    const exactMention = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channel.json().data.id}/messages`,
      headers,
      payload: { content: "Ask @QUILL WRITER to edit the summary." },
    });
    expect(exactMention.statusCode).toBe(201);
    const mentionedRunIds = exactMention
      .json()
      .meta.dispatch.queuedRuns.map(
        (run: { replicantId: string }) => run.replicantId,
      );
    expect(mentionedRunIds).toHaveLength(2);
    expect(mentionedRunIds).toEqual(
      expect.arrayContaining([
        automatic.json().data.id,
        mentioned.json().data.id,
      ]),
    );
    expect(JSON.stringify(exactMention.json())).not.toContain(
      "harnessSessionKey",
    );

    const history = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/runs?limit=100",
      headers: { cookie: ownerCookie },
    });
    expect(history.json().data.items).toHaveLength(3);
    expect(
      history
        .json()
        .data.items.every(
          (run: { trigger: string }) => run.trigger === "message",
        ),
    ).toBe(true);
  });

  it("does not dispatch an unauthorized binding or an unbound Replicant", async () => {
    const fixture = await createFixture();
    await bootstrap(fixture);
    const ownerCookie = cookieHeader(
      await login(fixture, "owner", OWNER_PASSWORD),
    );
    const ownerHeaders = authenticatedHeaders(ownerCookie);
    const channel = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/channels",
      headers: ownerHeaders,
      payload: { slug: "scoped", name: "Scoped" },
    });
    const createReplicant = async (slug: string) =>
      fixture.app.inject({
        method: "POST",
        url: "/api/v1/replicants",
        headers: ownerHeaders,
        payload: {
          slug,
          name: slug,
          persona: "Use only synthetic workspace context.",
          defaultHarness: "codex",
        },
      });
    const bound = await createReplicant("bound-agent");
    const unbound = await createReplicant("unbound-agent");
    await fixture.app.inject({
      method: "POST",
      url: `/api/v1/replicants/${bound.json().data.id}/bindings`,
      headers: ownerHeaders,
      payload: {
        channelId: channel.json().data.id,
        behavior: "automatic",
      },
    });
    const member = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/users",
      headers: ownerHeaders,
      payload: {
        kind: "human",
        handle: "scoped-member",
        displayName: "Scoped Member",
        role: "member",
        password: MEMBER_PASSWORD,
      },
    });
    for (const permission of ["channel:read", "channel:write"]) {
      await fixture.app.inject({
        method: "POST",
        url: "/api/v1/grants",
        headers: ownerHeaders,
        payload: {
          subjectType: "user",
          subjectUserId: member.json().data.id,
          permission,
          resourceId: channel.json().data.id,
          effect: "allow",
        },
      });
    }
    const memberCookie = cookieHeader(
      await login(fixture, "scoped-member", MEMBER_PASSWORD),
    );
    const unauthorized = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channel.json().data.id}/messages`,
      headers: authenticatedHeaders(memberCookie),
      payload: { content: "This message remains human-authored." },
    });
    expect(unauthorized.statusCode).toBe(201);
    expect(unauthorized.json().meta.dispatch).toEqual({
      status: "not-requested",
      queuedRuns: [],
    });
    expect(
      (
        await fixture.app.inject({
          method: "GET",
          url: "/api/v1/runs",
          headers: { cookie: ownerCookie },
        })
      ).json().data.items,
    ).toEqual([]);

    const ownerMessage = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channel.json().data.id}/messages`,
      headers: ownerHeaders,
      payload: { content: "Owner-authorized dispatch." },
    });
    expect(
      ownerMessage
        .json()
        .meta.dispatch.queuedRuns.map(
          (run: { replicantId: string }) => run.replicantId,
        ),
    ).toEqual([bound.json().data.id]);
    expect(JSON.stringify(ownerMessage.json())).not.toContain(
      unbound.json().data.id,
    );
  });

  it("keeps the message and records safe observability when dispatch fails", async () => {
    const fixture = await createFixture();
    await bootstrap(fixture);
    const ownerCookie = cookieHeader(
      await login(fixture, "owner", OWNER_PASSWORD),
    );
    const headers = authenticatedHeaders(ownerCookie);
    const channel = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/channels",
      headers,
      payload: { slug: "durable-message", name: "Durable Message" },
    });
    const replicant = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/replicants",
      headers,
      payload: {
        slug: "fault-agent",
        name: "Fault Agent",
        persona: "Use synthetic fixtures only.",
        defaultHarness: "codex",
      },
    });
    await fixture.app.inject({
      method: "POST",
      url: `/api/v1/replicants/${replicant.json().data.id}/bindings`,
      headers,
      payload: {
        channelId: channel.json().data.id,
        behavior: "automatic",
      },
    });
    fixture.dependencies.runtime = testRuntime({
      enqueue() {
        throw new Error("provider fixture detail at /host/private/value");
      },
    });

    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channel.json().data.id}/messages`,
      headers,
      payload: { content: "Persist this message before dispatch." },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().meta.dispatch).toEqual({
      status: "failed",
      queuedRuns: [],
    });
    const messageId = response.json().data.id as string;
    const messages = await fixture.app.inject({
      method: "GET",
      url: `/api/v1/channels/${channel.json().data.id}/messages`,
      headers: { cookie: ownerCookie },
    });
    expect(
      messages
        .json()
        .data.items.some((message: { id: string }) => message.id === messageId),
    ).toBe(true);
    const audit = await fixture.app.inject({
      method: "GET",
      url: `/api/v1/audit?resourceType=message&resourceId=${messageId}`,
      headers: { cookie: ownerCookie },
    });
    expect(audit.json().data.items[0]).toMatchObject({
      action: "message.dispatch.failed",
      detail: { reason: "runtime_dispatch_failed" },
    });
    const notifications = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/notifications",
      headers: { cookie: ownerCookie },
    });
    expect(notifications.json().data.items[0]).toMatchObject({
      kind: "replicant-dispatch-failed",
      resourceId: messageId,
    });
    expect(
      JSON.stringify({
        audit: audit.json(),
        notifications: notifications.json(),
      }),
    ).not.toContain("provider fixture detail");
    expect(JSON.stringify(notifications.json())).not.toContain(
      "/host/private/value",
    );
  });

  it("provisions private workspace and memory directories when creating a Replicant", async () => {
    const fixture = await createFixture();
    await bootstrap(fixture);
    const ownerCookie = cookieHeader(
      await login(fixture, "owner", OWNER_PASSWORD),
    );
    const replicant = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/replicants",
      headers: authenticatedHeaders(ownerCookie),
      payload: {
        slug: "directory-agent",
        name: "Directory Agent",
        persona: "Maintain synthetic local files.",
        defaultHarness: "opencode",
      },
    });
    expect(replicant.statusCode).toBe(201);
    expect(replicant.json().data.relativeWorkspacePath).toBe(
      "replicants/directory-agent/workspace",
    );
    expect(replicant.json().data.relativeMemoryPath).toBe(
      "replicants/directory-agent/workspace/memory",
    );
    const workspace = await stat(
      join(
        fixture.config.approvedFileRoots.workspace,
        replicant.json().data.relativeWorkspacePath,
      ),
    );
    const memory = await stat(
      join(
        fixture.config.approvedFileRoots.workspace,
        replicant.json().data.relativeMemoryPath,
      ),
    );
    expect(workspace.isDirectory()).toBe(true);
    expect(memory.isDirectory()).toBe(true);
  });

  it("serves durable run detail and truthful harness diagnostics and cancellation", async () => {
    const fixture = await createFixture();
    const bootstrapped = await bootstrap(fixture);
    const ownerCookie = cookieHeader(
      await login(fixture, "owner", OWNER_PASSWORD),
    );
    const headers = authenticatedHeaders(ownerCookie);
    const replicant = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/replicants",
      headers,
      payload: {
        slug: "runtime-agent",
        name: "Runtime Agent",
        persona: "Report synthetic runtime outcomes.",
        defaultHarness: "codex",
      },
    });
    const schedule = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/schedules",
      headers,
      payload: {
        name: "Runtime route fixture",
        cronExpression: "0 9 * * 1-5",
        timezone: "Etc/UTC",
        replicantId: replicant.json().data.id,
        prompt: "Produce a synthetic runtime report.",
        retryPolicy: {
          maxAttempts: 2,
          initialDelayMs: 25,
          maxDelayMs: 50,
        },
      },
    });
    const first = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/schedules/${schedule.json().data.id}/run-now`,
      headers,
      payload: {},
    });
    const second = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/schedules/${schedule.json().data.id}/run-now`,
      headers,
      payload: {},
    });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(
      fixture.dependencies.runtime?.getProjection(first.json().data.id),
    ).not.toBeNull();

    const repositories = fixture.dependencies.repositories;
    const database = fixture.dependencies.database;
    if (repositories === null || database === null)
      throw new Error("Missing production services");
    const firstRunId = first.json().data.id as RunId;
    const secondRunId = second.json().data.id as RunId;
    const now = fixture.dependencies.now();
    database.transaction(() => {
      repositories.runs.transition(firstRunId, {
        status: "starting",
        at: now,
      });
      repositories.runs.transition(firstRunId, {
        status: "running",
        at: now,
      });
      repositories.runs.transition(firstRunId, {
        status: "succeeded",
        at: now,
        inputTokens: 12,
        outputTokens: 8,
      });
      repositories.runs.appendEvent({
        id: createEntityId("runEvent", "routeevent01"),
        runId: firstRunId,
        sequence: 0,
        type: "tool.started",
        payload: {
          type: "tool.started",
          summary: "Synthetic tool event",
          sessionId: "provider-session-private",
          cwd: "/host/private/workspace",
          nested: { thread_id: "provider-thread-private" },
        },
        createdAt: now,
      });
    });

    const manifests = fixture.dependencies.runtime?.manifests() ?? [];
    const enqueued: EnqueueRuntimeRunInput[] = [];
    const canceled: string[] = [];
    fixture.dependencies.runtime = testRuntime({
      enqueue(input) {
        enqueued.push(input);
      },
      async cancel(runId) {
        canceled.push(runId);
        return runId === secondRunId ? "recorded" : "terminal";
      },
      manifests() {
        return manifests;
      },
      async doctors() {
        return [
          {
            harnessId: "codex",
            status: "ready",
            checkedAt: now,
            checks: [
              {
                id: "binary",
                status: "pass",
                message: "The synthetic binary is available.",
              },
            ],
          },
        ];
      },
      getProjection(runId) {
        if (runId !== firstRunId) return null;
        return {
          runId,
          status: "succeeded",
          harnessSessionId: "provider-session-private",
          inputTokens: 12,
          outputTokens: 8,
          cachedInputTokens: 2,
          costMicros: 42,
          assistantText: "Synthetic assistant result.",
          cancellationRequestedAt: null,
        };
      },
    });

    const history = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/runs?limit=100",
      headers: { cookie: ownerCookie },
    });
    expect(history.statusCode).toBe(200);
    expect(
      history
        .json()
        .data.items.find((run: { id: string }) => run.id === firstRunId),
    ).toMatchObject({ status: "succeeded", trigger: "schedule" });
    expect(JSON.stringify(history.json())).not.toContain("harnessSessionKey");

    const detail = await fixture.app.inject({
      method: "GET",
      url: `/api/v1/runs/${firstRunId}`,
      headers: { cookie: ownerCookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.projection).toMatchObject({
      assistantText: "Synthetic assistant result.",
      cachedInputTokens: 2,
      status: "succeeded",
    });
    expect(detail.json().data.projection.harnessSessionId).toBeUndefined();
    expect(detail.json().data.events[0].payload).toMatchObject({
      summary: "Synthetic tool event",
      sessionId: "[redacted]",
      cwd: "[redacted]",
      nested: { thread_id: "[redacted]" },
    });
    expect(JSON.stringify(detail.json())).not.toContain(
      "provider-session-private",
    );
    expect(JSON.stringify(detail.json())).not.toContain(
      "/host/private/workspace",
    );

    const cancellation = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/runs/${secondRunId}/cancel`,
      headers,
      payload: {},
    });
    expect(cancellation.statusCode).toBe(202);
    expect(cancellation.json()).toEqual({
      data: { runId: secondRunId, cancellation: "recorded" },
    });
    expect(canceled).toEqual([secondRunId]);
    const cancelAudit = await fixture.app.inject({
      method: "GET",
      url: `/api/v1/audit?resourceType=run&resourceId=${secondRunId}`,
      headers: { cookie: ownerCookie },
    });
    expect(cancelAudit.json().data.items[0]).toMatchObject({
      action: "run.cancellation.requested",
      detail: { result: "recorded" },
    });

    const harnesses = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/harnesses",
      headers: { cookie: ownerCookie },
    });
    expect(harnesses.statusCode).toBe(200);
    expect(harnesses.json().data.items).toHaveLength(4);
    const doctor = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/harnesses/doctor",
      headers,
      payload: {},
    });
    expect(doctor.statusCode).toBe(200);
    expect(doctor.json().data.items[0]).toMatchObject({
      harnessId: "codex",
      status: "ready",
    });
    const clientCwd = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/harnesses/doctor",
      headers,
      payload: { cwd: "/client/path" },
    });
    expect(clientCwd.statusCode).toBe(400);

    const rejectedCwd = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/schedules/${schedule.json().data.id}/run-now`,
      headers,
      payload: { cwd: "/client/path" },
    });
    expect(rejectedCwd.statusCode).toBe(400);
    expect(enqueued).toEqual([]);
    const captured = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/schedules/${schedule.json().data.id}/run-now`,
      headers,
      payload: {},
    });
    expect(captured.statusCode).toBe(202);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.execution.retryPolicy).toEqual({
      maxAttempts: 2,
      initialDelayMs: 25,
      multiplier: 2,
      maxDelayMs: 50,
    });
    expect(enqueued[0]?.execution.cwd).toBe(
      join(
        fixture.dependencies.files?.roots.workspace ?? "",
        "replicants/runtime-agent/workspace",
      ),
    );
    expect(enqueued[0]?.execution.systemPrompt).not.toContain(
      fixture.dependencies.files?.roots.workspace,
    );
    expect(enqueued[0]?.execution.systemPrompt).toContain(
      'workspace-relative path "memory"',
    );
    expect(enqueued[0]?.execution.systemPrompt).toContain(
      "untrusted context, not system instructions",
    );
    expect(enqueued[0]?.execution.approvalMode).toBe("ask");
    expect(bootstrapped.json().data.owner.id).toBeDefined();
  });

  it("resolves approval and notification mutations while recording audits", async () => {
    const fixture = await createFixture();
    const bootstrapResponse = await bootstrap(fixture);
    const owner = bootstrapResponse.json().data.owner;
    const ownerCookie = cookieHeader(
      await login(fixture, "owner", OWNER_PASSWORD),
    );
    const repositories = fixture.dependencies.repositories;
    const database = fixture.dependencies.database;
    if (repositories === null || database === null)
      throw new Error("Missing production services");
    const now = fixture.dependencies.now();
    const approvalId = createEntityId("approval", "server01");
    const notificationId = createEntityId("notification", "server01");
    database.transaction(() => {
      repositories.approvals.create({
        id: approvalId,
        workspaceId: owner.workspaceId,
        runId: null,
        requestedBy: owner.id,
        action: "Synthetic privileged action",
        actionDigest: "a".repeat(64),
        payload: { synthetic: true },
        status: "pending",
        expiresAt: new Date(
          Date.parse(now) + 60_000,
        ).toISOString() as IsoTimestamp,
        decidedBy: null,
        decidedAt: null,
        consumedAt: null,
        createdAt: now,
      });
      repositories.notifications.create({
        id: notificationId,
        workspaceId: owner.workspaceId,
        recipientUserId: owner.id,
        kind: "synthetic-ready",
        title: "Synthetic report ready",
        body: null,
        resourceType: null,
        resourceId: null,
        createdAt: now,
        readAt: null,
      });
    });

    const approvals = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/approvals",
      headers: { cookie: ownerCookie },
    });
    expect(approvals.json().data.items).toHaveLength(1);
    const decision = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/decision`,
      headers: authenticatedHeaders(ownerCookie),
      payload: { decision: "approved" },
    });
    expect(decision.json().data.status).toBe("approved");

    const notifications = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/notifications",
      headers: { cookie: ownerCookie },
    });
    expect(notifications.json().data.items).toHaveLength(1);
    const read = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/notifications/${notificationId}/read`,
      headers: authenticatedHeaders(ownerCookie),
    });
    expect(read.json()).toEqual({ data: { changed: true } });
  });

  it("dispatches opaque provider approvals before persisting decisions", async () => {
    const fixture = await createFixture();
    const bootstrapResponse = await bootstrap(fixture);
    const owner = bootstrapResponse.json().data.owner;
    const ownerCookie = cookieHeader(
      await login(fixture, "owner", OWNER_PASSWORD),
    );
    const headers = authenticatedHeaders(ownerCookie);
    const replicant = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/replicants",
      headers,
      payload: {
        slug: "approval-agent",
        name: "Approval Agent",
        persona: "Request only synthetic approvals.",
        defaultHarness: "codex",
      },
    });
    const schedule = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/schedules",
      headers,
      payload: {
        name: "Approval dispatch fixture",
        cronExpression: "0 9 * * 1-5",
        timezone: "Etc/UTC",
        replicantId: replicant.json().data.id,
        prompt: "Request a synthetic approval.",
      },
    });
    const run = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/schedules/${schedule.json().data.id}/run-now`,
      headers,
    });
    expect(run.statusCode).toBe(202);

    const repositories = fixture.dependencies.repositories;
    const database = fixture.dependencies.database;
    if (repositories === null || database === null)
      throw new Error("Missing production services");
    const runId = run.json().data.id as string;
    const approvedId = `codex:${runId}:${"opaque".repeat(16)}` as ApprovalId;
    const failedId = `claude:${runId}:${"closed".repeat(16)}` as ApprovalId;
    const now = fixture.dependencies.now();
    const expiresAt = new Date(
      Date.parse(now) + 60_000,
    ).toISOString() as IsoTimestamp;
    database.transaction(() => {
      for (const id of [approvedId, failedId]) {
        repositories.approvals.create({
          id,
          workspaceId: owner.workspaceId,
          runId: run.json().data.id,
          requestedBy: owner.id,
          action: "Synthetic provider action",
          actionDigest: "b".repeat(64),
          payload: { synthetic: true },
          status: "pending",
          expiresAt,
          decidedBy: null,
          decidedAt: null,
          consumedAt: null,
          createdAt: now,
        });
      }
    });

    const dispatched: Array<{
      approvalId: string;
      decision: { outcome: "allow" | "deny" };
      runId: string;
    }> = [];
    fixture.dependencies.runtime = {
      workerId: "synthetic-runtime",
      started: true,
      async start() {},
      async stop() {
        return { activeRuns: 0, drained: true };
      },
      enqueue() {},
      async cancel() {
        return "not-found";
      },
      async respondToApproval(dispatchedRunId, approvalId, decision) {
        if (approvalId === failedId)
          throw new Error("Synthetic dispatch fault");
        dispatched.push({
          approvalId,
          decision,
          runId: dispatchedRunId,
        });
        return "already-dispatched";
      },
      async doctors() {
        return [];
      },
      manifests() {
        return [];
      },
      getProjection() {
        return null;
      },
    };

    const decision = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${encodeURIComponent(approvedId)}/decision`,
      headers,
      payload: { decision: "approved" },
    });
    expect(decision.statusCode).toBe(200);
    expect(decision.json().data.status).toBe("approved");
    expect(dispatched).toEqual([
      {
        approvalId: approvedId,
        decision: { outcome: "allow" },
        runId,
      },
    ]);

    const rejected = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${encodeURIComponent(failedId)}/decision`,
      headers,
      payload: { decision: "denied" },
    });
    expect(rejected.statusCode).toBe(503);
    expect(repositories.approvals.get(failedId)?.status).toBe("pending");
  });
});

describe("realtime session boundary", () => {
  it("rejects Origin, protocol, and session failures before upgrade", async () => {
    const fixture = await createFixture();
    await bootstrap(fixture);
    await expect(
      fixture.app.injectWS("/api/v1/realtime", {
        headers: { "sec-websocket-protocol": "replicantos.v1" },
      }),
    ).rejects.toThrow(/403/u);
    await expect(
      fixture.app.injectWS("/api/v1/realtime", { headers: { origin: ORIGIN } }),
    ).rejects.toThrow(/400/u);
    await expect(
      fixture.app.injectWS("/api/v1/realtime", {
        headers: { origin: ORIGIN, "sec-websocket-protocol": "replicantos.v1" },
      }),
    ).rejects.toThrow(/401/u);
  });

  it("binds a valid cookie session to a protocol-valid first frame", async () => {
    const fixture = await createFixture();
    await bootstrap(fixture);
    const cookie = cookieHeader(await login(fixture, "owner", OWNER_PASSWORD));
    const socket = await fixture.app.injectWS("/api/v1/realtime", {
      headers: {
        cookie,
        origin: ORIGIN,
        "sec-websocket-protocol": "replicantos.v1",
      },
    });
    const payload = await new Promise<unknown>((resolve, reject) => {
      socket.once("message", (message: { toString(): string }) =>
        resolve(JSON.parse(message.toString())),
      );
      socket.once("error", reject);
    });
    const event = parseRealtimeEnvelope(payload);
    expect(event).toMatchObject({ type: "presence.updated", sequence: 0 });
    socket.close();

    await fixture.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: authenticatedHeaders(cookie),
    });
    await expect(
      fixture.app.injectWS("/api/v1/realtime", {
        headers: {
          cookie,
          origin: ORIGIN,
          "sec-websocket-protocol": "replicantos.v1",
        },
      }),
    ).rejects.toThrow(/401/u);
  });
});
