import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const publicDirectory = resolve(currentDirectory, "../../../apps/web/public");
const source = await readFile(resolve(publicDirectory, "icon.svg"), "utf8");
const browser = await chromium.launch();

try {
  for (const size of [192, 512]) {
    const page = await browser.newPage({
      deviceScaleFactor: 1,
      viewport: { height: size, width: size },
    });
    await page.setContent(`
      <!doctype html>
      <html>
        <head>
          <style>
            html, body, main { height: 100%; margin: 0; width: 100%; }
            body { background: #0c0e0e; overflow: hidden; }
            svg { display: block; height: 100%; width: 100%; }
          </style>
        </head>
        <body><main>${source}</main></body>
      </html>
    `);
    await page.screenshot({
      animations: "disabled",
      path: resolve(publicDirectory, `icon-${size}.png`),
      scale: "css",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
