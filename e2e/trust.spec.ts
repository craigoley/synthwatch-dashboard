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
    await expect(table.getByTestId("trust-chip-proven-live").first()).toBeVisible();
    await expect(table.getByTestId("trust-chip-flaky").first()).toBeVisible(); // ≥1 (2 flaky monitors now)
    await expect(table.getByTestId("trust-chip-unverified").first()).toBeVisible();

    // ★ the legend is load-bearing: it must SPELL the per-dimension formulas + thresholds verbatim (B3-2), then
    // the chip derivation over them.
    const legend = page.getByTestId("trust-legend");
    const dims = page.getByTestId("trust-legend-dimensions");
    await expect(dims).toContainText("transient failures ÷ scheduled runs"); // flap formula
    await expect(dims).toContainText("flaky ≥ 5%"); // flap flaky threshold (measured-distribution)
    await expect(dims).toContainText("runs needing a real retry ÷ runs"); // retry formula
    await expect(dims).toContainText("flaky ≥ 10%"); // retry flaky threshold
    await expect(dims).toContainText("selector-drift incidents"); // monitor-noise formula
    await expect(dims).toContainText("MONITOR-SIDE transients ÷ scheduled runs"); // ★ spurious-red formula
    await expect(dims).toContainText("Service-side transients never count"); // ★ the safety property, stated
    await expect(legend).toContainText("EVERY dimension ok"); // proven-live derivation
    await expect(legend).toContainText("ANY dimension flaky"); // flaky derivation
    await expect(legend).toContainText("within 2 intervals");
    await expect(legend).toContainText("never green OR no runs");
  });

  test("worst-first sort: unverified + flaky lead, proven-live last", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/reports?tab=trust");
    // ★ Wait for the rows before snapshotting: the Trust tab is lazy + async-fetched, and evaluateAll does NOT
    // auto-retry — snapshotting immediately after goto raced the fetch and got [] on CI (flaky).
    const rows = page.getByTestId("trust-table").locator('[data-testid^="trust-row-"]');
    await expect(rows).toHaveCount(5);
    const order = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    // unverified(4) → flaky(2 "Homepage" < 5 "Wegmans", by name) → nominal(3) → proven-live(1)
    expect(order).toEqual(["trust-row-4", "trust-row-2", "trust-row-5", "trust-row-3", "trust-row-1"]);
  });

  test("★ flap rate (confirmation-retry P2) is surfaced — transient failures that didn't count are visible", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/reports?tab=trust");
    await expect(page.getByTestId("trust-table")).toBeVisible();
    // the flaky monitor (checkId 2) has 6 transient failures / 142 scheduled → the flap note surfaces them,
    // making clear they did NOT count (not a hidden failure).
    const flap = page.getByTestId("trust-flap-note").first();
    await expect(flap).toContainText(/6 transient failures \/ 142 runs/i);
    await expect(flap).toContainText(/didn.t count/i);
    await expect(flap).toHaveAttribute("title", /confirmed not-real.*does NOT count|measured one that self-healed/i);
  });

  test("★ B3-2: distinct dimensions are surfaced per row — WHICH axis flags, not a collapsed verdict", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/reports?tab=trust");
    await expect(page.getByTestId("trust-table")).toBeVisible();

    // the flaky monitor (checkId 2) names its bad axes: retry flaky + monitor-noise flaky + spurious-red flaky, flap elevated.
    const flaky = page.getByTestId("trust-row-2");
    await expect(flaky.getByTestId("trust-dim-retry")).toHaveAttribute("data-state", "flaky");
    await expect(flaky.getByTestId("trust-dim-monitor_noise")).toHaveAttribute("data-state", "flaky");
    await expect(flaky.getByTestId("trust-dim-spurious_red")).toHaveAttribute("data-state", "flaky");
    await expect(flaky.getByTestId("trust-dim-flap")).toHaveAttribute("data-state", "elevated");

    // the nominal monitor (checkId 3) shows retry ELEVATED (blocks proven-live, not yet flaky).
    await expect(page.getByTestId("trust-row-3").getByTestId("trust-dim-retry")).toHaveAttribute("data-state", "elevated");

    // the proven-live monitor (checkId 1) reads clean on EVERY axis — that's what "proven live" means now.
    const clean = page.getByTestId("trust-row-1");
    for (const axis of ["flap", "retry", "monitor_noise", "spurious_red"]) {
      await expect(clean.getByTestId(`trust-dim-${axis}`)).toHaveAttribute("data-state", "ok");
    }
  });

  test("★★ B3-2 stage 2 SAFETY: a SERVICE-flaky monitor is NOT penalised on spurious-red (it caught real blips)", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/reports?tab=trust");
    await expect(page.getByTestId("trust-table")).toBeVisible();

    // checkId 5 flaps (flap flaky) but its transients are SERVICE-side → spurious-red stays OK: the monitor's
    // TRUST is intact; the budget never burns it for the service being flaky.
    const svc = page.getByTestId("trust-row-5");
    await expect(svc.getByTestId("trust-dim-flap")).toHaveAttribute("data-state", "flaky");        // it does flap (honest)
    await expect(svc.getByTestId("trust-dim-spurious_red")).toHaveAttribute("data-state", "ok");   // ★★ but NOT a monitor fault
    // the strip exposes the split (0 monitor / 3 service / 1 indeterminate) so the service share is visible.
    await expect(svc.getByTestId("trust-dim-spurious_red")).toContainText("0m/3s/1i");

    // the monitor-flaky monitor (checkId 2) DOES burn spurious-red (3 monitor-side).
    await expect(page.getByTestId("trust-row-2").getByTestId("trust-dim-spurious_red")).toHaveAttribute("data-state", "flaky");
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
    // forensic detail (sparkline / by-cause / full hash) lives behind the ONE "Details" disclosure — one tap
    await page.getByTestId("trust-details-toggle").click();
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
