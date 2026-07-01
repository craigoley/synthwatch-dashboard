import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

// ★ §A5: fleet MTTR / incident analytics on /reports. Median + mean time-to-resolve (open excluded), a
// classification breakdown (unclassified shown), and an MTTR trend. Tag-scoped; honest-empty; hides when the
// endpoint isn't deployed. Null-safe throughout (the .tone-crash lesson).

test.describe("reports — fleet MTTR / incident analytics", () => {
  test("default view: fleet tile + classification + trend + per-check rows, slowest first", async ({ page }) => {
    const w = defaultWorld();
    w.mttrCheckIds = [1, 2];
    await mockApi(page, w);
    await page.goto("/reports?tab=reliability");

    await expect(page.getByTestId("fleet-mttr")).toBeVisible();
    await expect(page.getByTestId("fleet-mttr-rollup")).toBeVisible();
    await expect(page.getByTestId("fleet-mttr-classification")).toBeVisible();
    await expect(page.getByTestId("fleet-mttr-trend")).toBeVisible();
    // unclassified is shown, never dropped (the P6 lesson)
    await expect(page.getByTestId("fleet-mttr-classification")).toContainText("Unclassified");
    // ★ slowest mean first: check 2 (mean 900s) sorts above check 1 (mean 200s)
    await expect(page.getByTestId("mttr-row-1")).toBeVisible();
    await expect(page.getByTestId("mttr-row-2")).toBeVisible();
    const y2 = (await page.getByTestId("mttr-row-2").boundingBox())!.y;
    const y1 = (await page.getByTestId("mttr-row-1").boundingBox())!.y;
    expect(y2).toBeLessThan(y1);
  });

  test("a tag with no incidents → honest empty, not fake zeros", async ({ page }) => {
    const w = defaultWorld();
    w.checks = w.checks.map((c) => (c.id === 1 ? { ...c, tags: [{ key: "team", value: "web" }] } : c));
    w.tags = [{ key: "team", value: "web", count: 1 }];
    w.mttrCheckIds = [2]; // check 2 does not carry team:web → scope is empty
    await mockApi(page, w);
    await page.goto("/reports?tags=team:web&tab=reliability");

    await expect(page.getByTestId("fleet-mttr")).toContainText("No incidents match this filter");
    await expect(page.getByTestId("fleet-mttr-rollup")).toHaveCount(0); // no fabricated rollup
  });

  test("endpoint not deployed (404) → the section hides gracefully", async ({ page }) => {
    const w = defaultWorld();
    w.reportsServed = false; // /reports/mttr 404s
    await mockApi(page, w);
    await page.goto("/reports?tab=reliability");

    await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible(); // page still renders
    await expect(page.getByTestId("fleet-mttr")).toHaveCount(0);
  });
});
