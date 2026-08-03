import { expect, test } from "@playwright/test";
import { expectSyntheticDom } from "../support/privacy.js";

test.beforeEach(async ({ page }) => {
  await page.goto("/?demo=1");
  await expect(page.getByRole("heading", { name: "#product" })).toBeVisible();
});

test("desktop rail icons are centered in their controls", async ({ page }) => {
  const railButtons = page.locator(".primary-nav .nav-item");
  await expect(railButtons).toHaveCount(8);

  const offsets = await railButtons.evaluateAll((buttons) =>
    buttons.map((button) => {
      const icon = button.querySelector("svg");
      if (!icon) throw new Error("Rail button is missing its icon.");
      const control = button.getBoundingClientRect();
      const glyph = icon.getBoundingClientRect();
      return {
        x: glyph.left + glyph.width / 2 - (control.left + control.width / 2),
        y: glyph.top + glyph.height / 2 - (control.top + control.height / 2),
      };
    }),
  );

  for (const offset of offsets) {
    expect(Math.abs(offset.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(offset.y)).toBeLessThanOrEqual(0.5);
  }
});

test("all required product surfaces are reachable", async ({ page }) => {
  const expected = [
    ["Tasks", "Tasks"],
    ["Scheduled", "Scheduled"],
    ["Library", "Library"],
    ["Files", "Files"],
    ["Database", "Database"],
    ["Settings", "Settings"],
  ] as const;

  for (const [button, heading] of expected) {
    await page
      .locator(".primary-nav")
      .getByRole("button", { name: new RegExp(`\\b${button}\\b`, "i") })
      .click();
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
  }
});

test("database viewer exposes only the explicit safe-table surface", async ({
  page,
}) => {
  await page
    .locator(".primary-nav")
    .getByRole("button", { name: /\bDatabase\b/i })
    .click();
  await expect(page.getByText("SAFE TABLES", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/Credential and session tables are excluded/i),
  ).toBeVisible();
  await expect(
    page.locator(".table-list").getByRole("button", { name: /credential/i }),
  ).toHaveCount(0);
});

test("rendered demo contains no workstation path, credential, or non-synthetic email", async ({
  page,
}) => {
  await expectSyntheticDom(page);
  for (const screen of [
    "Tasks",
    "Scheduled",
    "Library",
    "Files",
    "Database",
    "Settings",
  ]) {
    await page
      .locator(".primary-nav")
      .getByRole("button", { name: new RegExp(`\\b${screen}\\b`, "i") })
      .click();
    await expectSyntheticDom(page);
  }
});

test("users and access explains server-side enforcement", async ({ page }) => {
  await page
    .locator(".primary-nav")
    .getByRole("button", { name: /\bSettings\b/i })
    .click();
  await page
    .getByRole("button", { name: "Users & access", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Users & access" }),
  ).toBeVisible();
  await expect(page.getByText(/checked server-side/i)).toBeVisible();
});

test("the app publishes an installable static PWA shell without caching API routes", async ({
  page,
}) => {
  const manifest = await page.evaluate(async () => {
    const response = await fetch("/manifest.webmanifest");
    if (!response.ok) throw new Error(`manifest returned ${response.status}`);
    return response.json() as Promise<{
      display: string;
      icons: Array<{ sizes: string }>;
      start_url: string;
    }>;
  });
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/");
  expect(manifest.icons.map((icon) => icon.sizes)).toEqual(
    expect.arrayContaining(["192x192", "512x512", "any"]),
  );

  const workerSource = await page.evaluate(async () => {
    const response = await fetch("/sw.js");
    if (!response.ok)
      throw new Error(`service worker returned ${response.status}`);
    return response.text();
  });
  expect(workerSource).toContain('url.pathname.startsWith("/api/")');
});

test("mobile navigation keeps every essential module and channel switching reachable", async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  const mobileNavigation = page.getByRole("navigation", {
    name: "Mobile product areas",
  });
  await mobileNavigation.getByRole("button", { name: "Database" }).click();
  await expect(
    page.getByRole("heading", { name: "Database", exact: true }),
  ).toBeVisible();
  await mobileNavigation.getByRole("button", { name: "Settings" }).click();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await mobileNavigation.getByRole("button", { name: "Chat" }).click();
  await page.getByLabel("Select channel").selectOption("operations");
  await expect(
    page.getByRole("heading", { name: "#operations" }),
  ).toBeVisible();
});
