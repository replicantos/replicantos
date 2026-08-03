import { expect, test } from "@playwright/test";

test("landing page explains the system, harnesses, and security on desktop and mobile", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:44173/");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: /Your AI agents.*One operating system/i,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: /One control plane.*Four ways to think/i,
    }),
  ).toBeVisible();

  for (const harness of [
    "Codex",
    "Claude Agent SDK",
    "OpenCode",
    "Grok Build",
  ]) {
    await expect(
      page.getByRole("heading", { level: 3, name: harness, exact: true }),
    ).toBeVisible();
  }

  await page
    .getByRole("link", { name: "Security", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", {
      name: /Power tools stay.*behind the boundary/i,
    }),
  ).toBeVisible();
  await expect(page.getByText("TELEMETRY").first()).toBeVisible();
  await expect(page.getByText("DISABLED").first()).toBeVisible();

  const sourceLink = page.getByRole("link", { name: /Explore on GitHub/i });
  await expect(sourceLink).toHaveAttribute(
    "href",
    /^https:\/\/github\.com\/[a-z0-9-]+\/[a-z0-9-]+$/iu,
  );

  await page.setViewportSize({ height: 844, width: 390 });
  const mobileNavigation = page.locator("[data-mobile-navigation]");
  await expect(mobileNavigation).toBeVisible();
  await mobileNavigation.locator("summary").click();
  await expect(
    mobileNavigation.getByRole("link", { name: "Documentation" }),
  ).toBeVisible();
  await mobileNavigation.getByRole("link", { name: "Documentation" }).click();
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
