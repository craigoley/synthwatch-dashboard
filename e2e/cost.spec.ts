import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";
import type { RawObj } from "./fixtures";

// Estimated monthly ACA compute cost (GET /reports/cost, synthwatch-api #198; recon #220/#229). Every figure
// traces to a real endpoint field — measured avg duration, configured interval, region count, the ECHOED rate.
// No hardcoded rate, no client-side complexity guessing.

const RATE = 0.00003;
const costCheck = (o: RawObj): RawObj => ({
  checkId: 0, sourceKey: null, name: "monitor", kind: "browser", intervalSeconds: 900, regionCount: 3,
  avgDurationS: 20, projectedMonthly: 5, measuredMonthly7d: 5, divergenceRatio: 1.0, divergenceFlag: false, ...o,
});

function costWorld(checks: RawObj[], agg: RawObj = {}) {
  const w = defaultWorld();
  w.costReport = {
    generatedAt: "2026-07-08T12:00:00Z",
    rateUsed: RATE,
    rateSource: "ACA Consumption vCPU-second (cpu=1.0 vCPU / mem=2 GiB, main.bicep:528-529)",
    rateSetDate: "2026-07-08",
    totalProjectedMonthly: 67.42,
    totalMeasuredMonthly: 71.1,
    topCostDrivers: checks,
    checks,
    ...agg,
  };
  return w;
}

test.describe("cost projection — overview + monitor-detail (grounded, labeled estimate)", () => {
  test("overview: total projected headline + top-N drivers; a measured≫projected driver is flagged; label reads the endpoint rate", async ({ page }) => {
    const checks = [
      costCheck({ checkId: 77, name: "wegmans-recipe-nav", projectedMonthly: 9.63, divergenceFlag: false }),
      costCheck({ checkId: 74, name: "wegmans-search-product", intervalSeconds: 600, projectedMonthly: 9.55, measuredMonthly7d: 18.2, divergenceRatio: 1.9, divergenceFlag: true }),
    ];
    await mockApi(page, costWorld(checks));
    await page.goto("/");

    await expect(page.getByTestId("fleet-cost-summary")).toBeVisible();
    await expect(page.getByTestId("fleet-cost-total-projected")).toContainText("$67.42");
    await expect(page.getByTestId("fleet-cost-total-measured")).toContainText("$71.10");
    // ★ top-N drivers (which monitors dominate — #229's insight)
    await expect(page.getByTestId("cost-driver-77")).toContainText("wegmans-recipe-nav");
    await expect(page.getByTestId("cost-driver-77")).toContainText("$9.63");
    // ★ a driver whose measured ≫ projected (>1.5×) is flagged
    await expect(page.getByTestId("cost-divergence-74")).toBeVisible();
    await expect(page.getByTestId("cost-divergence-74")).toContainText(/costing 1.9× projected/i);
    await expect(page.getByTestId("cost-divergence-77")).toHaveCount(0); // a healthy driver is NOT flagged
    // ★ estimate label reads the endpoint's echoed rate/date (never hardcoded)
    const label = page.getByTestId("fleet-cost-estimate-label");
    await expect(label).toContainText("$0.00003/vCPU-s");
    await expect(label).toContainText("set 2026-07-08");
    await expect(label).toContainText(/Azure bill is ground truth/i);
  });

  test("monitor-detail: projected + INSPECTABLE breakdown + measured + divergence>1.5 flag", async ({ page }) => {
    // check 1 (the default detail check): 300s interval, 3 regions → runs/mo = 2,592,000/300 = 8,640.
    const checks = [
      costCheck({ checkId: 1, name: "API health", kind: "http", intervalSeconds: 300, regionCount: 3, avgDurationS: 0.9, projectedMonthly: 0.7, measuredMonthly7d: 1.5, divergenceRatio: 2.1, divergenceFlag: true }),
    ];
    await mockApi(page, costWorld(checks));
    await page.goto("/checks/1");

    await expect(page.getByTestId("monitor-cost-panel")).toBeVisible();
    await expect(page.getByTestId("monitor-cost-projected")).toContainText("$0.70");
    await expect(page.getByTestId("monitor-cost-measured")).toContainText("$1.50");
    // ★ every factor of the breakdown is a real endpoint number, not a magic figure
    await expect(page.getByTestId("monitor-cost-breakdown")).toContainText(
      "0.90s avg × 8,640 runs/mo × 3 regions × $0.00003/vCPU-s",
    );
    // ★ divergence > 1.5 flags (retry/failure amplification)
    await expect(page.getByTestId("monitor-cost-divergence")).toBeVisible();
    await expect(page.getByTestId("monitor-cost-divergence")).toContainText(/2.1× the projection/i);
    // ★ labeled an estimate (tooltip carries the rate provenance)
    await expect(page.getByTestId("monitor-cost-estimate-label")).toBeVisible();
  });

  test("monitor-detail: no runs in the window → 'projection unavailable', never a fake $0", async ({ page }) => {
    const checks = [costCheck({ checkId: 1, name: "API health", kind: "http", avgDurationS: null, projectedMonthly: 0, measuredMonthly7d: 0, divergenceRatio: null, divergenceFlag: false })];
    await mockApi(page, costWorld(checks));
    await page.goto("/checks/1");
    await expect(page.getByTestId("monitor-cost-panel")).toContainText(/projection unavailable/i);
    await expect(page.getByTestId("monitor-cost-projected")).toHaveCount(0); // no $ figure at all
  });

  test("overview: endpoint absent (404) → the cost summary self-hides (no broken/blank panel)", async ({ page }) => {
    await mockApi(page); // default world: costReport unset → /reports/cost 404s
    await page.goto("/");
    await expect(page.getByTestId("fleet-cost-summary")).toHaveCount(0);
  });

  // ★ Honest-render: a 500 (broken) is LOUD, not silently absent — on BOTH surfaces (the #175/#177/#179 class).
  test("500 → loud error on the overview AND the monitor-detail panel (never rendered as absent)", async ({ page }) => {
    const w = costWorld([costCheck({ checkId: 1, name: "API health", kind: "http" })]);
    w.reports500 = true; // GET /reports/cost 500s
    await mockApi(page, w);

    await page.goto("/");
    await expect(page.getByTestId("fleet-cost-error")).toBeVisible();

    await page.goto("/checks/1");
    await expect(page.getByTestId("monitor-cost-error")).toBeVisible(); // broken, not a vanished panel
    await expect(page.getByTestId("monitor-cost-projected")).toHaveCount(0); // no fabricated figure
  });
});
