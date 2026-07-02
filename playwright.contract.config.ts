import { defineConfig } from "@playwright/test";

// A stable API base so modules that read NEXT_PUBLIC_API_BASE_URL at load (api-client, the trace-proxy routes)
// resolve a real absolute base under the contract harness. `??=` never overrides a real env. Safe for existing
// tests — they parse the fetched URL via `new URL(url, "http://local")`, which handles absolute URLs too.
process.env.NEXT_PUBLIC_API_BASE_URL ??= "https://api.example.test/api";

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
