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

  // ── #178 coverage completed: the SAME page's remaining fetch-once panels join the one freshness regime. ──

  test("★ availability+performance rollup pair: one combined header stamp; refresh re-fetches BOTH", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/reports");

    await expect(page.getByTestId("reports-agg-fetched")).toContainText(/fetched \d\d:\d\d/);
    const availRefetch = page.waitForRequest((r) => r.url().includes("/reports/availability") && r.method() === "GET");
    const perfRefetch = page.waitForRequest((r) => r.url().includes("/reports/performance") && r.method() === "GET");
    await page.getByTestId("reports-agg-refresh").click();
    await Promise.all([availRefetch, perfRefetch]); // one button, both rollups revalidate
  });

  test("incident-breakdown card: stamp + working refresh", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/reports?tab=reliability");

    await expect(page.getByTestId("incident-breakdown-fetched")).toContainText(/fetched \d\d:\d\d/);
    const refetch = page.waitForRequest((r) => r.url().includes("/reports/incident-breakdown") && r.method() === "GET");
    await page.getByTestId("incident-breakdown-refresh").click();
    await refetch;
  });

  test("AI narrative card: stamp + working refresh (client fetch time, beside the server 'generated' time)", async ({ page }) => {
    const w = defaultWorld();
    w.narratives = {
      fleet: {
        scope: "fleet",
        window: "7d",
        headline: "Fleet steady",
        body: "All quiet this window.",
        highlights: [],
        // the runner writes fact_pack as an OBJECT (current/deltas) — mirror the real shape
        factPack: {
          current: { availabilityPct: 99.9, p95: 300, incidents: 0, downtimeMin: 0 },
          deltas: { availabilityPts: 0.1, p95Pct: -2, incidents: 0, downtimeMin: 0 },
          scopeType: "fleet",
        },
        generatedAt: "2026-07-01T00:00:00Z",
        stale: false,
      },
    };
    await mockApi(page, w);
    await page.goto("/reports");

    await expect(page.getByTestId("narrative-card")).toBeVisible();
    await expect(page.getByTestId("narrative-fetched")).toContainText(/fetched \d\d:\d\d/);
    const refetch = page.waitForRequest((r) => r.url().includes("/reports/narrative") && r.method() === "GET");
    await page.getByTestId("narrative-refresh").click();
    await refetch;
  });
});
