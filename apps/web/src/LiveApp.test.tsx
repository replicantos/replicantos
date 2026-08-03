import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CreateDialog,
  createBoundReplicant,
  type ReplicantDialogSubmission,
  startMessagePolling,
} from "./LiveApp.js";
import type { Channel, Replicant } from "./api.js";

const product: Channel = {
  id: "chn_product01",
  workspaceId: "wsp_public01",
  slug: "product",
  name: "Product",
  description: "Synthetic product work.",
  kind: "standard",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function response(data: unknown): Response {
  return {
    json: async () => ({ data }),
    ok: true,
    status: 200,
  } as Response;
}

describe("live Replicant creation", () => {
  it("requires a channel and submits the selected binding behavior", () => {
    const onSubmit = vi.fn();
    render(
      <CreateDialog
        busy={false}
        channels={[product]}
        kind="replicant"
        onClose={vi.fn()}
        onSubmit={onSubmit}
        replicants={[]}
      />,
    );

    fireEvent.change(screen.getByLabelText("SLUG"), {
      target: { value: "atlas" },
    });
    fireEvent.change(screen.getByLabelText("NAME"), {
      target: { value: "Atlas" },
    });
    fireEvent.change(screen.getByLabelText("HARNESS"), {
      target: { value: "claude" },
    });
    fireEvent.change(screen.getByLabelText("CHANNEL"), {
      target: { value: product.id },
    });
    fireEvent.change(screen.getByLabelText("CHANNEL BEHAVIOR"), {
      target: { value: "automatic" },
    });
    fireEvent.change(screen.getByLabelText("PERSONA"), {
      target: { value: "Coordinate synthetic release work." },
    });
    fireEvent.click(screen.getByRole("button", { name: "CREATE" }));

    expect(onSubmit).toHaveBeenCalledWith({
      binding: { behavior: "automatic", channelId: product.id },
      replicant: {
        defaultHarness: "claude",
        defaultModel: null,
        description: null,
        name: "Atlas",
        persona: "Coordinate synthetic release work.",
        slug: "atlas",
      },
    } satisfies ReplicantDialogSubmission);
  });

  it("does not offer an unbound Replicant when no channel exists", () => {
    render(
      <CreateDialog
        busy={false}
        channels={[]}
        kind="replicant"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        replicants={[]}
      />,
    );

    expect(screen.getByText("Create a channel first")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "CREATE" })).toBeDisabled();
  });

  it("persists the Replicant before its selected channel binding", async () => {
    const submission: ReplicantDialogSubmission = {
      binding: { behavior: "mention-only", channelId: product.id },
      replicant: {
        defaultHarness: "codex",
        defaultModel: null,
        description: null,
        name: "Atlas",
        persona: "Coordinate synthetic release work.",
        slug: "atlas",
      },
    };
    const created: Replicant = {
      ...submission.replicant,
      id: "rep_atlas01",
      workspaceId: product.workspaceId,
      status: "active",
    };
    const requests: { body: unknown; method: string; url: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          body: init?.body ? JSON.parse(String(init.body)) : null,
          method: init?.method ?? "GET",
          url: String(input),
        });
        return response(requests.length === 1 ? created : {});
      }),
    );

    await expect(createBoundReplicant(submission)).resolves.toEqual(created);
    expect(requests).toEqual([
      {
        body: submission.replicant,
        method: "POST",
        url: "/api/v1/replicants",
      },
      {
        body: submission.binding,
        method: "POST",
        url: `/api/v1/replicants/${created.id}/bindings`,
      },
    ]);
  });

  it("polls persisted messages on a bounded interval", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => undefined);
    const stop = startMessagePolling(refresh, 100);

    await vi.advanceTimersByTimeAsync(250);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
