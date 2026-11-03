import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { expectSyntheticDom } from "../support/privacy.js";

test.skip(
  process.env.REPLICANTOS_CAPTURE_SCREENSHOTS !== "1",
  "intentional capture only",
);

const outputDirectory = resolve(
  new URL("../../../artifacts/screenshots", import.meta.url).pathname,
);

test("capture the public landing page on desktop and mobile", async ({
  page,
}) => {
  await mkdir(outputDirectory, { recursive: true });
  await page.setViewportSize({ height: 1_000, width: 1_600 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: /A home for your Replicants/i,
    }),
  ).toBeVisible();
  await expectSyntheticDom(page);
  await page.addStyleTag({
    content:
      "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }",
  });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: resolve(outputDirectory, "landing-desktop.png"),
    scale: "css",
  });

  await page.setViewportSize({ height: 844, width: 390 });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: resolve(outputDirectory, "landing-mobile.png"),
    scale: "css",
  });

  await page.setViewportSize({ height: 1_000, width: 1_600 });
  await page.goto("/docs/");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: /One place for agents.*to keep working/i,
    }),
  ).toBeVisible();
  await expectSyntheticDom(page);
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: resolve(outputDirectory, "docs-desktop.png"),
    scale: "css",
  });

  await page.setViewportSize({ height: 844, width: 390 });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: resolve(outputDirectory, "docs-mobile.png"),
    scale: "css",
  });
});
