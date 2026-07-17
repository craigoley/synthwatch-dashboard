import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";
import { listItem, slaRow, slaResponse, detail, run } from "./fixtures";

/**
 * ★ The thesis, applied to the grid: a status board where a failure doesn't POP is a board that HIDES
 * failures. The moment a monitor first goes red — BEFORE an incident opens — is when it most needs to pop and
 * was previously quietest (a thin 3px rail + a small badge among healthy neighbours). These tests seed a
 * FAILED and a DEGRADED card among healthy ones at 1024px (the measured worst width: 3-col, ~314px cards) and
 * assert the distinct, a11y-safe treatment. Plus: runs/24h relocated off the card, onto the detail page.
 */
test.describe("card scannability — a down/degrading card pops in the grid sweep", () => {
  test.use({ viewport: { width: 1024, height: 1000 } }); // ★ the measured worst width, not 768

  test("★ a FAILED and a DEGRADED card carry the distinct data-health treatment + a text badge; healthy stays 'ok'", async ({
    page,
  }) => {
    const w = defaultWorld();
    w.checks = [
      listItem({ id: 1, name: "checkout-api", currentStatus: "pass" }),
      listItem({ id: 2, name: "homepage-flow", kind: "browser", flowName: "homepage", currentStatus: "pass" }),
      // ★ freshly-failed: settled reads current_status when spark is empty → "fail", and NO incident yet.
      listItem({ id: 3, name: "payments-api", currentStatus: "fail" }),
      // ★ degraded: >1 location, none hard-down, one warn → the card's `degraded` branch (amber).
      listItem({
        id: 4,
        name: "search-api",
        currentStatus: "pass",
        locations: [
          { location: "eastus", status: "pass" },
          { location: "westeurope", status: "warn" },
        ],
      }),
      listItem({ id: 5, name: "cart-api", currentStatus: "pass" }),
      listItem({ id: 6, name: "login-flow", kind: "browser", flowName: "login", currentStatus: "pass" }),
    ];
    // Realistic availability for the screenshot (healthy 100%, the degraded one lower).
    w.sla = slaResponse("24h", [
      slaRow({ checkId: 1 }),
      slaRow({ checkId: 2 }),
      slaRow({ checkId: 3, availabilityPct: 41.7, upRuns: 5, downRuns: 7 }),
      slaRow({ checkId: 4, availabilityPct: 95.83, upRuns: 23, downRuns: 1 }),
      slaRow({ checkId: 5 }),
      slaRow({ checkId: 6 }),
    ]);
    await mockApi(page, w);
    await page.goto("/");

    const failed = page.locator('a[href="/checks/3"]');
    const degraded = page.locator('a[href="/checks/4"]');
    const healthy = page.locator('a[href="/checks/1"]');
    await expect(failed).toBeVisible();

    // ★ THE POP: data-health drives the tint + thicker rail. fail/warn are distinct from healthy AND each other.
    await expect(failed).toHaveAttribute("data-health", "fail");
    await expect(degraded).toHaveAttribute("data-health", "warn");
    await expect(healthy).toHaveAttribute("data-health", "ok");

    // ★ a11y (#280) — NOT color-alone: the treatment is PAIRED with dot+text. The failed card carries the
    // "Fail" badge; the degraded card carries the "degraded N/M" text label. A deuteranope reads the state.
    await expect(failed.getByText("Fail", { exact: true })).toBeVisible();
    await expect(degraded.getByText(/degraded/i)).toBeVisible();

    // the color signal (rail) matches data-health — red for fail, amber for degraded.
    expect(await failed.getAttribute("style")).toContain("var(--color-fail)");
    expect(await degraded.getAttribute("style")).toContain("var(--color-warn)");

    // ★ PROVE-CAN-FAIL: the fail/degraded cards actually render a DIFFERENT background than a healthy one
    // (the tint). Revert the data-health CSS and these collapse to the healthy background → the test reds.
    const healthyBg = await healthy.evaluate((el) => getComputedStyle(el).backgroundImage);
    const failedBg = await failed.evaluate((el) => getComputedStyle(el).backgroundImage);
    const degradedBg = await degraded.evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(failedBg, "failed card carries a distinct background tint").not.toBe(healthyBg);
    expect(degradedBg, "degraded card carries a distinct background tint").not.toBe(healthyBg);
    expect(failedBg, "failed (red) is distinct from degraded (amber)").not.toBe(degradedBg);

    // the acceptance artifact — a bad card must be findable at a glance in the full sweep.
    await page.screenshot({ path: "scannability-1024.png" });
  });

  test("runs/24h is OFF the grid card and ON the monitor detail page", async ({ page }) => {
    const w = defaultWorld();
    w.checks = [listItem({ id: 1, name: "checkout-api", currentStatus: "pass", runs24h: 42 })];
    w.details = { 1: detail({ id: 1, name: "checkout-api", currentStatus: "pass" }, [run({ id: 100, checkId: 1 })]) };
    // completed_runs=42 in the 24h SLA is what the detail header reads (SWR-deduped with the grid).
    w.sla = slaResponse("24h", [slaRow({ checkId: 1, completedRuns: 42, upRuns: 42 })]);
    await mockApi(page, w);

    // card: no runs/24h anymore
    await page.goto("/");
    await expect(page.locator('a[href="/checks/1"]')).toBeVisible();
    await expect(page.locator('a[href="/checks/1"]').getByText(/runs\/24h/)).toHaveCount(0);

    // detail: runs/24h present (relocated), sourced from the 24h SLA completed_runs
    await page.goto("/checks/1");
    await expect(page.getByTestId("detail-runs-24h")).toContainText("42 runs/24h");
  });
});
