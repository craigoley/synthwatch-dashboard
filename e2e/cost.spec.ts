import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";
import type { RawObj } from "./fixtures";

// Cost UI rework: fleet summary lives on the reports "Cost" sub-tab (gone from home); each monitor card shows
// its own projected $/mo (read from /reports/cost per-check data — no API change); the edit modal recomputes
// the projection LIVE as interval/regions change (avg duration held constant, measured). Every figure traces
// to a real endpoint field; the rate is the endpoint's echoed rate, never hardcoded.

const RATE = 0.00003;
const costCheck = (o: RawObj): RawObj => ({
  checkId: 0, sourceKey: null, name: "monitor", kind: "browser", intervalSeconds: 900, regionCount: 3,
  avgDurationS: 20, projectedMonthly: 5, measuredMonthly7d: 5, divergenceRatio: 1.0, divergenceFlag: false, ...o,
});
function costWorld(checks: RawObj[], agg: RawObj = {}) {
  const w = defaultWorld();
  w.costReport = {
    generatedAt: "2026-07-08T12:00:00Z", rateUsed: RATE,
    rateSource: "ACA Consumption vCPU-second (cpu=1.0 vCPU / mem=2 GiB, main.bicep:528-529)",
    rateSetDate: "2026-07-08", totalProjectedMonthly: 67.42, totalMeasuredMonthly: 71.1,
    topCostDrivers: checks, checks, ...agg,
  };
  return w;
}

test.describe("cost UI rework — Cost tab + card cost + modal live recompute", () => {
  test("fleet summary is on the reports Cost tab and GONE from the home page", async ({ page }) => {
    await mockApi(page, costWorld([costCheck({ checkId: 77, name: "wegmans-recipe-nav", projectedMonthly: 9.63 })]));

    await page.goto("/"); // ★ moved OFF home
    await expect(page.getByTestId("fleet-cost-summary")).toHaveCount(0);

    await page.goto("/reports?tab=cost"); // ★ now here
    await expect(page.getByTestId("reports-panel-cost")).toBeVisible();
    await expect(page.getByTestId("fleet-cost-total-projected")).toContainText("$67.42");
    await expect(page.getByTestId("cost-driver-77")).toContainText("wegmans-recipe-nav");
    await expect(page.getByTestId("fleet-cost-estimate-label")).toContainText("$0.00003/active-s");
  });

  test("★ NO CLIENT CAP: all top_cost_drivers render — the API ranks/limits (topN=50), the dashboard never slices", async ({ page }) => {
    // The API returns the ranked+capped list; the dashboard must render every row it's handed (no `.slice()`
    // below the API's N). Serve 12 drivers — well past the old 5-row fallback cap — and assert all 12 show.
    const drivers = Array.from({ length: 12 }, (_, i) =>
      costCheck({ checkId: 100 + i, name: `driver-${i}`, projectedMonthly: 12 - i })
    );
    await mockApi(page, costWorld(drivers));
    await page.goto("/reports?tab=cost");

    const rows = page.getByTestId("fleet-cost-drivers").getByRole("listitem");
    await expect(rows).toHaveCount(12); // every returned driver, not a client-capped subset
    await expect(page.getByTestId("cost-driver-100")).toBeVisible(); // first
    await expect(page.getByTestId("cost-driver-111")).toBeVisible(); // 12th (past the old 5-cap)
  });

  test("monitor card shows its own projected $/mo (est.); a check with no cost row shows none", async ({ page }) => {
    await mockApi(page, costWorld([costCheck({ checkId: 1, name: "API health", kind: "http", projectedMonthly: 0.7 })]));
    await page.goto("/");
    await expect(page.getByTestId("card-cost-1")).toContainText("~$0.70/mo est."); // per-check figure on the card
    await expect(page.getByTestId("card-cost-2")).toHaveCount(0); // check 2 absent from the report → no cost line
  });

  test("edit modal recomputes LIVE: interval 5→15 min drops cost ~3×; regions 3→2 drops ~⅓", async ({ page }) => {
    const w = costWorld([costCheck({ checkId: 1, name: "API health", kind: "http", intervalSeconds: 300, regionCount: 3, avgDurationS: 2.0, projectedMonthly: 1.56 })]);
    w.checkLocations = { 1: ["eastus2", "centralus", "westeurope"] }; // 3 regions assigned → seeds region_count=3
    await mockApi(page, w);
    await page.goto("/checks/1");
    await page.getByRole("button", { name: "Edit", exact: true }).click();

    const projected = page.getByTestId("modal-cost-projected");
    // baseline: 2.0s × (2,592,000/300) × 3 regions × $0.00003 = ~$1.56/mo (avg is MEASURED, held constant)
    await expect(projected).toContainText("~$1.56/mo");
    // ★ interval 5 → 15 min: runs/mo ÷3 → cost ÷3 → ~$0.52
    await page.getByLabel("Interval (minutes)").fill("15");
    await expect(projected).toContainText("~$0.52/mo");
    // ★ back to 5 min, drop westeurope (3 → 2 regions): cost ×2/3 → ~$1.04
    await page.getByLabel("Interval (minutes)").fill("5");
    await expect(projected).toContainText("~$1.56/mo");
    await page.getByRole("checkbox", { name: "westeurope" }).click();
    await expect(projected).toContainText("~$1.04/mo");
    // the breakdown reflects the live regions + the endpoint's rate (not hardcoded)
    await expect(page.getByTestId("modal-cost-breakdown")).toContainText("2 regions × $0.00003/active-s");
  });

  test("no run history (never-run monitor) → 'no duration history yet', never a fake $0", async ({ page }) => {
    const w = costWorld([]); // check 1 has NO cost row → no measured avg_duration
    w.checkLocations = { 1: ["eastus2"] };
    await mockApi(page, w);
    await page.goto("/checks/1");
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.getByTestId("modal-cost-no-history")).toBeVisible();
    await expect(page.getByTestId("modal-cost-no-history")).toContainText(/no duration history yet/i);
    await expect(page.getByTestId("modal-cost-projected")).toHaveCount(0); // no $ figure at all
  });

  // #279 deleted the monitor-detail cost panel (slimming the 2am fold); the fleet Cost tab keeps the loud
  // honest-render on 500 (the monitor-cost-error assertion moved out with the panel it tested).
  test("honest-render: 500 is loud on the reports Cost tab (never absent)", async ({ page }) => {
    const w = costWorld([costCheck({ checkId: 1, name: "API health", kind: "http" })]);
    w.reports500 = true;
    await mockApi(page, w);
    await page.goto("/reports?tab=cost");
    await expect(page.getByTestId("fleet-cost-error")).toBeVisible();
  });

  // ★ Bug B: the divergence warning named "retries/failures" — a cause the metric CANNOT SEE (duration
  // cancels; it's a pure run-count ratio). It must attribute from data (config-change straddle / confirmation
  // / sandbox) and show expected-vs-actual counts. MUST-GO-RED: the string "retries" must not appear.
  test("divergence flag attributes to run-count causes from data — NEVER retries", async ({ page }) => {
    // amore-menu-style: interval doubled (1800s), so the recent half has ~half the runs of the prior half →
    // measured still holds the old cadence, projected uses the new interval → 1.9× (a config-change artifact).
    // checkId 1 is a known monitor (defaultChecks), so /checks/1 renders the detail panel too.
    const flagged = costCheck({
      checkId: 1, name: "amore-menu", intervalSeconds: 1800, regionCount: 3,
      projectedMonthly: 5, measuredMonthly7d: 9.5, divergenceRatio: 1.9, divergenceFlag: true,
      runCount7d: 1900, confirmationCount7d: 0, sandboxCount7d: 0,
      runCountRecent: 630, runCountPrior: 1270, // recent << prior → a cadence step (the interval change)
    });
    await mockApi(page, costWorld([flagged]));
    await page.goto("/reports?tab=cost");

    const badge = page.getByTestId("cost-divergence-1");
    await expect(badge).toBeVisible();
    await expect(badge).toContainText("runs"); // expected-vs-actual counts, not a bare ratio
    await expect(badge).not.toContainText(/retr/i); // ★ must-go-red: no "retries"
    const title = (await badge.getAttribute("title")) ?? "";
    expect(title).toMatch(/interval changed recently/i); // the cadence-straddle attribution, from data
    expect(title).toMatch(/runs in the last 7d/i); // expected-vs-actual counts live in the badge title
    expect(title).not.toMatch(/retr/i);
    // (#279 deleted the monitor-detail cost panel; the divergence must-go-red is fully covered on the fleet badge.)
  });

  // #279 deleted the monitor-detail cost panel; the confirmation-attribution must-go-red (#251) is preserved
  // on the fleet Cost tab's divergence badge (same shared divergenceInfo() copy, carried in its title tooltip).
  test("divergence attributes to confirmation runs when present (still not retries)", async ({ page }) => {
    const flagged = costCheck({
      checkId: 2, name: "nextdoor-reservations", intervalSeconds: 900, regionCount: 3,
      projectedMonthly: 4, measuredMonthly7d: 7.6, divergenceRatio: 1.9, divergenceFlag: true,
      runCount7d: 3800, confirmationCount7d: 40, sandboxCount7d: 0,
      runCountRecent: 1900, runCountPrior: 1900, // no cadence step → the cause is the confirmation re-runs
    });
    await mockApi(page, costWorld([flagged]));
    await page.goto("/reports?tab=cost");
    const title = (await page.getByTestId("cost-divergence-2").getAttribute("title")) ?? "";
    expect(title).toMatch(/40 confirmation re-runs/i); // attributed from the count column, not retries
    expect(title).not.toMatch(/retr(y|ies)/i);
  });
});
