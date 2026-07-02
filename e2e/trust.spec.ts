import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

/**
 * §D1 monitor-trust scorecard — the "every green with its proof" pitch artifact. The tests that matter are the
 * HONEST-RENDER ones: redTest is never a pass, never-green is a first-class state (not an error), a null retry
 * rate shows "—" not "0%", and perf/unclassified incidents are never folded into "real outage". Those prove
 * the honesty the scorecard exists for.
 */
test.describe("trust scorecard — Reports 'Trust' tab", () => {
  test("legacy /trust deep-link redirects to the Reports Trust tab (no 404)", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/trust");
    await expect(page).toHaveURL(/\/reports\?tab=trust/);
    await expect(page.getByTestId("trust-table")).toBeVisible();
  });

  test("renders under the Reports Trust tab with chips + the rule legend spelling the exact rules", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/reports?tab=trust");

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
    await page.goto("/reports?tab=trust");
    // ★ Wait for the rows before snapshotting: the Trust tab is lazy + async-fetched, and evaluateAll does NOT
    // auto-retry — snapshotting immediately after goto raced the fetch and got [] on CI (flaky).
    const rows = page.getByTestId("trust-table").locator('[data-testid^="trust-row-"]');
    await expect(rows).toHaveCount(4);
    const order = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    // unverified(4) → flaky(2) → nominal(3) → proven-live(1)
    expect(order).toEqual(["trust-row-4", "trust-row-2", "trust-row-3", "trust-row-1"]);
  });

  test("★ redTest is rendered as an honest GAP — 'not captured', never a checkmark/pass", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/reports?tab=trust");
    const rt = page.getByTestId("trust-redtest").first();
    await expect(rt).toContainText("not captured");
    await expect(rt).not.toContainText("✓"); // ★ never a pass/checkmark
    await expect(rt).not.toContainText("captured live");
  });

  test("★ redTest CAPTURED renders 'red-tested' with its METHOD — executed vs attested render DISTINCTLY", async ({ page }) => {
    const inc = { total: 0, realOutage: 0, flakyTransient: 0, selectorDrift: 0, environmentRegional: 0, perfRegression: 0, unclassified: 0 };
    const sp = { executedSha256: "abc", specPath: "monitors/x.spec.ts" };
    const base = { sensitive: false, lastGreenAt: "2026-07-01T20:00:00Z", lastRunAt: "2026-07-01T20:00:00Z", runCount: 10, retryCount: 0, retryRate: 0, incidents: inc, specProvenance: sp, trust: "proven-live" };
    const w = defaultWorld();
    w.trustMonitors = [
      { ...base, checkId: 101, checkName: "mon-executed", redTest: { captured: true, testedAt: "2026-06-28T00:00:00Z", method: "executed-red-fixture" } },
      { ...base, checkId: 102, checkName: "mon-attested", redTest: { captured: true, testedAt: "2026-06-30T00:00:00Z", method: "attested-manual" } },
      { ...base, checkId: 103, checkName: "mon-none", redTest: { captured: false } },
    ];
    await mockApi(page, w);
    await page.goto("/reports?tab=trust");
    // ★ both captured methods render — DISTINCTLY, not collapsed to a generic "tested"
    await expect(page.getByText(/red-tested · executed/)).toBeVisible();
    await expect(page.getByText(/red-tested · attested/)).toBeVisible();
    // the not-captured row keeps the honest gap
    await expect(page.getByText("✗ not captured")).toBeVisible();
  });

  test("★ never-green renders 'never verified' (a first-class state, not an error)", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/reports?tab=trust");
    const cell = page.getByTestId("trust-lastgreen-4"); // checkId 4 = never run
    await expect(cell).toContainText("never verified");
    await expect(cell).not.toContainText("Error");
    await expect(cell).not.toContainText("Invalid");
  });

  test("★ null retry rate shows '—', never '0%' (no fake zero)", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/reports?tab=trust");
    const retry = page.getByTestId("trust-retry-4"); // checkId 4 = 0 runs → retryRate null
    await expect(retry).toContainText("—");
    await expect(retry).not.toContainText("0%");
  });

  test("★ perf/unclassified incidents are NOT folded into real-outage (reds = real / other)", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/reports?tab=trust");
    // check 3: total 3 = realOutage 1 + perfRegression 1 + unclassified 1 → "1 / 2", NOT "3 / 0"
    const reds = page.getByTestId("trust-reds-3");
    await expect(reds).toContainText("1 / 2");
    await expect(reds).not.toContainText("3 /");
  });

  test("★ degrading-but-green: the retried-passes annotation COEXISTS with proven-live (never a demotion)", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/reports?tab=trust");
    const row = page.getByTestId("trust-row-1"); // API health: proven-live AND retriedPasses = 4
    // ★ the chip is UNCHANGED (still proven-live) — the annotation is additive, not a downgrade
    await expect(row.getByTestId("trust-chip-proven-live")).toBeVisible();
    const note = row.getByTestId("trust-retried-passes");
    await expect(note).toBeVisible();
    await expect(note).toContainText("4 passes needed retries");
  });

  test("★ the annotation is ABSENT when retriedPasses is 0 (no false warning on a clean monitor)", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/reports?tab=trust");
    // check 3 omits retriedPasses → the tolerant mapper reads 0 → no annotation
    await expect(page.getByTestId("trust-row-3").getByTestId("trust-retried-passes")).toHaveCount(0);
  });

  test("null-safe: endpoint 404 → the table self-hides to a quiet unavailable state, no crash", async ({ page }) => {
    const w = defaultWorld();
    w.reportsServed = false; // /reports/trust 404s
    await mockApi(page, w);
    await page.goto("/reports?tab=trust");
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

  test("★ detail card shows the degrading-but-green annotation alongside a proven-live chip", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/checks/1"); // API health: proven-live + retriedPasses 4
    const card = page.getByTestId("trust-card");
    await expect(card.getByTestId("trust-chip-proven-live")).toBeVisible();  // ★ chip UNCHANGED — not a demotion
    await expect(card.getByTestId("trust-retried-passes")).toContainText("4 passes needed retries");
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
