import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

// ★ P5 v1: fleet error-budget view on /reports. Budget accounting only (no fast/slow-burn pills at fleet
// scope). Per-check rows sorted most-at-risk first; insufficient_data → "building baseline"; tag-scoped;
// honest-empty; hides when the endpoint isn't deployed.

test.describe("reports — fleet SLO / error budget", () => {
  test("default view: fleet rollup + per-check rows, most-at-risk first", async ({ page }) => {
    const w = defaultWorld();
    w.sloCheckIds = [1, 2]; // both SLO-enabled, both have enough data
    w.sloBuildingIds = [];
    await mockApi(page, w);
    await page.goto("/reports?tab=reliability");

    await expect(page.getByTestId("fleet-slo")).toBeVisible();
    await expect(page.getByTestId("fleet-slo-rollup")).toBeVisible();
    await expect(page.getByTestId("slo-row-1")).toBeVisible();
    await expect(page.getByTestId("slo-row-2")).toBeVisible();
    // ★ most-at-risk first: check 2 (consumed 34 → 66% remaining) is worse than check 1 (17 → 83%) → row 2 above row 1
    const y2 = (await page.getByTestId("slo-row-2").boundingBox())!.y;
    const y1 = (await page.getByTestId("slo-row-1").boundingBox())!.y;
    expect(y2).toBeLessThan(y1);
  });

  test("insufficient_data → 'building baseline', never a fake %", async ({ page }) => {
    const w = defaultWorld();
    w.sloCheckIds = [1, 3];
    w.sloBuildingIds = [3]; // check 3 has too few runs
    await mockApi(page, w);
    await page.goto("/reports?tab=reliability");

    await expect(page.getByTestId("slo-row-3").getByTestId("slo-building")).toContainText("building baseline");
    await expect(page.getByTestId("slo-row-1")).not.toContainText("building"); // check 1 shows a real %
  });

  test("composes with the tag filter — scopes the SLO view to the tagged subset", async ({ page }) => {
    const w = defaultWorld();
    // tag check 1 with team:web; check 2 has no team:web → excluded under the filter
    w.checks = w.checks.map((c) => (c.id === 1 ? { ...c, tags: [{ key: "team", value: "web" }] } : c));
    w.tags = [{ key: "team", value: "web", count: 1 }];
    w.sloCheckIds = [1, 2];
    w.sloBuildingIds = [];
    await mockApi(page, w);
    await page.goto("/reports?tags=team:web&tab=reliability");

    await expect(page.getByTestId("report-scope-banner")).toBeVisible(); // filter still loud
    await expect(page.getByTestId("slo-row-1")).toBeVisible();
    await expect(page.getByTestId("slo-row-2")).toHaveCount(0); // check 2 filtered out
  });

  test("a tag with no SLO monitors → honest empty (not fake zeros)", async ({ page }) => {
    const w = defaultWorld();
    w.checks = w.checks.map((c) => (c.id === 1 ? { ...c, tags: [{ key: "team", value: "web" }] } : c));
    w.tags = [{ key: "team", value: "web", count: 1 }];
    w.sloCheckIds = [2, 3]; // neither carries team:web
    await mockApi(page, w);
    await page.goto("/reports?tags=team:web&tab=reliability");

    await expect(page.getByTestId("fleet-slo")).toContainText("No SLO monitors match this filter");
    await expect(page.getByTestId("fleet-slo-rollup")).toHaveCount(0); // no fake rollup
  });

  test("endpoint not deployed (404) → the section hides gracefully", async ({ page }) => {
    const w = defaultWorld();
    w.reportsServed = false; // /reports/slo 404s
    await mockApi(page, w);
    await page.goto("/reports?tab=reliability");

    await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible(); // page still renders
    await expect(page.getByTestId("fleet-slo")).toHaveCount(0);
  });
});
