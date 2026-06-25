import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";
import { slaResponse, slaRow } from "./fixtures";

// Reports: per-monitor report CARDS sourced from the live checks list + SLA (+ optional rollup-report
// enrichment), so a monitor that has data always renders. ★ The old list bound only to /reports/availability
// — which returns empty even when monitors exist — so it showed "No monitors to report on" while the fleet
// summary had data. These tests pin the fix (cards render when the report endpoints are empty/404) and the
// redesign (availability/latency/incidents/narrative per monitor, window toggle).
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
  // Windowed availability comes from SLA (availabilityPct null even with runs, like prod → computed from
  // up/down): check 1 = 90.00%, check 2 = 80.00%.
  w.sla = slaResponse("7d", [
    slaRow({ checkId: 1, checkName: "API health", upRuns: 90, downRuns: 10, completedRuns: 100, availabilityPct: null }),
    slaRow({ checkId: 2, checkName: "Homepage flow", kind: "browser", upRuns: 80, downRuns: 20, completedRuns: 100, availabilityPct: null }),
  ]);
  return w;
}

test.describe("reports — per-monitor cards + tag filter", () => {
  test("renders a report card for every monitor (sourced from the live checks list)", async ({ page }) => {
    await mockApi(page, world());
    await page.goto("/reports");
    await expect(page.getByTestId("monitor-list")).toBeVisible();
    await expect(page.getByTestId("report-1")).toBeVisible();
    await expect(page.getByTestId("report-2")).toBeVisible();
    // tags show as chips on the card
    await expect(page.getByTestId("report-2")).toContainText("env");
    await expect(page.getByTestId("report-2")).toContainText("web");
  });

  test("★ cards render even when /reports/availability returns EMPTY groups (the bug)", async ({ page }) => {
    const w = world();
    w.reportsEmpty = true; // 200 + groups:[] — the prod failure mode
    await mockApi(page, w);
    await page.goto("/reports");

    // The list is NOT empty — monitors come from /checks, availability from /sla.
    await expect(page.getByTestId("monitor-list")).toBeVisible();
    await expect(page.getByTestId("report-1")).toBeVisible();
    await expect(page.getByTestId("report-1")).toContainText("90.00%"); // computed from SLA up/down
    await expect(page.getByTestId("report-2")).toContainText("80.00%");
    await expect(page.getByText("No monitors to report on.")).toHaveCount(0);
  });

  test("★ cards render even when the report endpoints 404 (not deployed)", async ({ page }) => {
    const w = world();
    w.reportsServed = false;
    await mockApi(page, w);
    await page.goto("/reports");
    await expect(page.getByTestId("report-1")).toBeVisible();
    await expect(page.getByTestId("report-1")).toContainText("90.00%");
    await expect(page.getByTestId("reports-pending")).toHaveCount(0); // the old blocker is gone
  });

  test("the filter offers ONLY real in-use tags (never invented dimensions)", async ({ page }) => {
    await mockApi(page, world());
    await page.goto("/reports");
    const filter = page.getByTestId("tag-filter");
    await expect(filter.getByRole("checkbox", { name: "filter env:prod" })).toBeVisible();
    await expect(filter.getByRole("checkbox", { name: "filter team:web" })).toBeVisible();
    await expect(filter.getByRole("checkbox")).toHaveCount(2);
  });

  test("tags FILTER the list (not group it) — multi-tag AND", async ({ page }) => {
    await mockApi(page, world());
    await page.goto("/reports");
    await expect(page.getByTestId("report-1")).toBeVisible();

    await page.getByRole("checkbox", { name: "filter team:web" }).click();
    await expect(page.getByTestId("report-2")).toBeVisible(); // has team:web
    await expect(page.getByTestId("report-1")).toHaveCount(0); // only env:prod → filtered out
    await expect(page.getByTestId("filter-result")).toContainText(/1 of \d+ monitors/);
  });

  test("sortable: availability vs name reorder the cards", async ({ page }) => {
    await mockApi(page, world());
    await page.goto("/reports");
    await page.getByRole("checkbox", { name: "filter env:prod" }).click(); // narrow to checks 1 & 2
    const firstCard = () => page.getByTestId("monitor-list").locator('[data-testid^="report-"]').first();

    // default sort = availability asc → lowest-availability check (2, 80%) first
    await expect(firstCard()).toHaveAttribute("data-testid", "report-2");
    // sort by name asc → "API health" (1) first
    await page.getByTestId("sort-name").click();
    await expect(firstCard()).toHaveAttribute("data-testid", "report-1");
  });

  test("drill-down: ★ web-vitals for the browser monitor, absent for http, never INP", async ({ page }) => {
    const w = world();
    w.metrics = [{ capturedAt: "2026-06-20T10:00:00Z", lcpMs: 1800, fcpMs: 900, ttfbMs: 200, cls: 0.05, inpMs: 120 }];
    await mockApi(page, w);
    await page.goto("/reports");

    // browser monitor (check 2) → expand → vitals panel with LCP, no INP
    await page.getByTestId("report-toggle-2").click();
    await expect(page.getByTestId("detail-2")).toBeVisible();
    await expect(page.getByTestId("vitals-2")).toContainText("LCP");
    await expect(page.getByTestId("vitals-2")).toContainText("1.80s");
    await expect(page.getByTestId("errors-2")).toBeVisible();
    await expect(page.getByText("INP", { exact: false })).toHaveCount(0);

    // http monitor (check 1) → NO web-vitals section
    await page.getByTestId("report-toggle-1").click();
    await expect(page.getByTestId("detail-1")).toBeVisible();
    await expect(page.getByTestId("vitals-1")).toHaveCount(0);
    await expect(page.getByTestId("errors-1")).toBeVisible();
  });
});
