import { test, expect, type Page } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

/**
 * /reports sub-tabs — the reorg into Performance / Reliability / Monitors. Pins the tab UX (default, deep-link,
 * switching, persistent global bar, group-by location) AND the two reasons-for-the-PR:
 *   • LAZY-LOAD: the self-fetching Reliability cards (breakdown/SLO/MTTR) do NOT fetch on initial load — only
 *     when their tab is opened (the ~9-eager-calls problem).
 *   • NO-DOUBLE-FETCH: avail/perf are page-hoisted, so switching Performance↔Monitors never re-fetches them.
 */

// Record every API request path (query stripped) the page makes, from before the first navigation.
function trackRequests(page: Page): string[] {
  const paths: string[] = [];
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes("/api/reports/") || u.includes("/api/reports?")) paths.push(new URL(u).pathname);
  });
  return paths;
}
const count = (paths: string[], suffix: string) => paths.filter((p) => p.endsWith(suffix)).length;

test.describe("reports — sub-tabs", () => {
  test("default load → Performance tab (Reliability/Monitors panels not mounted)", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/reports");
    await expect(page.getByTestId("reports-panel-performance")).toBeVisible();
    await expect(page.getByTestId("reports-tab-performance")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("reports-panel-reliability")).toHaveCount(0);
    await expect(page.getByTestId("reports-panel-monitors")).toHaveCount(0);
  });

  test("deep-link ?tab=reliability lands on Reliability (SLO/MTTR present)", async ({ page }) => {
    const w = defaultWorld();
    w.sloCheckIds = [1, 2];
    w.mttrCheckIds = [1, 2];
    await mockApi(page, w);
    await page.goto("/reports?tab=reliability");
    await expect(page.getByTestId("reports-panel-reliability")).toBeVisible();
    await expect(page.getByTestId("reports-tab-reliability")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("fleet-slo")).toBeVisible();
    await expect(page.getByTestId("fleet-mttr")).toBeVisible();
    await expect(page.getByTestId("reports-panel-performance")).toHaveCount(0);
  });

  test("switching tabs mounts the right panel; the Monitors list appears only in Monitors", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/reports");
    await expect(page.getByTestId("monitor-list")).toHaveCount(0); // not on Performance

    await page.getByTestId("reports-tab-monitors").click();
    await expect(page.getByTestId("monitor-list")).toBeVisible();

    await page.getByTestId("reports-tab-reliability").click();
    await expect(page.getByTestId("monitor-list")).toHaveCount(0);
    await expect(page.getByTestId("reports-panel-reliability")).toBeVisible();
  });

  test("global bar (window + tag filter) persists across every tab; group-by lives ONLY in Monitors", async ({ page }) => {
    const w = defaultWorld();
    w.tags = [{ key: "env", value: "prod", count: 1 }]; // in-use tags → the global TagFilter renders
    await mockApi(page, w);
    await page.goto("/reports");
    const windowToggle = page.getByRole("group", { name: "window" });

    // Performance: window + filter present, group-by NOT here (it moved to Monitors)
    await expect(windowToggle).toBeVisible();
    await expect(page.getByTestId("tag-filter")).toBeVisible();
    await expect(page.getByTestId("group-by-select")).toHaveCount(0);

    // Reliability: global bar still there, still no group-by
    await page.getByTestId("reports-tab-reliability").click();
    await expect(windowToggle).toBeVisible();
    await expect(page.getByTestId("tag-filter")).toBeVisible();
    await expect(page.getByTestId("group-by-select")).toHaveCount(0);

    // Monitors: global bar there AND the group-by control appears
    await page.getByTestId("reports-tab-monitors").click();
    await expect(windowToggle).toBeVisible();
    await expect(page.getByTestId("tag-filter")).toBeVisible();
    await expect(page.getByTestId("group-by-select")).toBeVisible();
  });

  test("★ LAZY-LOAD: Reliability hooks (SLO/MTTR/breakdown) do NOT fire on load — only when the tab opens", async ({ page }) => {
    const w = defaultWorld();
    w.sloCheckIds = [1, 2];
    w.mttrCheckIds = [1, 2];
    await mockApi(page, w);
    const paths = trackRequests(page);

    await page.goto("/reports");
    await expect(page.getByTestId("reports-panel-performance")).toBeVisible();
    // Performance-only load fetched avail/perf (page-level) but NOT the Reliability endpoints.
    expect(count(paths, "/reports/availability")).toBeGreaterThan(0);
    expect(count(paths, "/reports/performance")).toBeGreaterThan(0);
    expect(count(paths, "/reports/slo"), "SLO must not fetch until Reliability opens").toBe(0);
    expect(count(paths, "/reports/mttr"), "MTTR must not fetch until Reliability opens").toBe(0);
    expect(count(paths, "/reports/incident-breakdown"), "breakdown must not fetch until Reliability opens").toBe(0);

    // Open Reliability → now (and only now) the three self-fetching cards hit their endpoints.
    await page.getByTestId("reports-tab-reliability").click();
    await expect(page.getByTestId("fleet-slo")).toBeVisible();
    expect(count(paths, "/reports/slo")).toBeGreaterThan(0);
    expect(count(paths, "/reports/mttr")).toBeGreaterThan(0);
    expect(count(paths, "/reports/incident-breakdown")).toBeGreaterThan(0);
  });

  test("★ NO-DOUBLE-FETCH: Performance→Monitors→Performance does not re-fetch page-hoisted avail/perf", async ({ page }) => {
    await mockApi(page, defaultWorld());
    const paths = trackRequests(page);

    await page.goto("/reports");
    await expect(page.getByTestId("reports-panel-performance")).toBeVisible();
    const availAfterLoad = count(paths, "/reports/availability");
    const perfAfterLoad = count(paths, "/reports/performance");
    expect(availAfterLoad).toBe(1);
    expect(perfAfterLoad).toBe(1);

    await page.getByTestId("reports-tab-monitors").click();
    await expect(page.getByTestId("monitor-list")).toBeVisible();
    await page.getByTestId("reports-tab-performance").click();
    await expect(page.getByTestId("reports-panel-performance")).toBeVisible();

    // avail/perf are hoisted to page level → fetched ONCE, never re-fired by tab switches.
    expect(count(paths, "/reports/availability")).toBe(availAfterLoad);
    expect(count(paths, "/reports/performance")).toBe(perfAfterLoad);
  });
});
