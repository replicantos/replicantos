import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Approval, Replicant, Run, RunDetail } from "./api.js";
import { LiveRuns } from "./LiveRuns.js";

const run: Run = {
  id: "run_public01",
  workspaceId: "wsp_public01",
  replicantId: "rep_atlas01",
  channelId: "chn_product01",
  taskId: null,
  scheduleId: null,
  parentRunId: null,
  trigger: "message",
  status: "running",
  harness: "codex",
  model: null,
  effort: null,
  requestedBy: "usr_owner01",
  createdAt: "2030-01-01T00:00:00.000Z",
  startedAt: "2030-01-01T00:00:01.000Z",
  finishedAt: null,
  inputTokens: null,
  outputTokens: null,
  costMicros: null,
  errorCode: null,
  errorMessage: null,
};

const detail: RunDetail = {
  run,
  projection: {
    runId: run.id,
    status: "running",
    inputTokens: 120,
    outputTokens: 34,
    cachedInputTokens: 80,
    costMicros: 12_400,
    assistantText: "Persisted synthetic assistant output.",
    cancellationRequestedAt: null,
  },
  events: [
    {
      id: "evt_public01",
      runId: run.id,
      sequence: 1,
      type: "run.state",
      payload: { status: "running" },
      createdAt: "2030-01-01T00:00:01.000Z",
    },
  ],
};

const approval: Approval = {
  id: `codex:${run.id}:opaque-request`,
  workspaceId: run.workspaceId,
  runId: run.id,
  requestedBy: null,
  action: "Write synthetic release evidence",
  actionDigest: "a".repeat(64),
  payload: {},
  status: "pending",
  expiresAt: "2030-01-01T01:00:00.000Z",
  decidedBy: null,
  decidedAt: null,
  consumedAt: null,
  createdAt: "2030-01-01T00:00:02.000Z",
};

const replicant: Replicant = {
  id: run.replicantId,
  workspaceId: run.workspaceId,
  slug: "atlas",
  name: "Atlas",
  description: null,
  persona: "Synthetic test Replicant.",
  defaultHarness: "codex",
  defaultModel: null,
  status: "active",
};

function response(data: unknown, status = 200): Response {
  return {
    json: async () => ({ data }),
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("live run operations", () => {
  it("shows durable detail and dispatches cancellation and approval decisions", async () => {
    const requests: { body: unknown; method: string; url: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        requests.push({
          body: init?.body ? JSON.parse(String(init.body)) : null,
          method,
          url,
        });
        if (method === "GET" && url.endsWith(`/runs/${run.id}`)) {
          return response(detail);
        }
        if (method === "GET" && url.includes("/approvals?")) {
          return response({ items: [approval] });
        }
        if (method === "POST" && url.endsWith(`/runs/${run.id}/cancel`)) {
          return response({ cancellation: "recorded", runId: run.id }, 202);
        }
        return response({});
      }),
    );
    const onRunsChanged = vi.fn(async () => undefined);
    const onFailure = vi.fn();

    render(
      <LiveRuns
        canManage
        onFailure={onFailure}
        onRunsChanged={onRunsChanged}
        replicants={[replicant]}
        runs={[run]}
      />,
    );

    expect(
      await screen.findByText("Persisted synthetic assistant output."),
    ).toBeInTheDocument();
    expect(await screen.findByText(approval.action)).toBeInTheDocument();
    expect(screen.queryByText(/session/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "CANCEL RUN" }));
    expect(
      await screen.findByText(/Cancellation requested/i),
    ).toBeInTheDocument();
    expect(
      requests.find((request) => request.url.endsWith(`/${run.id}/cancel`)),
    ).toMatchObject({ body: {}, method: "POST" });

    fireEvent.click(screen.getByRole("button", { name: "ALLOW" }));
    expect(
      await screen.findByText("Approval allowed and dispatched."),
    ).toBeInTheDocument();
    expect(
      requests.find((request) =>
        request.url.includes(
          `/approvals/${encodeURIComponent(approval.id)}/decision`,
        ),
      ),
    ).toMatchObject({
      body: { decision: "approved" },
      method: "POST",
    });
    expect(onRunsChanged).toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("does not expose owner cancellation or approval controls to a member", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith(`/runs/${run.id}`)
        ? response(detail)
        : response({ items: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <LiveRuns
        canManage={false}
        onFailure={vi.fn()}
        onRunsChanged={async () => undefined}
        replicants={[replicant]}
        runs={[run]}
      />,
    );

    await screen.findByText("Persisted synthetic assistant output.");
    expect(
      screen.queryByRole("button", { name: "CANCEL RUN" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Pending approvals"),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/approvals"),
        ),
      ).toBe(false),
    );
  });
});
