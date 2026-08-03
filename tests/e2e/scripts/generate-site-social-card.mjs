import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const assetDirectory = resolve(
  currentDirectory,
  "../../../apps/site/src/assets",
);
const source = await readFile(
  resolve(assetDirectory, "social-card.svg"),
  "utf8",
);
const browser = await chromium.launch();

try {
  const page = await browser.newPage({
    deviceScaleFactor: 1,
    viewport: { height: 630, width: 1_200 },
  });
  await page.setContent(`
    <!doctype html>
    <html>
      <head>
        <style>
          html, body, main { height: 100%; margin: 0; width: 100%; }
          body { background: #070808; overflow: hidden; }
          svg { display: block; height: 100%; width: 100%; }
        </style>
      </head>
      <body><main>${source}</main></body>
    </html>
  `);
  await page.screenshot({
    animations: "disabled",
    path: resolve(assetDirectory, "social-card.png"),
    scale: "css",
  });
  await page.close();
} finally {
  await browser.close();
}
