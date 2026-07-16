import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";
import type { RawObj } from "./fixtures";

// The cost-honesty rebuild (runner 0089/0090, api #263): the fleet Cost tab now leads with AZURE'S ACTUAL
// number (the `azure` block — MTD + forecast, pulled not modeled), falls back to a portal deep-link when that
// is absent (azure == null, NEVER a fabricated $0), and breaks the fleet down by COMPUTE SHARE
// (activeSecondsPct) instead of a per-monitor $. The modeled projection survives only as a labeled secondary.

const RATE = 0.00006;
const freshFetchedAt = () => new Date(Date.now() - 6 * 3600 * 1000).toISOString(); // 6h ago → not stale
const AZURE = (o: RawObj = {}): RawObj => ({
  scope: "resourceGroups/synthwatch-rg", currency: "USD", billingMonth: "2026-07-01",
  mtdActual: 47.17, mtdDays: 16, forecastMonth: 76.3,
  portalUrl: "https://portal.azure.com/#view/Microsoft_Azure_CostManagement/scoped", fetchedAt: freshFetchedAt(), ...o,
});
const costCheck = (o: RawObj): RawObj => ({
  checkId: 0, sourceKey: null, name: "monitor", kind: "browser", intervalSeconds: 900, regionCount: 3,
  avgDurationS: 20, activeSeconds: 100, activeSecondsPct: 10,
  projectedMonthly: 5, measuredMonthly7d: 5, divergenceRatio: 1.0, divergenceFlag: false, ...o,
});
// opts.azure: omit → a populated block; pass `null` → the honest-absent (fallback) path.
function costWorld(checks: RawObj[], opts: { azure?: RawObj | null } & RawObj = {}) {
  const { azure, ...agg } = opts;
  const w = defaultWorld();
  w.costReport = {
    generatedAt: "2026-07-08T12:00:00Z", rateUsed: RATE,
    rateSource: "ACA Consumption active meters (2.0 vCPU / 4 GiB)", rateSetDate: "2026-07-08",
    azure: azure === undefined ? AZURE() : azure,
    totalProjectedMonthly: 67.42, totalMeasuredMonthly: 71.1,
    topCostDrivers: checks, checks, ...agg,
  };
  return w;
}

test.describe("cost panel — Azure headline + compute-share breakdown", () => {
  test("fleet Cost tab: Azure MTD/forecast headline + share breakdown; GONE from home", async ({ page }) => {
    await mockApi(page, costWorld([costCheck({ checkId: 77, name: "wegmans-recipe-nav", activeSecondsPct: 22 })]));

    await page.goto("/"); // ★ not on home
    await expect(page.getByTestId("fleet-cost-summary")).toHaveCount(0);

    await page.goto("/reports?tab=cost");
    await expect(page.getByTestId("reports-panel-cost")).toBeVisible();
    // 1 — headline = Azure's actual number
    await expect(page.getByTestId("fleet-cost-azure-mtd")).toContainText("$47.17");
    await expect(page.getByTestId("fleet-cost-azure-forecast")).toContainText("$76.30");
    await expect(page.getByTestId("fleet-cost-azure-asof")).toContainText(/as of/i);
    // 2 — breakdown = compute share
    await expect(page.getByTestId("cost-driver-77")).toContainText("wegmans-recipe-nav");
    await expect(page.getByTestId("fleet-cost-share-77")).toContainText("22%");
    await expect(page.getByTestId("fleet-cost-share-note")).toContainText(/fleet compute/i);
  });

  test("★ the HEADLINE is Azure's number, not the modeled estimate (which is demoted to a labeled secondary)", async ({ page }) => {
    await mockApi(page, costWorld([costCheck({ checkId: 1 })]));
    await page.goto("/reports?tab=cost");
    // headline shows Azure MTD 47.17 — NOT the modeled fleet total 67.42
    await expect(page.getByTestId("fleet-cost-azure-mtd")).toContainText("$47.17");
    await expect(page.getByTestId("fleet-cost-azure-mtd")).not.toContainText("67.42");
    // the modeled figure exists, but only as the labeled "steady-state estimate" secondary
    await expect(page.getByTestId("fleet-cost-estimate")).toContainText(/steady-state estimate/i);
    await expect(page.getByTestId("fleet-cost-estimate-value")).toContainText("$67.42");
    // and it doubles as a drift check vs Azure's forecast (67.42 / 76.30 = 0.88×)
    await expect(page.getByTestId("fleet-cost-drift")).toContainText("0.88× vs Azure forecast");
  });

  test("★ azure ABSENT → deep-link fallback, NEVER a fabricated $0", async ({ page }) => {
    await mockApi(page, costWorld([costCheck({ checkId: 1, name: "API health" })], { azure: null }));
    await page.goto("/reports?tab=cost");
    // the honest-absent state, visually distinct (dashed unavailable card), keyed on azure == null
    await expect(page.getByTestId("fleet-cost-azure-unavailable")).toBeVisible();
    await expect(page.getByTestId("fleet-cost-azure-absent-msg")).toContainText(/unavailable/i);
    const link = page.getByTestId("fleet-cost-azure-portal-link");
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", /costanalysis/);
    // ★ no fabricated $0 and no MTD number in the headline area — absent ≠ zero
    await expect(page.getByTestId("fleet-cost-azure-unavailable")).not.toContainText("$0.00");
    await expect(page.getByTestId("fleet-cost-azure-mtd")).toHaveCount(0);
    // the modeled estimate still shows as the labeled secondary (never promoted to headline)
    await expect(page.getByTestId("fleet-cost-estimate-value")).toContainText("$67.42");
  });

  test("stale pulled figure is SHOWN but flagged 'may be stale' — not silently presented as current", async ({ page }) => {
    const stale = AZURE({ fetchedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString() }); // 3d > 2× daily
    await mockApi(page, costWorld([costCheck({ checkId: 1 })], { azure: stale }));
    await page.goto("/reports?tab=cost");
    await expect(page.getByTestId("fleet-cost-azure-mtd")).toContainText("$47.17"); // still shown
    await expect(page.getByTestId("fleet-cost-azure-asof")).toContainText(/may be stale/i); // but flagged
  });

  test("★ breakdown RANKS by compute share — the high-frequency low-share monitor sinks (the reorder IS the feature)", async ({ page }) => {
    // deliberately passed in NON-share order; the UI must sort by share, not fetch order.
    const dns = costCheck({ checkId: 10, name: "dns-check", kind: "dns", activeSecondsPct: 0.7, runCount7d: 9999 });
    const shop = costCheck({ checkId: 20, name: "shop-flow", kind: "browser", activeSecondsPct: 60 });
    const http = costCheck({ checkId: 30, name: "http-check", kind: "http", activeSecondsPct: 14 });
    await mockApi(page, costWorld([dns, shop, http]));
    await page.goto("/reports?tab=cost");
    const rows = page.getByTestId("fleet-cost-drivers").getByRole("listitem");
    await expect(rows.nth(0)).toContainText("shop-flow"); // 60% — first
    await expect(rows.nth(2)).toContainText("dns-check"); // 0.7% — LAST, though it fires the most (the point)
    await expect(page.getByTestId("fleet-cost-share-10")).toContainText("0.7%");
  });

  test("NO CLIENT CAP: every returned check renders in the breakdown (ranked by share)", async ({ page }) => {
    const checks = Array.from({ length: 12 }, (_, i) =>
      costCheck({ checkId: 100 + i, name: `driver-${i}`, activeSecondsPct: 12 - i })
    );
    await mockApi(page, costWorld(checks));
    await page.goto("/reports?tab=cost");
    const rows = page.getByTestId("fleet-cost-drivers").getByRole("listitem");
    await expect(rows).toHaveCount(8); // the panel shows the top 8 by share (a labeled breakdown, not the full fleet)
    await expect(page.getByTestId("cost-driver-100")).toBeVisible(); // highest share, first
  });

  test("monitor card shows its COMPUTE SHARE (not a per-monitor $); a check with no cost row shows none", async ({ page }) => {
    await mockApi(page, costWorld([costCheck({ checkId: 1, name: "API health", kind: "http", activeSecondsPct: 3.2 })]));
    await page.goto("/");
    await expect(page.getByTestId("card-cost-1")).toContainText("3.2% compute"); // share, not $
    await expect(page.getByTestId("card-cost-1")).not.toContainText("$"); // ★ no per-monitor dollar
    await expect(page.getByTestId("card-cost-2")).toHaveCount(0); // check 2 absent from the report → no cost line
  });

  test("edit modal recomputes LIVE: interval 5→15 min drops the estimate ~3×; regions 3→2 drops ~⅓", async ({ page }) => {
    const w = costWorld([costCheck({ checkId: 1, name: "API health", kind: "http", intervalSeconds: 300, regionCount: 3, avgDurationS: 2.0 })]);
    w.checkLocations = { 1: ["eastus2", "centralus", "westeurope"] };
    await mockApi(page, w);
    await page.goto("/checks/1");
    await page.getByRole("button", { name: "Edit", exact: true }).click();

    const projected = page.getByTestId("modal-cost-projected");
    // 2.0s × (2,592,000/300) × 3 regions × $0.00006 = ~$3.11/mo (avg is MEASURED, held constant)
    await expect(projected).toContainText("~$3.11/mo");
    await page.getByLabel("Interval (minutes)").fill("15"); // ÷3 → ~$1.04
    await expect(projected).toContainText("~$1.04/mo");
    await page.getByLabel("Interval (minutes)").fill("5");
    await expect(projected).toContainText("~$3.11/mo");
    await page.getByRole("checkbox", { name: "westeurope" }).click(); // 3 → 2 regions → ×2/3 → ~$2.07
    await expect(projected).toContainText("~$2.07/mo");
    await expect(page.getByTestId("modal-cost-breakdown")).toContainText("2 regions × $0.00006/active-s");
  });

  test("no run history (never-run monitor) → 'no duration history yet', never a fake $0", async ({ page }) => {
    const w = costWorld([]);
    w.checkLocations = { 1: ["eastus2"] };
    await mockApi(page, w);
    await page.goto("/checks/1");
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.getByTestId("modal-cost-no-history")).toBeVisible();
    await expect(page.getByTestId("modal-cost-no-history")).toContainText(/no duration history yet/i);
    await expect(page.getByTestId("modal-cost-projected")).toHaveCount(0);
  });

  test("honest-render: 500 is loud on the reports Cost tab (never absent)", async ({ page }) => {
    const w = costWorld([costCheck({ checkId: 1, name: "API health", kind: "http" })]);
    w.reports500 = true;
    await mockApi(page, w);
    await page.goto("/reports?tab=cost");
    await expect(page.getByTestId("fleet-cost-error")).toBeVisible();
  });

  // ★ Bug B: the divergence warning must attribute from DATA (config-change straddle / confirmation / sandbox)
  // and show expected-vs-actual counts — NEVER "retries" (duration cancels; it's a pure run-count ratio).
  test("divergence flag attributes to run-count causes from data — NEVER retries", async ({ page }) => {
    const flagged = costCheck({
      checkId: 1, name: "amore-menu", intervalSeconds: 1800, regionCount: 3, activeSecondsPct: 30,
      projectedMonthly: 5, measuredMonthly7d: 9.5, divergenceRatio: 1.9, divergenceFlag: true,
      runCount7d: 1900, confirmationCount7d: 0, sandboxCount7d: 0,
      runCountRecent: 630, runCountPrior: 1270,
    });
    await mockApi(page, costWorld([flagged]));
    await page.goto("/reports?tab=cost");

    const badge = page.getByTestId("cost-divergence-1");
    await expect(badge).toBeVisible();
    await expect(badge).toContainText("runs");
    await expect(badge).not.toContainText(/retr/i);
    const title = (await badge.getAttribute("title")) ?? "";
    expect(title).toMatch(/interval changed recently/i);
    expect(title).toMatch(/runs in the last 7d/i);
    expect(title).not.toMatch(/retr/i);
  });

  test("divergence attributes to confirmation runs when present (still not retries)", async ({ page }) => {
    const flagged = costCheck({
      checkId: 2, name: "nextdoor-reservations", intervalSeconds: 900, regionCount: 3, activeSecondsPct: 25,
      projectedMonthly: 4, measuredMonthly7d: 7.6, divergenceRatio: 1.9, divergenceFlag: true,
      runCount7d: 3800, confirmationCount7d: 40, sandboxCount7d: 0,
      runCountRecent: 1900, runCountPrior: 1900,
    });
    await mockApi(page, costWorld([flagged]));
    await page.goto("/reports?tab=cost");
    const title = (await page.getByTestId("cost-divergence-2").getAttribute("title")) ?? "";
    expect(title).toMatch(/40 confirmation re-runs/i);
    expect(title).not.toMatch(/retr(y|ies)/i);
  });
});
