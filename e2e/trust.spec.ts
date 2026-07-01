import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

/**
 * §D1 monitor-trust scorecard — the "every green with its proof" pitch artifact. The tests that matter are the
 * HONEST-RENDER ones: redTest is never a pass, never-green is a first-class state (not an error), a null retry
 * rate shows "—" not "0%", and perf/unclassified incidents are never folded into "real outage". Those prove
 * the honesty the scorecard exists for.
 */
test.describe("trust scorecard — fleet page", () => {
  test("renders the table with chips + the rule legend spelling the exact rules", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/trust");

    const table = page.getByTestId("trust-table");
    await expect(table).toBeVisible();
    // chips present in the table (scope to table — the legend also renders chips)
    await expect(table.getByTestId("trust-chip-proven-live")).toBeVisible();
    await expect(table.getByTestId("trust-chip-flaky")).toBeVisible();
    await expect(table.getByTestId("trust-chip-unverified")).toBeVisible();

    // ★ the legend is load-bearing: it must SPELL the named-constant rules verbatim
    const legend = page.getByTestId("trust-legend");
    await expect(legend).toContainText("retry < 10%");
    await expect(legend).toContainText("retry ≥ 50%");
    await expect(legend).toContainText("within 2 intervals");
    await expect(legend).toContainText("never green OR no runs");
  });

  test("worst-first sort: unverified + flaky lead, proven-live last", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/trust");
    const order = await page
      .getByTestId("trust-table")
      .locator('[data-testid^="trust-row-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    // unverified(4) → flaky(2) → nominal(3) → proven-live(1)
    expect(order).toEqual(["trust-row-4", "trust-row-2", "trust-row-3", "trust-row-1"]);
  });

  test("★ redTest is rendered as an honest GAP — 'not captured', never a checkmark/pass", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/trust");
    const rt = page.getByTestId("trust-redtest").first();
    await expect(rt).toContainText("not captured");
    await expect(rt).not.toContainText("✓"); // ★ never a pass/checkmark
    await expect(rt).not.toContainText("captured live");
  });

  test("★ never-green renders 'never verified' (a first-class state, not an error)", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/trust");
    const cell = page.getByTestId("trust-lastgreen-4"); // checkId 4 = never run
    await expect(cell).toContainText("never verified");
    await expect(cell).not.toContainText("Error");
    await expect(cell).not.toContainText("Invalid");
  });

  test("★ null retry rate shows '—', never '0%' (no fake zero)", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/trust");
    const retry = page.getByTestId("trust-retry-4"); // checkId 4 = 0 runs → retryRate null
    await expect(retry).toContainText("—");
    await expect(retry).not.toContainText("0%");
  });

  test("★ perf/unclassified incidents are NOT folded into real-outage (reds = real / other)", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/trust");
    // check 3: total 3 = realOutage 1 + perfRegression 1 + unclassified 1 → "1 / 2", NOT "3 / 0"
    const reds = page.getByTestId("trust-reds-3");
    await expect(reds).toContainText("1 / 2");
    await expect(reds).not.toContainText("3 /");
  });

  test("null-safe: endpoint 404 → the table self-hides to a quiet unavailable state, no crash", async ({ page }) => {
    const w = defaultWorld();
    w.reportsServed = false; // /reports/trust 404s
    await mockApi(page, w);
    await page.goto("/trust");
    await expect(page.getByTestId("trust-table")).toHaveCount(0);
    await expect(page.getByText("Trust data unavailable.")).toBeVisible();
    // the legend still renders (static, always useful), and the page didn't crash
    await expect(page.getByTestId("trust-legend")).toBeVisible();
  });
});

test.describe("trust card — monitor detail", () => {
  test("renders the chip, retry sparkline, and full incident breakdown (perf in its own bucket)", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/checks/3"); // nominal + a perfRegression incident

    const card = page.getByTestId("trust-card");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("trust-chip-nominal")).toBeVisible();
    await expect(page.getByTestId("trust-redtest")).toContainText("not captured");
    await expect(page.getByTestId("trust-retry-sparkline")).toBeVisible();
    // ★ every bucket shown separately — perf-regression and unclassified are NOT merged into real-outage
    await expect(page.getByTestId("trust-incident-real_outage")).toContainText("1");
    await expect(page.getByTestId("trust-incident-perf_regression")).toContainText("1");
    await expect(page.getByTestId("trust-incident-unclassified")).toContainText("1");
    // spec-provenance hash shown as an integrity fact (not a red-test)
    await expect(page.getByTestId("trust-provenance")).toContainText("cafe0002");
  });

  test("null-safe: 404 → the trust card self-hides, rest of the detail page renders", async ({ page }) => {
    const w = defaultWorld();
    w.reportsServed = false; // /reports/trust/{id} 404s
    await mockApi(page, w);
    await page.goto("/checks/3");
    await expect(page.getByTestId("trust-card")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible(); // page itself fine
  });
});
