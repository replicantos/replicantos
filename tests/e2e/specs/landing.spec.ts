import { expect, test } from "@playwright/test";

test("landing page explains the system, harnesses, and security on desktop and mobile", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:44173/");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: /A home for your Replicants/i,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Bring your own sub/i }),
  ).toBeVisible();

  for (const [harness, status] of [
    ["Codex", "Stable"],
    ["Claude Agent SDK", "Stable · Optional"],
    ["OpenCode", "Beta"],
    ["Grok Build", "Beta"],
  ] as const) {
    const card = page.locator(".harness-card", {
      has: page.getByRole("heading", { level: 3, name: harness, exact: true }),
    });
    await expect(card).toBeVisible();
    await expect(card.locator(".status")).toHaveText(status);
  }

  for (const screenshot of await page.locator("main img").all()) {
    await screenshot.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        screenshot.evaluate(
          (image) => image instanceof HTMLImageElement && image.naturalWidth,
        ),
      )
      .toBeGreaterThan(0);
  }

  await page.getByRole("link", { name: "Install from source" }).first().click();
  await expect(page).toHaveURL(/#install$/u);
  await expect(
    page.getByRole("heading", {
      name: /If you don't like something, fork it/i,
    }),
  ).toBeVisible();
  await expect(page.getByText("pnpm run doctor")).toBeVisible();

  await expect(
    page.getByRole("heading", { name: /Locked down by default/i }),
  ).toBeAttached();
  await expect(
    page.getByRole("heading", { level: 3, name: "No telemetry" }),
  ).toBeAttached();

  const sourceLink = page.getByRole("link", { name: /Take our code/i });
  await expect(sourceLink).toHaveAttribute(
    "href",
    /^https:\/\/github\.com\/[a-z0-9-]+\/[a-z0-9-]+$/iu,
  );

  await page.setViewportSize({ height: 844, width: 390 });
  const mobileNavigation = page.locator("[data-mobile-navigation]");
  await expect(mobileNavigation).toBeVisible();
  await mobileNavigation.locator("summary").click();
  await expect(
    mobileNavigation.getByRole("link", { name: "Docs" }),
  ).toBeVisible();
  await mobileNavigation.getByRole("link", { name: "Docs" }).click();
  await expect(page).toHaveURL(/\/docs\/$/u);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: /One place for agents.*to keep working/i,
    }),
  ).toBeVisible();
  await expect(page.getByText(/v0\.1\.0 is released/i)).toBeVisible();
  await expect(page.getByText(/OWNER WAIVER RECORDED/i)).toBeVisible();
});
