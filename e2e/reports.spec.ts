import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

// Reporting Layer 2 — availability + performance, grouped by tag, windowed, with trend
// charts. Built to the contract; the mock generates deterministic reports from the query.
test.describe("reports", () => {
  test("availability by team: groups render with a trend chart", async ({ page }) => {
    await mockApi(page);
    await page.goto("/reports"); // defaults: availability, 30d, groupBy=team
    const report = page.getByTestId("availability-report");
    await expect(report).toBeVisible();
    await expect(report.getByTestId("group-platform")).toContainText("team: platform");
    await expect(report.getByTestId("group-platform")).toContainText("98.20%");
    await expect(report.getByTestId("group-web")).toContainText("75");
    await expect(report.getByTestId("group-platform").getByTestId("trend-chart")).toBeVisible();
  });

  test("performance: latency trend renders", async ({ page }) => {
    await mockApi(page);
    await page.goto("/reports");
    await page.getByRole("button", { name: "Performance" }).click();
    const report = page.getByTestId("performance-report");
    await expect(report).toBeVisible();
    await expect(report.getByTestId("group-platform")).toContainText(/p95/i);
    await expect(report.getByTestId("group-platform").getByTestId("trend-chart")).toBeVisible();
  });

  test("★ web-vitals shown for the browser group, absent for the http group, never INP", async ({ page }) => {
    await mockApi(page);
    await page.goto("/reports");
    await page.getByRole("button", { name: "Performance" }).click();

    // platform = browser checks → web-vitals panel (LCP/FCP/TTFB/CLS)
    const platform = page.getByTestId("group-platform");
    await expect(platform.getByTestId("web-vitals")).toBeVisible();
    await expect(platform.getByTestId("web-vitals")).toContainText("LCP");
    await expect(platform.getByTestId("web-vitals")).toContainText("CLS");

    // web = http checks → NO web-vitals card, just the honest note
    const web = page.getByTestId("group-web");
    await expect(web.getByTestId("web-vitals")).toHaveCount(0);
    await expect(web.getByTestId("no-vitals-note")).toBeVisible();

    // ★ INP is never captured → must not appear anywhere on the page
    await expect(page.getByText("INP", { exact: false })).toHaveCount(0);
  });

  test("window switch re-queries with the chosen window", async ({ page }) => {
    await mockApi(page);
    await page.goto("/reports");
    await expect(page.getByTestId("availability-report")).toBeVisible();
    const req = page.waitForRequest(
      (r) => r.url().includes("/api/reports/availability") && r.url().includes("window=7d"),
    );
    await page.getByRole("button", { name: "7d", exact: true }).click();
    await req; // a fetch for the 7d window fired
    await expect(page.getByTestId("availability-report")).toBeVisible();
  });

  test("groupBy switch changes the groups (team → none = All checks)", async ({ page }) => {
    await mockApi(page);
    await page.goto("/reports");
    await expect(page.getByTestId("group-platform")).toBeVisible();
    // NB: getByRole name "none" is unreliable (ARIA reserved token) — click by text.
    await page.getByText("none", { exact: true }).click();
    await expect(page.getByTestId("group-all")).toContainText("All checks");
    await expect(page.getByTestId("group-platform")).toHaveCount(0);
  });

  test("graceful pre-API: reports endpoint 404 → 'reports pending'", async ({ page }) => {
    const world = defaultWorld();
    world.reportsServed = false;
    await mockApi(page, world);
    await page.goto("/reports");
    await expect(page.getByTestId("reports-pending")).toBeVisible();
    await expect(page.getByTestId("availability-report")).toHaveCount(0);
  });
});
