import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  expect: { timeout: 5_000 },
  forbidOnly: Boolean(process.env.CI),
  outputDir: "../../artifacts/playwright-site",
  preserveOutput: "failures-only",
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  reporter: "list",
  retries: 0,
  testDir: "./specs",
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:44173",
    colorScheme: "dark",
    contextOptions: { reducedMotion: "reduce" },
    locale: "en-US",
    screenshot: "only-on-failure",
    serviceWorkers: "block",
    timezoneId: "UTC",
    trace: "retain-on-failure",
    video: "off",
  },
  webServer: {
    command: "pnpm --filter @replicantos/site dev",
    cwd: "../..",
    env: { REPLICANTOS_SITE_PORT: "44173" },
    reuseExistingServer: false,
    stderr: "pipe",
    stdout: "pipe",
    timeout: 120_000,
    url: "http://127.0.0.1:44173",
  },
});
