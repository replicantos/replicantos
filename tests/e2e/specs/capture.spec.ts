import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { expectSyntheticDom } from "../support/privacy.js";

test.skip(
  process.env.REPLICANTOS_CAPTURE_SCREENSHOTS !== "1",
  "intentional capture only",
);

const outputDirectory = resolve(
  new URL("../../../artifacts/screenshots", import.meta.url).pathname,
);

async function prepare(page: Page) {
  await page.goto("/?demo=1");
  await expect(page.getByRole("heading", { name: "#product" })).toBeVisible();
  await page.addStyleTag({
    content:
      "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }",
  });
  await expectSyntheticDom(page);
}

async function capture(page: Page, name: string) {
  await expectSyntheticDom(page);
  await page.screenshot({
    animations: "disabled",
    path: resolve(outputDirectory, name),
    scale: "css",
  });
}

async function openScreen(page: Page, name: string) {
  await page
    .locator(".primary-nav")
    .getByRole("button", { name: new RegExp(`\\b${name}\\b`, "i") })
    .click();
}

test("capture the ten launch frames from the isolated demo", async ({
  browser,
}) => {
  await mkdir(outputDirectory, { recursive: true });
  const context = await browser.newContext({
    colorScheme: "dark",
    locale: "en-US",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    timezoneId: "UTC",
    viewport: { height: 900, width: 1_600 },
  });
  const page = await context.newPage();
  await prepare(page);
  await capture(page, "01-chat-continuity.png");

  await openScreen(page, "Settings");
  await capture(page, "02-four-harnesses.png");

  await openScreen(page, "Runs");
  await capture(page, "03-run-control.png");

  await openScreen(page, "Scheduled");
  await capture(page, "04-scheduled-work.png");

  await openScreen(page, "Settings");
  await page
    .getByRole("button", { name: "Users & access", exact: true })
    .click();
  await capture(page, "05-users-access.png");

  await openScreen(page, "Tasks");
  await capture(page, "06-shared-tasks.png");
  await openScreen(page, "Library");
  await capture(page, "07-document-library.png");
  await openScreen(page, "Files");
  await capture(page, "08-safe-files.png");
  await openScreen(page, "Database");
  await capture(page, "09-inspectable-database.png");

  await openScreen(page, "Chat");
  await page.setViewportSize({ height: 844, width: 390 });
  await capture(page, "10-mobile-pwa.png");
  await context.close();
});
