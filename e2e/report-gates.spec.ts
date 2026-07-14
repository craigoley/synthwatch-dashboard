import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

// ★ Minimum-sample gates (issue 3). Alert Quality + Error Budget are not broken, they are UNPOPULATED — and a
// tiny denominator renders as a confident verdict ("25%", "Budget blown"). Same three-state discipline as the
// trust dimensions: below a DATA-DERIVED minimum (a single event would flip the verdict), show the sample, not
// a percentage/verdict. These are must-go-red: revert the gate and the confidently-wrong signal returns.
test.describe("report min-sample gates — no confidently-wrong signal on a thin sample", () => {
  test("★ Alert quality: 1 of 4 classified is GATED — shows the sample, not a fragile 25%", async ({ page }) => {
    const w = defaultWorld();
    // Craig's case: precision 25% from a denominator of four. One reclassification (1→2 real) flips fail→warn.
    w.incidentBreakdown = {
      window: "30d", total: 6, classified: 4, unclassified: 2, realOutages: 1, precision: 0.25,
      buckets: [
        { classification: "real-outage", count: 1, share: 0.1667 },
        { classification: "flaky-transient", count: 3, share: 0.5 },
        { classification: "unclassified", count: 2, share: 0.3333 },
      ],
    };
    await mockApi(page, w);
    await page.goto("/reports?tab=reliability");

    const thin = page.getByTestId("alert-quality-thin");
    await expect(thin).toBeVisible();
    await expect(thin).toContainText("4 of 6 classified");
    // ★ the confidently-wrong precision headline must NOT render (its testid is gone in the gated branch)
    await expect(page.getByTestId("alert-quality-precision")).toHaveCount(0);
  });

  test("Alert quality: a large stable sample shows the precision % (gate does NOT over-fire)", async ({ page }) => {
    const w = defaultWorld();
    // 45 of 50 real — ±1 reclassification stays in the 'pass' band → not fragile → the % is trustworthy.
    w.incidentBreakdown = {
      window: "30d", total: 60, classified: 50, unclassified: 10, realOutages: 45, precision: 0.9,
      buckets: [
        { classification: "real-outage", count: 45, share: 0.75 },
        { classification: "flaky-transient", count: 5, share: 0.0833 },
      ],
    };
    await mockApi(page, w);
    await page.goto("/reports?tab=reliability");

    await expect(page.getByTestId("alert-quality-precision")).toContainText("90%");
    await expect(page.getByTestId("alert-quality-thin")).toHaveCount(0);
  });

  test("★ Error budget: a sub-one-failure budget is GATED — 'not enough data', never 'Budget blown'", async ({ page }) => {
    const w = defaultWorld();
    // The confirmation-retry canary case: target 0.99 over ~50 runs → budget 0.5 (< one whole permitted
    // failure). remaining < 0 would read "Budget blown" — but a single down-run flips it, so it's ungradeable.
    w.sloReport = {
      window: "30d",
      items: [{
        checkId: 9, checkName: "confirmation-canary", kind: "browser", target: 0.99,
        budget: 0.5, consumed: 1, remaining: -0.5, remainingPct: -1, burnRate: null,
        completedRuns: 50, insufficientData: false,
      }],
      fleet: { budget: 0.5, consumed: 1, remaining: -0.5, remainingPct: -1, insufficientData: false },
    };
    await mockApi(page, w);
    await page.goto("/reports?tab=reliability");

    await expect(page.getByTestId("fleet-slo-thin")).toBeVisible();
    await expect(page.getByTestId("slo-thin")).toBeVisible(); // the row too
    // ★ the confidently-wrong verdict must NOT render
    await expect(page.getByText("Budget blown")).toHaveCount(0);
  });
});
