import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

// ★ deploy-markers v1: the runner auto-detects deploys → the API serves them → the charts overlay ReferenceLine
// verticals at each deployed_at. This proves the OVERLAY is wired (the charts fetch deploys for the check's
// host) and is null-safe (no deploys / endpoint 404 → the chart renders clean, no crash — the .tone lesson).

test.describe("charts — deploy-marker overlay", () => {
  test("the charts fetch deploy markers for the check's host and still render", async ({ page }) => {
    const world = defaultWorld();
    world.deploys = [
      { sha: "70d6c6f3913186848af7568b20384dce9c3669d0", isSha: true, source: "sentry-release", deployedAt: new Date(Date.now() - 3_600_000).toISOString() },
      { sha: null, isSha: false, source: "etag", deployedAt: new Date(Date.now() - 1_800_000).toISOString() },
    ];
    let deployHost: string | null = null;
    page.on("request", (r) => {
      if (r.url().includes("/reports/deploys")) deployHost = new URL(r.url()).searchParams.get("host");
    });
    await mockApi(page, world);
    await page.goto("/checks/1");
    await page.waitForTimeout(600); // let the overlay fetch + recharts paint

    // ★ the overlay fetched deploys for the check's host (a deploy is per-host)
    expect(deployHost).toBeTruthy();
    // the availability chart still renders WITH the overlay (no crash)
    const card = page.locator(".sw-panel", { hasText: "Availability over time" });
    await expect(card.locator(".recharts-line-curve").first()).toBeVisible();
    // markers loaded fine → no "unavailable" caption
    await expect(page.getByTestId("deploy-marks-unavailable")).toHaveCount(0);
  });

  test("no deploys (empty 200) → chart renders, no overlay, NO 'unavailable' caption (genuinely none)", async ({ page }) => {
    const world = defaultWorld();
    world.deploys = []; // endpoint present but nothing detected yet
    await mockApi(page, world);
    await page.goto("/checks/1");
    await page.waitForTimeout(500);

    const card = page.locator(".sw-panel", { hasText: "Availability over time" });
    await expect(card.locator(".recharts-line-curve").first()).toBeVisible(); // still renders, no crash
    // ★ empty ≠ error: a genuine no-deploys window shows NO caption
    await expect(page.getByTestId("deploy-marks-unavailable")).toHaveCount(0);
  });

  test("★ deploys 500 → chart renders + 'markers unavailable' caption (error ≠ no-deploys)", async ({ page }) => {
    const world = defaultWorld();
    world.deploys500 = true; // the overlay fetch ERRORS (not 404-absent, not empty-200)
    await mockApi(page, world);
    await page.goto("/checks/1");

    // ★ the chart itself is unaffected — only the overlay failed
    const card = page.locator(".sw-panel", { hasText: "Availability over time" });
    await expect(card.locator(".recharts-line-curve").first()).toBeVisible();
    // ★ must-go-red: the caption surfaces the marker-load failure (old behavior showed no markers, silently)
    await expect(page.getByTestId("deploy-marks-unavailable").first()).toBeVisible();
  });

  test("endpoint 404 (not deployed / table not migrated) → charts render, no overlay", async ({ page }) => {
    const world = defaultWorld();
    world.reportsServed = false; // GET /reports/deploys 404s
    await mockApi(page, world);
    await page.goto("/checks/1");
    await page.waitForTimeout(500);

    await expect(page.locator(".sw-panel", { hasText: "Availability over time" }).locator(".recharts-line-curve").first()).toBeVisible();
    // 404 = feature absent (not an error) → no caption, same as a genuine no-deploys window
    await expect(page.getByTestId("deploy-marks-unavailable")).toHaveCount(0);
  });
});
