import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

/**
 * Staleness visibility on the fetch-once aggregate panels (no poll). Each shows an honest "fetched HH:MM" stamp
 * (client fetch time — these endpoints return no server "as of") + a manual refresh that re-fetches via SWR
 * mutate. The refresh-re-fetches assertion is the point: a stamp with a dead button would be worse than none.
 */
test.describe("report staleness stamps", () => {
  test("★ Trust scorecard: shows a 'fetched HH:MM' stamp; refresh re-fetches", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/reports?tab=trust");

    const stamp = page.getByTestId("trust-fetched");
    await expect(stamp).toBeVisible();
    await expect(stamp).toContainText(/fetched \d\d:\d\d/); // honest client-fetch-time label, not "as of"

    // clicking refresh triggers a fresh GET /reports/trust (SWR mutate revalidates the key)
    const refetch = page.waitForRequest((r) => r.url().includes("/reports/trust") && r.method() === "GET");
    await page.getByTestId("trust-refresh").click();
    await refetch; // resolves → the refresh actually re-fetched (not a dead button)
  });

  test("SLO panel: shows a stamp + working refresh", async ({ page }) => {
    const w = defaultWorld();
    w.sloCheckIds = [1, 2]; // ensure the panel has rows so it renders (not the hidden/empty branch)
    await mockApi(page, w);
    await page.goto("/reports?tab=reliability");

    await expect(page.getByTestId("fleet-slo-fetched")).toContainText(/fetched \d\d:\d\d/);
    const refetch = page.waitForRequest((r) => r.url().includes("/reports/slo") && r.method() === "GET");
    await page.getByTestId("fleet-slo-refresh").click();
    await refetch;
  });

  test("polling panels (egress, 60s) do NOT get a manual stamp — they self-freshen", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/status");
    await expect(page.getByTestId("egress-section")).toBeVisible();
    // egress polls (refreshInterval) → no fetched-stamp/refresh control (that's for the no-poll panels)
    await expect(page.getByTestId("egress-fetched")).toHaveCount(0);
  });
});
