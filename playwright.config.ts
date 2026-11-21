import { defineConfig, devices } from "@playwright/test";

/**
 * E2E runs against a disposable local schema, never the database in `.env`
 * (which may be a hosted or shared instance). `tests/e2e/prepare.ts` creates,
 * migrates and seeds it before Playwright starts.
 */
const E2E_DATABASE_URL =
  process.env.TEST_E2E_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/mfbmt_e2e?schema=public";

// The runner imports `db` directly for assertions; point it at the same schema
// and use the test tenant fallback for those out-of-request reads. The web
// server is explicitly started with NODE_ENV=development below.
process.env.DATABASE_URL = E2E_DATABASE_URL;
(process.env as Record<string, string>).NODE_ENV = "test";

const PORT = 3100;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 5"] } },
  ],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${PORT}`,
    // Set PLAYWRIGHT_CHANNEL=chrome to use the installed Google Chrome instead
    // of Playwright's bundled Chromium.
    ...(process.env.PLAYWRIGHT_CHANNEL
      ? { channel: process.env.PLAYWRIGHT_CHANNEL as "chrome" }
      : {}),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        // A dedicated port prevents reusing a developer server connected to the
        // configured (possibly hosted) database.
        command: `npm run dev -- -p ${PORT}`,
        url: `http://127.0.0.1:${PORT}/login`,
        reuseExistingServer: false,
        timeout: 180_000,
        env: {
          ...process.env,
          DATABASE_URL: E2E_DATABASE_URL,
          NODE_ENV: "development",
          DEMO_MODE: "true",
          SEED_DEMO_DATA: "true",
        },
      },
});
