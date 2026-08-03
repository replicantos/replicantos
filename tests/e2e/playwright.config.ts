import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const dataDirectory = mkdtempSync(join(tmpdir(), "replicantos-e2e-"));
process.env.REPLICANTOS_E2E_DATA_DIR = dataDirectory;

export default defineConfig({
  expect: { timeout: 5_000 },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  globalTeardown: "./support/global-teardown.ts",
  outputDir: "../../artifacts/playwright",
  preserveOutput: "failures-only",
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  reporter: process.env.CI
    ? [
        ["list"],
        [
          "html",
          { open: "never", outputFolder: "../../artifacts/playwright-report" },
        ],
      ]
    : "list",
  retries: process.env.CI ? 1 : 0,
  testDir: "./specs",
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4310",
    colorScheme: "dark",
    contextOptions: { reducedMotion: "reduce" },
    locale: "en-US",
    screenshot: "only-on-failure",
    serviceWorkers: "block",
    timezoneId: "UTC",
    trace: "retain-on-failure",
    video: "off",
  },
  webServer: [
    {
      command:
        "pnpm --filter @replicantos/server... build && pnpm --filter @replicantos/server exec tsx ../../tests/e2e/support/live-server.ts",
      cwd: "../..",
      env: {
        NODE_ENV: "test",
        REPLICANTOS_ALLOWED_ORIGINS: "http://127.0.0.1:4310",
        REPLICANTOS_DATA_DIR: dataDirectory,
        REPLICANTOS_E2E_FAKE_HARNESSES: "true",
        REPLICANTOS_HOST: "127.0.0.1",
        REPLICANTOS_PORT: "8787",
        REPLICANTOS_RUNTIME_ENABLED: "false",
      },
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "pipe",
      timeout: 120_000,
      url: "http://127.0.0.1:8787/api/v1/health",
    },
    {
      command: "pnpm --filter @replicantos/web dev",
      cwd: "../..",
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "pipe",
      timeout: 120_000,
      url: "http://127.0.0.1:4310",
    },
    {
      command: "pnpm --filter @replicantos/site dev",
      cwd: "../..",
      env: { REPLICANTOS_SITE_PORT: "44173" },
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "pipe",
      timeout: 120_000,
      url: "http://127.0.0.1:44173",
    },
  ],
});
