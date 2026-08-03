import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Actor, DoctorResult, HarnessManifest, Settings } from "./api.js";
import { LiveSettings } from "./LiveSettings.js";

const owner: Actor = {
  id: "usr_owner01",
  workspaceId: "wsp_public01",
  kind: "human",
  handle: "operator",
  displayName: "Operator",
  role: "owner",
  status: "active",
};

const analyst: Actor = {
  id: "usr_analyst01",
  workspaceId: owner.workspaceId,
  kind: "human",
  handle: "analyst",
  displayName: "Analyst",
  role: "member",
  status: "active",
};

const settings: Settings = {
  "ui.theme": null,
  "ui.timezone": null,
  "telemetry.enabled": false,
  "terminal.enabled": false,
};

const manifest: HarnessManifest = {
  id: "codex",
  displayName: "Codex",
  description: "Synthetic Codex runtime adapter.",
  maturity: "stable",
  transport: "app-server-stdio",
  credentials: { mode: "host-native", storedByReplicantOS: false },
  capabilities: {
    approvals: true,
    cancellation: true,
    fileChanges: true,
    images: true,
    modelSelection: true,
    reasoningSummaries: true,
    sessionResume: true,
    streamingText: true,
    toolEvents: true,
    usage: true,
  },
};

const diagnostic: DoctorResult = {
  harnessId: "codex",
  status: "ready",
  checkedAt: "2030-01-01T00:00:00.000Z",
  checks: [
    {
      id: "codex-cli",
      status: "pass",
      message: "Codex CLI is available.",
    },
  ],
};

function response(data: unknown): Response {
  return {
    json: async () => ({ data }),
    ok: true,
    status: 200,
  } as Response;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("live Settings", () => {
  it("reviews actors, protects the current actor, and creates resource grants", async () => {
    const requests: { body: unknown; method: string; url: string }[] = [];
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        requests.push({
          body: init?.body ? JSON.parse(String(init.body)) : null,
          method,
          url,
        });
        if (method === "GET" && url.endsWith("/grants")) {
          return response({ items: [] });
        }
        return response({});
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn(async () => undefined);
    const onFailure = vi.fn();

    render(
      <LiveSettings
        actor={owner}
        onChanged={onChanged}
        onCreateUser={vi.fn()}
        onFailure={onFailure}
        sessionExpiresAt="2030-01-01T00:00:00.000Z"
        settings={settings}
        users={[owner, analyst]}
      />,
    );

    expect(
      screen.getByRole("button", { name: "CURRENT SESSION" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "REVIEW Analyst" }));
    await screen.findByText("No active explicit grants.");

    fireEvent.change(screen.getByLabelText("GRANT PERMISSION"), {
      target: { value: "channel:write" },
    });
    fireEvent.change(screen.getByLabelText("RESOURCE ID (OPTIONAL)"), {
      target: { value: "chn_product01" },
    });
    fireEvent.change(screen.getByLabelText("REASON"), {
      target: { value: "Contribute to Product" },
    });
    fireEvent.click(screen.getByRole("button", { name: "CREATE GRANT" }));

    await screen.findByText("Allow grant created.");
    expect(
      requests.find(
        (request) =>
          request.method === "POST" && request.url.endsWith("/grants"),
      )?.body,
    ).toMatchObject({
      effect: "allow",
      permission: "channel:write",
      reason: "Contribute to Product",
      resourceId: "chn_product01",
      subjectType: "user",
      subjectUserId: analyst.id,
    });

    fireEvent.click(screen.getByRole("button", { name: "SUSPEND USER" }));
    await waitFor(() =>
      expect(
        requests.some(
          (request) =>
            request.method === "PATCH" &&
            request.url.endsWith(`/users/${analyst.id}/status`) &&
            JSON.stringify(request.body) ===
              JSON.stringify({ status: "suspended" }),
        ),
      ).toBe(true),
    );
    expect(onChanged).toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("persists workspace settings and shows honest runtime and security state", async () => {
    const requests: { body: unknown; method: string; url: string }[] = [];
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        requests.push({
          body: init?.body ? JSON.parse(String(init.body)) : null,
          method,
          url,
        });
        if (url.includes("/audit?")) {
          return response({
            items: [
              {
                action: "workspace.setting.updated",
                actorKind: "user",
                actorUserId: owner.id,
                createdAt: "2029-01-01T00:00:00.000Z",
                detail: { key: "ui.timezone" },
                id: "aud_public01",
                requestId: "request-1",
                resourceId: owner.workspaceId,
                resourceType: "workspace",
                workspaceId: owner.workspaceId,
              },
            ],
          });
        }
        if (method === "GET" && url.endsWith("/harnesses")) {
          return response({ items: [manifest] });
        }
        if (method === "POST" && url.endsWith("/harnesses/doctor")) {
          return response({ items: [diagnostic] });
        }
        if (url.endsWith("/grants")) return response({ items: [] });
        return response({});
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <LiveSettings
        actor={owner}
        onChanged={async () => undefined}
        onCreateUser={vi.fn()}
        onFailure={vi.fn()}
        sessionExpiresAt="2030-01-01T00:00:00.000Z"
        settings={settings}
        users={[owner]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    expect(screen.getByLabelText("Telemetry")).not.toBeChecked();
    expect(screen.getByLabelText("Telemetry")).toBeDisabled();
    expect(
      screen.getByText(
        "This build has no telemetry pipeline or external destination.",
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("TIMEZONE"), {
      target: { value: "America/Chicago" },
    });
    fireEvent.change(screen.getByLabelText("THEME"), {
      target: { value: "dark" },
    });
    fireEvent.click(screen.getByLabelText("Terminal execution"));
    fireEvent.click(
      screen.getByRole("button", { name: "SAVE WORKSPACE SETTINGS" }),
    );

    await screen.findByText("Workspace settings saved.");
    const settingRequests = requests.filter(
      (request) =>
        request.method === "PUT" && request.url.includes("/settings/"),
    );
    expect(settingRequests).toHaveLength(4);
    expect(settingRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: { value: "America/Chicago" },
          url: "/api/v1/settings/ui.timezone",
        }),
        expect.objectContaining({
          body: { value: false },
          url: "/api/v1/settings/telemetry.enabled",
        }),
      ]),
    );

    fireEvent.click(screen.getByRole("button", { name: "Harness runtimes" }));
    expect(await screen.findByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("NOT CHECKED")).toBeInTheDocument();
    expect(
      requests.some((request) => request.url.endsWith("/harnesses/doctor")),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "RUN DIAGNOSTICS" }));
    expect(
      await screen.findByText("Codex CLI is available."),
    ).toBeInTheDocument();
    expect(
      requests.find((request) => request.url.endsWith("/harnesses/doctor")),
    ).toMatchObject({ body: {}, method: "POST" });

    fireEvent.click(screen.getByRole("button", { name: "Security" }));
    expect(screen.getByText("2030-01-01T00:00:00.000Z")).toBeInTheDocument();
    expect(
      screen.getByText(/Owner-only actions stay owner-only/i),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("workspace.setting.updated"),
    ).toBeInTheDocument();
  });
});
