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
    await expect(page.getByTestId("fleet-cost-estimate-label")).toContainText("$0.00003/vCPU-s");
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
    await expect(page.getByTestId("modal-cost-breakdown")).toContainText("2 regions × $0.00003/vCPU-s");
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

  test("honest-render: 500 is loud on the reports Cost tab AND the monitor-detail panel (never absent)", async ({ page }) => {
    const w = costWorld([costCheck({ checkId: 1, name: "API health", kind: "http" })]);
    w.reports500 = true;
    await mockApi(page, w);
    await page.goto("/reports?tab=cost");
    await expect(page.getByTestId("fleet-cost-error")).toBeVisible();
    await page.goto("/checks/1");
    await expect(page.getByTestId("monitor-cost-error")).toBeVisible();
  });
});
