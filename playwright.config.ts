import { defineConfig, devices } from "@playwright/test";

import { API_BASE } from "./e2e/mock";

const PORT = 3210;

/**
 * Hermetic E2E config. The app is built + served with NEXT_PUBLIC_API_BASE_URL
 * pointing at the mock host (API_BASE), and each test intercepts that host with
 * page.route — no real network, deterministic, runnable as a per-PR merge gate.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Build + start with the mock base URL inlined (NEXT_PUBLIC_* is build-time).
    command: `pnpm exec next build && pnpm exec next start --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    env: { NEXT_PUBLIC_API_BASE_URL: API_BASE },
  },
});
