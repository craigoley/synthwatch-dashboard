import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

/**
 * Read seams are LOUD, not silent. For a monitoring tool the worst failure is a panel that self-HIDES on a
 * transient API error — indistinguishable from "not deployed" — so it vanishes on the exact incident day it's
 * needed. The fix narrows `catch → return null` to 404-ONLY (feature absent → hide, correct); a 500/network
 * error surfaces a visible error state.
 *
 * ★ These are must-go-red: each asserts the 500 case renders a VISIBLE error AND (negative) is not the hidden
 * state — a test that only checked 404-hides would pass on the OLD silent-swallow too.
 */
test.describe("read seams — loud on error, hidden only on 404", () => {
  test("SLO panel — 404 hides (preserved)", async ({ page }) => {
    const w = defaultWorld();
    w.reportsServed = false; // /reports/slo 404s (feature absent)
    w.sloCheckIds = [1, 2];
    await mockApi(page, w);
    await page.goto("/reports?tab=reliability");
    await expect(page.getByTestId("reports-panel-reliability")).toBeVisible();
    await expect(page.getByTestId("fleet-slo")).toHaveCount(0); // hidden — correct for absent
    await expect(page.getByTestId("fleet-slo-error")).toHaveCount(0); // and NOT an error (it's genuinely absent)
  });

  test("★ SLO panel — 500 renders a LOUD error, NOT a silent blank", async ({ page }) => {
    const w = defaultWorld();
    w.reports500 = true; // /reports/slo 500s (transient error, NOT absent)
    w.sloCheckIds = [1, 2];
    await mockApi(page, w);
    await page.goto("/reports?tab=reliability");
    // ★ the error state is visible — the panel did NOT vanish like "not deployed"
    const err = page.getByTestId("fleet-slo-error");
    await expect(err).toBeVisible();
    await expect(err).toContainText("failed to load");
  });

  test("★ Trust scorecard — 500 renders a LOUD error (distinct from the 404 'unavailable' empty)", async ({ page }) => {
    const w = defaultWorld();
    w.reports500 = true; // /reports/trust 500s
    await mockApi(page, w);
    await page.goto("/reports?tab=trust");
    await expect(page.getByTestId("trust-error")).toBeVisible();
    await expect(page.getByTestId("trust-error")).toContainText("failed to load");
    // the legend still renders (static), and the table did NOT silently appear empty-as-if-fine
    await expect(page.getByTestId("trust-legend")).toBeVisible();
    await expect(page.getByTestId("trust-table")).toHaveCount(0);
  });

  test("Trust scorecard — 404 shows the honest 'unavailable' empty (NOT the error state)", async ({ page }) => {
    const w = defaultWorld();
    w.reportsServed = false; // /reports/trust 404s (absent)
    await mockApi(page, w);
    await page.goto("/reports?tab=trust");
    await expect(page.getByText("Trust data unavailable.")).toBeVisible();
    await expect(page.getByTestId("trust-error")).toHaveCount(0); // absent ≠ broken
  });
});
