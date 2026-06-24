import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

// Reports rework: per-monitor DETAIL list (ungrouped default) with TAGS AS A FILTER
// (not a grouping axis), sortable, with a per-monitor drill-down. The mock's
// groupBy=none report mirrors world.checks, so rows ↔ check tags align by id.
function world() {
  const w = defaultWorld();
  // check 1 = "API health" (http) → env:prod ; check 2 = "Homepage flow" (browser) → env:prod + team:web
  w.checks = w.checks.map((c) =>
    c.id === 1
      ? { ...c, tags: [{ key: "env", value: "prod" }] }
      : c.id === 2
        ? { ...c, tags: [{ key: "env", value: "prod" }, { key: "team", value: "web" }] }
        : { ...c, tags: [] },
  );
  w.tags = [
    { key: "env", value: "prod", count: 2 },
    { key: "team", value: "web", count: 1 },
  ];
  return w;
}

test.describe("reports — detail-first + tag filter", () => {
  test("renders a per-monitor row for every monitor (ungrouped default)", async ({ page }) => {
    await mockApi(page, world());
    await page.goto("/reports");
    await expect(page.getByTestId("monitor-list")).toBeVisible();
    await expect(page.getByTestId("row-1")).toBeVisible();
    await expect(page.getByTestId("row-2")).toBeVisible();
    // tags show as chips on the row (not a grouping bucket)
    await expect(page.getByTestId("row-2")).toContainText("env");
    await expect(page.getByTestId("row-2")).toContainText("web");
  });

  test("the filter offers ONLY real in-use tags (never invented dimensions)", async ({ page }) => {
    await mockApi(page, world());
    await page.goto("/reports");
    const filter = page.getByTestId("tag-filter");
    await expect(filter.getByRole("checkbox", { name: "filter env:prod" })).toBeVisible();
    await expect(filter.getByRole("checkbox", { name: "filter team:web" })).toBeVisible();
    await expect(filter.getByRole("checkbox")).toHaveCount(2); // exactly the two real tags
  });

  test("tags FILTER the list (not group it) — multi-tag AND", async ({ page }) => {
    await mockApi(page, world());
    await page.goto("/reports");
    await expect(page.getByTestId("row-1")).toBeVisible();

    await page.getByRole("checkbox", { name: "filter team:web" }).click();
    await expect(page.getByTestId("row-2")).toBeVisible(); // has team:web
    await expect(page.getByTestId("row-1")).toHaveCount(0); // only env:prod → filtered out
    await expect(page.getByTestId("filter-result")).toContainText(/1 of \d+ monitors/);
  });

  test("sortable: name vs availability reorder the rows", async ({ page }) => {
    await mockApi(page, world());
    await page.goto("/reports");
    // narrow to checks 1 & 2 so order is deterministic
    await page.getByRole("checkbox", { name: "filter env:prod" }).click();
    const firstRow = () => page.getByTestId("monitor-list").locator('[data-testid^="row-"]').first();

    // default sort = availability asc → lowest-availability check (2) first
    await expect(firstRow()).toHaveAttribute("data-testid", "row-2");
    // sort by name asc → "API health" (1) first
    await page.getByTestId("sort-name").click();
    await expect(firstRow()).toHaveAttribute("data-testid", "row-1");
  });

  test("drill-down: ★ web-vitals for the browser monitor, absent for http, never INP", async ({ page }) => {
    const w = world();
    // INP IS in the data — the UI must still omit it.
    w.metrics = [{ capturedAt: "2026-06-20T10:00:00Z", lcpMs: 1800, fcpMs: 900, ttfbMs: 200, cls: 0.05, inpMs: 120 }];
    await mockApi(page, w);
    await page.goto("/reports");

    // browser monitor (check 2) → vitals panel with LCP, no INP
    await page.getByTestId("row-2").getByRole("button").first().click();
    await expect(page.getByTestId("detail-2")).toBeVisible();
    await expect(page.getByTestId("vitals-2")).toContainText("LCP");
    await expect(page.getByTestId("vitals-2")).toContainText("1.80s"); // LCP 1800ms
    await expect(page.getByTestId("errors-2")).toBeVisible();
    await expect(page.getByText("INP", { exact: false })).toHaveCount(0);

    // http monitor (check 1) → NO web-vitals section (honest scoping)
    await page.getByTestId("row-1").getByRole("button").first().click();
    await expect(page.getByTestId("detail-1")).toBeVisible();
    await expect(page.getByTestId("vitals-1")).toHaveCount(0);
    await expect(page.getByTestId("errors-1")).toBeVisible();
  });

  test("graceful pre-API: reports endpoint 404 → 'reports pending'", async ({ page }) => {
    const w = world();
    w.reportsServed = false;
    await mockApi(page, w);
    await page.goto("/reports");
    await expect(page.getByTestId("reports-pending")).toBeVisible();
    await expect(page.getByTestId("monitor-list")).toHaveCount(0);
  });
});
