import { defineConfig } from "@playwright/test";

/**
 * Contract checks — NO browser, NO webServer. Pure Node tests that run the REAL api-client mappers
 * against CAPTURED REAL API responses (contract/real/*.json), so the client + the captured ground-truth
 * cannot silently disagree. Run: `pnpm contract`.
 */
export default defineConfig({
  testDir: "./contract",
  testMatch: "**/*.contract.ts",
  fullyParallel: true,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
});
