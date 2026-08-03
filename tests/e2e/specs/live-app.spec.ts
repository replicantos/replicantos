import { expect, test, type Page, type Response } from "@playwright/test";
import { expectSyntheticDom } from "../support/privacy.js";

interface ApiEnvelope<T> {
  data: T;
  meta?: {
    dispatch?: {
      queuedRuns: { id: string }[];
      status: "failed" | "not-requested" | "queued";
    };
  };
}

interface RunDetail {
  events: { type: string }[];
  projection: {
    assistantText: string;
    inputTokens: number;
    outputTokens: number;
    status: string;
  } | null;
  run: { id: string; status: string };
}

async function browserApi<T>(
  page: Page,
  path: string,
  options: { body?: unknown; method?: string } = {},
): Promise<{ payload: ApiEnvelope<T>; status: number }> {
  return page.evaluate(
    async ({ body, method, path }) => {
      const response = await fetch(`/api/v1${path}`, {
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
              headers: { "content-type": "application/json" },
            }),
        credentials: "same-origin",
        method: method ?? "GET",
      });
      return {
        payload: (await response.json()) as ApiEnvelope<T>,
        status: response.status,
      };
    },
    { body: options.body, method: options.method, path },
  );
}

async function expectDispatch(
  response: Response,
  status: "failed" | "not-requested" | "queued",
  queuedRuns: number,
) {
  expect(response.status()).toBe(201);
  const payload = (await response.json()) as ApiEnvelope<unknown>;
  expect(payload.meta?.dispatch?.status).toBe(status);
  expect(payload.meta?.dispatch?.queuedRuns).toHaveLength(queuedRuns);
  return payload;
}

async function selectChannel(page: Page, slug: string) {
  const channel = page
    .locator(".channel-group")
    .getByRole("button", { name: new RegExp(slug, "iu") });
  await expect(channel).toBeVisible();
  await channel.click();
  await expect(page.getByRole("heading", { name: `#${slug}` })).toBeVisible();
}

async function waitForRunStatus(
  page: Page,
  runId: string,
  status: "awaiting-approval" | "canceled" | "running" | "succeeded",
): Promise<RunDetail> {
  let detail: RunDetail | undefined;
  await expect
    .poll(
      async () => {
        const result = await browserApi<RunDetail>(
          page,
          `/runs/${encodeURIComponent(runId)}`,
        );
        if (result.status !== 200) return `http-${result.status}`;
        detail = result.payload.data;
        return detail.run.status;
      },
      { timeout: 15_000 },
    )
    .toBe(status);
  if (!detail) throw new Error(`Run ${runId} did not produce a detail record.`);
  return detail;
}

test("first run becomes a persistent multi-user, multi-Replicant workspace", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Create the owner" }),
  ).toBeVisible({ timeout: 15_000 });

  await page.getByLabel("OWNER HANDLE").fill("operator");
  await page.getByLabel("DISPLAY NAME").fill("Operator");
  await page.getByLabel("PASSWORD", { exact: true }).fill("SyntheticDemo!42");
  await page.getByLabel("CONFIRM PASSWORD").fill("SyntheticDemo!42");
  await page.getByRole("button", { name: "CREATE LOCAL WORKSPACE" }).click();
  await expect(
    page.getByRole("heading", { name: "#no-channel" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Create channel" }).click();
  const channelDialog = page.getByRole("dialog", { name: "New channel" });
  await channelDialog.getByLabel("SLUG").fill("product");
  await channelDialog.getByLabel("NAME").fill("Product");
  await channelDialog
    .getByLabel("DESCRIPTION")
    .fill("Synthetic product collaboration channel.");
  const [productResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/v1/channels"),
    ),
    channelDialog.getByRole("button", { name: "CREATE", exact: true }).click(),
  ]);
  const productChannelId = (await productResponse.json()).data.id as string;
  await expect(page.getByRole("heading", { name: "#product" })).toBeVisible();

  await page.getByRole("button", { name: "Add Replicant" }).click();
  const replicantDialog = page.getByRole("dialog", { name: "New replicant" });
  await replicantDialog.getByLabel("SLUG").fill("atlas");
  await replicantDialog.getByLabel("NAME").fill("Atlas");
  await replicantDialog.getByLabel("HARNESS").selectOption("codex");
  await replicantDialog
    .locator('select[name="bindingChannelId"]')
    .selectOption(productChannelId);
  await replicantDialog
    .locator('select[name="bindingBehavior"]')
    .selectOption("automatic");
  await replicantDialog
    .getByLabel("PERSONA")
    .fill("A careful synthetic release coordinator.");
  const [replicantResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/v1/replicants"),
    ),
    replicantDialog
      .getByRole("button", { name: "CREATE", exact: true })
      .click(),
  ]);
  expect(replicantResponse.status()).toBe(201);
  const replicantPayload = (await replicantResponse.json()) as ApiEnvelope<{
    binding?: { behavior: string };
    id?: string;
    replicant?: { id: string };
  }>;
  const atlasId =
    replicantPayload.data.replicant?.id ?? replicantPayload.data.id ?? "";
  expect(atlasId).toMatch(/^rep_/u);
  await expect(page.getByText("codex · active")).toBeVisible();

  const automaticPrompt =
    "Turn the release requirements into an executable checklist.";
  await page.getByLabel("Message #product").fill(automaticPrompt);
  const [automaticResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response
          .url()
          .endsWith(`/api/v1/channels/${productChannelId}/messages`),
    ),
    page.getByRole("button", { name: "SEND", exact: true }).click(),
  ]);
  await expectDispatch(automaticResponse, "queued", 1);
  await expect(page.getByText(automaticPrompt, { exact: true })).toBeVisible();
  const automaticReply = `Synthetic Codex started reply: ${automaticPrompt}`;
  await expect(page.getByText(automaticReply, { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page
      .getByRole("article")
      .filter({ hasText: automaticReply })
      .getByText("Atlas", { exact: true }),
  ).toBeVisible();

  const mentionBinding = await browserApi(
    page,
    `/replicants/${atlasId}/bindings`,
    {
      body: { behavior: "mention-only", channelId: productChannelId },
      method: "POST",
    },
  );
  expect(mentionBinding.status).toBe(201);

  const unmentionedPrompt = "Atlas stays quiet without a bounded mention.";
  await page.getByLabel("Message #product").fill(unmentionedPrompt);
  const [unmentionedResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response
          .url()
          .endsWith(`/api/v1/channels/${productChannelId}/messages`),
    ),
    page.getByRole("button", { name: "SEND", exact: true }).click(),
  ]);
  await expectDispatch(unmentionedResponse, "not-requested", 0);
  await expect(
    page.getByText(unmentionedPrompt, { exact: true }),
  ).toBeVisible();

  const mentionPrompt = "@ATLAS, confirm provider-session continuity.";
  await page.getByLabel("Message #product").fill(mentionPrompt);
  const [mentionResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response
          .url()
          .endsWith(`/api/v1/channels/${productChannelId}/messages`),
    ),
    page.getByRole("button", { name: "SEND", exact: true }).click(),
  ]);
  await expectDispatch(mentionResponse, "queued", 1);
  const resumedReply = `Synthetic Codex resumed reply: ${mentionPrompt}`;
  await expect(page.getByText(resumedReply, { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  await page
    .locator(".primary-nav")
    .getByRole("button", { name: /Tasks/i })
    .click();
  await page.getByRole("button", { name: "+ NEW TASK", exact: true }).click();
  const taskDialog = page.getByRole("dialog", { name: "New task" });
  await taskDialog.getByLabel("TITLE").fill("Verify the public archive");
  await taskDialog.getByLabel("PRIORITY").selectOption("high");
  await taskDialog.getByLabel("ASSIGNEE").selectOption({ label: "Atlas" });
  await taskDialog.getByRole("button", { name: "CREATE", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Verify the public archive" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "→ ready" }).click();
  await expect(page.getByRole("button", { name: "→ active" })).toBeVisible();

  await page
    .locator(".primary-nav")
    .getByRole("button", { name: /Scheduled/i })
    .click();
  await page
    .getByRole("button", { name: "+ NEW SCHEDULE", exact: true })
    .click();
  const scheduleDialog = page.getByRole("dialog", { name: "New schedule" });
  await scheduleDialog.getByLabel("NAME").fill("Release integrity check");
  await scheduleDialog.getByLabel("REPLICANT").selectOption({ label: "Atlas" });
  await scheduleDialog.getByLabel("CHANNEL").selectOption({ label: "Product" });
  const schedulePrompt = "Verify the synthetic release archive.";
  await scheduleDialog.getByLabel("PROMPT").fill(schedulePrompt);
  await scheduleDialog
    .getByRole("button", { name: "CREATE", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Release integrity check" }),
  ).toBeVisible();
  const [runNowResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/v1\/schedules\/[^/]+\/run-now$/u.test(response.url()),
    ),
    page.getByRole("button", { name: "RUN NOW" }).click(),
  ]);
  expect(runNowResponse.status()).toBe(202);
  const runNowPayload = (await runNowResponse.json()) as ApiEnvelope<{
    id: string;
  }>;
  const scheduleRun = await waitForRunStatus(
    page,
    runNowPayload.data.id,
    "succeeded",
  );
  expect(scheduleRun.projection?.assistantText).toContain(schedulePrompt);
  expect(scheduleRun.projection?.inputTokens).toBe(34);
  expect(scheduleRun.projection?.outputTokens).toBe(13);
  expect(scheduleRun.events.map((event) => event.type)).toEqual(
    expect.arrayContaining([
      "session.bound",
      "assistant.text.delta",
      "usage.updated",
      "run.completed",
    ]),
  );
  const runHistory = await browserApi<{
    items: { id: string; status: string }[];
  }>(page, "/runs?limit=100");
  expect(runHistory.status).toBe(200);
  expect(runHistory.payload.data.items).toContainEqual(
    expect.objectContaining({ id: runNowPayload.data.id, status: "succeeded" }),
  );

  await page
    .locator(".primary-nav")
    .getByRole("button", { name: /Runs/i })
    .click();
  await expect(page.getByRole("button", { name: "RUN HISTORY" })).toBeVisible();
  await expect(
    page.getByText(runNowPayload.data.id, { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText(`Synthetic Codex started reply: ${schedulePrompt}`, {
      exact: true,
    }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("usage.updated", { exact: true })).toBeVisible();

  const manifests = await browserApi<{ items: { id: string }[] }>(
    page,
    "/harnesses",
  );
  expect(manifests.status).toBe(200);
  expect(
    manifests.payload.data.items.map((manifest) => manifest.id).sort(),
  ).toEqual(["claude", "codex", "grok", "opencode"]);
  const doctors = await browserApi<{
    items: { harnessId: string; status: string }[];
  }>(page, "/harnesses/doctor", { body: {}, method: "POST" });
  expect(doctors.status).toBe(200);
  expect(doctors.payload.data.items).toHaveLength(4);
  expect(
    doctors.payload.data.items.every((doctor) => doctor.status === "ready"),
  ).toBe(true);

  const scheduleBody = (name: string, prompt: string) => ({
    channelId: productChannelId,
    cronExpression: "0 0 * * *",
    description: null,
    effortOverride: null,
    harnessOverride: null,
    modelOverride: null,
    name,
    outcomeAssertions: {},
    prompt,
    replicantId: atlasId,
    retryPolicy: { maxAttempts: 1 },
    status: "paused",
    taskId: null,
    timezone: "UTC",
  });

  const cancelSchedule = await browserApi<{ id: string }>(page, "/schedules", {
    body: scheduleBody(
      "Synthetic cancellation check",
      "[await-cancel] Wait for an explicit cancellation.",
    ),
    method: "POST",
  });
  expect(cancelSchedule.status).toBe(201);
  const cancelRun = await browserApi<{ id: string }>(
    page,
    `/schedules/${cancelSchedule.payload.data.id}/run-now`,
    { body: {}, method: "POST" },
  );
  expect(cancelRun.status).toBe(202);
  await waitForRunStatus(page, cancelRun.payload.data.id, "running");
  const cancellation = await browserApi<{
    cancellation: string;
    runId: string;
  }>(page, `/runs/${cancelRun.payload.data.id}/cancel`, {
    body: {},
    method: "POST",
  });
  expect(cancellation.status).toBe(202);
  expect(cancellation.payload.data).toEqual({
    cancellation: "recorded",
    runId: cancelRun.payload.data.id,
  });
  await waitForRunStatus(page, cancelRun.payload.data.id, "canceled");

  const approvalSchedule = await browserApi<{ id: string }>(
    page,
    "/schedules",
    {
      body: scheduleBody(
        "Synthetic approval check",
        "[await-approval] Wait for an explicit approval.",
      ),
      method: "POST",
    },
  );
  expect(approvalSchedule.status).toBe(201);
  const approvalRun = await browserApi<{ id: string }>(
    page,
    `/schedules/${approvalSchedule.payload.data.id}/run-now`,
    { body: {}, method: "POST" },
  );
  expect(approvalRun.status).toBe(202);
  await waitForRunStatus(
    page,
    approvalRun.payload.data.id,
    "awaiting-approval",
  );
  let approvalId = "";
  await expect
    .poll(async () => {
      const approvals = await browserApi<{
        items: { id: string; runId: string; status: string }[];
      }>(page, "/approvals?limit=100");
      const approval = approvals.payload.data.items.find(
        (item) => item.runId === approvalRun.payload.data.id,
      );
      approvalId = approval?.id ?? "";
      return approval?.status ?? "missing";
    })
    .toBe("pending");
  const approvalDecision = await browserApi(
    page,
    `/approvals/${encodeURIComponent(approvalId)}/decision`,
    { body: { decision: "approved" }, method: "POST" },
  );
  expect(approvalDecision.status).toBe(200);
  const approvedRun = await waitForRunStatus(
    page,
    approvalRun.payload.data.id,
    "succeeded",
  );
  expect(approvedRun.projection?.assistantText).toBe(
    "Synthetic approval accepted.",
  );

  await page
    .locator(".primary-nav")
    .getByRole("button", { name: /Files/i })
    .click();
  await page.getByLabel("New file name").fill("release-plan.md");
  await page.getByRole("button", { name: "+ FILE", exact: true }).click();
  const workspaceEditor = page.getByLabel("Edit release-plan.md");
  await expect(workspaceEditor).toBeVisible();
  await workspaceEditor.fill(
    "# Synthetic release plan\n\n- Verify the clean archive.",
  );
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith("/api/v1/files/text"),
    ),
    page.getByRole("button", { name: "SAVE", exact: true }).click(),
  ]);

  await page
    .getByRole("group", { name: "Approved file root" })
    .getByRole("button", { name: "library" })
    .click();
  await page.getByLabel("New file name").fill("public-release.md");
  await page.getByRole("button", { name: "+ FILE", exact: true }).click();
  const libraryEditor = page.getByLabel("Edit public-release.md");
  await expect(libraryEditor).toBeVisible();
  await libraryEditor.fill(
    "# Public release\n\nEvery fixture in this workspace is synthetic.",
  );
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith("/api/v1/files/text"),
    ),
    page.getByRole("button", { name: "SAVE", exact: true }).click(),
  ]);

  await page
    .locator(".primary-nav")
    .getByRole("button", { name: /Library/i })
    .click();
  await expect(page.getByLabel("APPROVED LIBRARY FILE")).toHaveValue(
    "public-release.md",
  );
  await page.getByRole("button", { name: "INDEX / REINDEX" }).click();
  await expect(
    page.getByRole("heading", { name: "public-release.md" }),
  ).toBeVisible();
  await expect(
    page.getByText("Every fixture in this workspace is synthetic."),
  ).toBeVisible();

  await page
    .locator(".primary-nav")
    .getByRole("button", { name: /Database/i })
    .click();
  await expect(page.getByText("SAFE TABLES").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /sessions/i })).toHaveCount(0);
  await page.getByRole("button", { name: /messages/i }).click();
  await expect(
    page.getByRole("cell", { name: "[masked]" }).first(),
  ).toBeVisible();

  await page
    .locator(".primary-nav")
    .getByRole("button", { name: /Chat/i })
    .click();
  await page.getByRole("button", { name: "Create channel" }).click();
  const privateChannelDialog = page.getByRole("dialog", {
    name: "New channel",
  });
  await privateChannelDialog.getByLabel("SLUG").fill("operations");
  await privateChannelDialog.getByLabel("NAME").fill("Operations");
  await privateChannelDialog
    .getByLabel("DESCRIPTION")
    .fill("Owner-only synthetic operations.");
  await privateChannelDialog
    .getByRole("button", { name: "CREATE", exact: true })
    .click();

  await page
    .locator(".primary-nav")
    .getByRole("button", { name: /Settings/i })
    .click();
  await page.getByRole("button", { name: "+ ADD USER", exact: true }).click();
  const userDialog = page.getByRole("dialog", { name: "New user" });
  await userDialog.getByLabel("HANDLE").fill("analyst");
  await userDialog.getByLabel("DISPLAY NAME").fill("Analyst");
  await userDialog.getByLabel("INITIAL PASSWORD").fill("SyntheticMember!42");
  const [createUserResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/v1/users"),
    ),
    userDialog.getByRole("button", { name: "CREATE", exact: true }).click(),
  ]);
  expect(createUserResponse.ok()).toBe(true);
  await expect(
    page.getByRole("button", { name: "REVIEW Analyst" }),
  ).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "REVIEW Operator" }).click();
  await expect(
    page.getByRole("button", { name: "CURRENT SESSION" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "REVIEW Analyst" }).click();
  await page.getByRole("button", { name: "SUSPEND USER" }).click();
  await expect(
    page.getByRole("button", { name: "ACTIVATE USER" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "ACTIVATE USER" }).click();
  await expect(
    page.getByRole("button", { name: "SUSPEND USER" }),
  ).toBeVisible();

  for (const permission of ["channel:read", "channel:write"]) {
    await page.getByLabel("GRANT PERMISSION").selectOption(permission);
    await page.getByLabel("RESOURCE ID (OPTIONAL)").fill(productChannelId);
    await page
      .getByLabel("REASON")
      .fill(`Allow Analyst ${permission} in Product.`);
    await page.getByRole("button", { name: "CREATE GRANT" }).click();
    await expect(page.getByText("Allow grant created.")).toBeVisible();
    await expect(
      page.getByLabel("Active grants").getByText(permission, { exact: true }),
    ).toBeVisible();
  }

  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByLabel("TIMEZONE").fill("America/Chicago");
  await page.getByLabel("THEME").selectOption("dark");
  await page.getByLabel("Terminal execution").check();
  await expect(page.getByLabel("Telemetry")).not.toBeChecked();
  await expect(page.getByLabel("Telemetry")).toBeDisabled();
  await expect(
    page.getByText(
      "This build has no telemetry pipeline or external destination.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "SAVE WORKSPACE SETTINGS" }).click();
  await expect(page.getByText("Workspace settings saved.")).toBeVisible();

  await page.getByRole("button", { name: "Security", exact: true }).click();
  await expect(page.getByText("CURRENT SESSION EXPIRES")).toBeVisible();
  await expect(
    page.getByText(/Owner-only actions stay owner-only/i),
  ).toBeVisible();
  await expect(
    page.getByText("workspace.setting.updated").first(),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Harness runtimes", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Harness runtimes" }),
  ).toBeVisible();

  await expectSyntheticDom(page);
  await page.reload();
  await selectChannel(page, "product");
  await expect(page.getByText(automaticPrompt, { exact: true })).toBeVisible();
  await expect(page.getByText(automaticReply, { exact: true })).toBeVisible();
  await expect(
    page.getByText(unmentionedPrompt, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(resumedReply, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(
    page.getByRole("heading", { name: "Enter the control plane" }),
  ).toBeVisible();

  await page.getByLabel("HANDLE").fill("analyst");
  await page.getByLabel("PASSWORD").fill("SyntheticMember!42");
  await page.getByRole("button", { name: "SIGN IN" }).click();
  await expect(page.getByRole("heading", { name: "#product" })).toBeVisible();
  await expect(
    page.locator(".channel-group").getByRole("button", { name: /operations/i }),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      "Turn the release requirements into an executable checklist.",
      { exact: true },
    ),
  ).toBeVisible();

  const analystPrompt =
    "@Atlas Analyst can contribute only to the authorized Product channel.";
  await page.getByLabel("Message #product").fill(analystPrompt);
  const [analystMessageResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response
          .url()
          .endsWith(`/api/v1/channels/${productChannelId}/messages`),
    ),
    page.getByRole("button", { name: "SEND", exact: true }).click(),
  ]);
  await expectDispatch(analystMessageResponse, "not-requested", 0);
  await expect(page.getByText(analystPrompt, { exact: true })).toBeVisible();
  await expect(
    page.locator(".primary-nav").getByRole("button", { name: /Database/i }),
  ).toHaveCount(0);
  await expect(
    page.locator(".primary-nav").getByRole("button", { name: /Settings/i }),
  ).toHaveCount(0);

  const deniedBoundaries = await page.evaluate(async () => {
    const database = await fetch("/api/v1/database/tables");
    const settings = await fetch("/api/v1/settings/telemetry.enabled", {
      body: JSON.stringify({ value: true }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    const users = await fetch("/api/v1/users?limit=200");
    const userBody = (await users.json()) as {
      data: { items: { handle: string }[] };
    };
    return {
      database: database.status,
      settings: settings.status,
      users: userBody.data.items.map((user) => user.handle),
    };
  });
  expect(deniedBoundaries).toEqual({
    database: 403,
    settings: 403,
    users: ["analyst"],
  });
});
