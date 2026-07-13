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

  // ★ B3-3 on the INVESTIGATE surface: the flake budget + "degraded as a monitor" + the directed FIX TASK now
  // render on the per-monitor card (previously only in the fleet Trust table). Same FlakeBudgetNote, data
  // already on the card's monitor payload — no new fetch.
  test("★ flake budget: 'degraded as a monitor' + the directed task render on the detail card", async ({ page }) => {
    const w = defaultWorld();
    w.trustMonitors = [
      {
        checkId: 1, checkName: "API health", sensitive: false,
        lastGreenAt: "2026-07-01T20:00:00Z", lastRunAt: "2026-07-01T20:05:00Z",
        runCount: 500, retryCount: 6, retryRate: 0.012, retriedPasses: 0,
        flapCount: 9, scheduledCount: 142, flapRate: 0.0634,
        incidents: { total: 0, realOutage: 0, flakyTransient: 0, selectorDrift: 0, environmentRegional: 0, perfRegression: 0, unclassified: 0 },
        redTest: { captured: false },
        specProvenance: { executedSha256: "abc123def456", specPath: "monitors/api/health.spec.ts" },
        dimensions: { flap: { state: "flaky" }, retry: { state: "ok" }, monitorNoise: { state: "ok" }, spuriousRed: { state: "flaky" } },
        transients: { monitorSide: 9, serviceSide: 0, indeterminate: 0, spuriousRedRate: 0.0634 },
        trust: "flaky",
        flakeBudget: {
          state: "degraded-as-a-monitor", target: 0.02, targetIsDefault: true, scheduledRuns: 142,
          monitorSide: 9, serviceSide: 0, indeterminate: 0,
          budget: 2.84, consumed: 9, remaining: -6.16, remainingPct: null, burnRate: 3.2,
          directedTask: "Stabilise the add-to-cart selector — 9 monitor-side transients this window",
        },
      },
    ];
    await mockApi(page, w);
    await page.goto("/checks/1");

    const card = page.getByTestId("trust-card");
    await expect(card).toBeVisible();
    const budget = card.getByTestId("trust-flake-budget");
    await expect(budget).toBeVisible();
    await expect(card.getByTestId("trust-degraded-as-monitor")).toContainText(/degraded as a monitor/i);
    await expect(budget).toContainText("9/2.8 monitor-side budget"); // consumed / budget
    await expect(budget).toContainText("burn 3.2×");
    await expect(card.getByTestId("trust-directed-task")).toContainText("Stabilise the add-to-cart selector");
  });

  test("flake budget note self-hides on the card when HEALTHY (state ok, no indeterminate) — and is NOT absence", async ({ page }) => {
    // defaultWorld's check 1 carries an explicit state:"ok" flakeBudget → nothing to say. Distinct from the
    // absent case below: healthy renders NEITHER the degraded note NOR the "no data" note.
    await mockApi(page, defaultWorld());
    await page.goto("/checks/1");
    await expect(page.getByTestId("trust-card")).toBeVisible();
    await expect(page.getByTestId("trust-flake-budget")).toHaveCount(0);
    await expect(page.getByTestId("trust-flake-budget-absent")).toHaveCount(0); // healthy ≠ absent
  });

  // ★ THE FIX: an ABSENT flake budget (API sent no flakeBudget object) must render EXPLICIT absence — never
  // nothing, never a synthetic "ok". If the API stopped sending flakeBudget, the card SAYS so. (#177 class.)
  test("★ absent flake budget: a null/missing flakeBudget renders an EXPLICIT 'no data', not a healthy self-hide", async ({ page }) => {
    const w = defaultWorld();
    w.trustMonitors = [
      // A monitor row with NO flakeBudget field at all → mapFlakeBudget(undefined) → null → explicit absence.
      {
        checkId: 1, checkName: "API health", sensitive: false,
        lastGreenAt: "2026-07-01T20:00:00Z", lastRunAt: "2026-07-01T20:05:00Z",
        runCount: 500, retryCount: 6, retryRate: 0.012, retriedPasses: 0,
        incidents: { total: 0, realOutage: 0, flakyTransient: 0, selectorDrift: 0, environmentRegional: 0, perfRegression: 0, unclassified: 0 },
        redTest: { captured: false },
        specProvenance: { executedSha256: "abc123def456", specPath: "monitors/api/health.spec.ts" },
        dimensions: { flap: { state: "ok" }, retry: { state: "ok" }, monitorNoise: { state: "ok" }, spuriousRed: { state: "ok" } },
        trust: "proven-live",
        // flakeBudget deliberately OMITTED — models the API dropping the field.
      },
    ];
    await mockApi(page, w);
    await page.goto("/checks/1");

    const card = page.getByTestId("trust-card");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("trust-flake-budget-absent")).toBeVisible();
    await expect(card.getByTestId("trust-flake-budget-absent")).toContainText(/no flake-budget data/i);
    // ★ NOT the healthy self-hide and NOT the degraded note: absence is its own render.
    await expect(card.getByTestId("trust-flake-budget")).toHaveCount(0);
    await expect(card.getByTestId("trust-degraded-as-monitor")).toHaveCount(0);
    // the chip still renders (absence of the budget must not blank the card)
    await expect(card.getByTestId("trust-chip-proven-live")).toBeVisible();
  });

  test("absent flake budget renders on the FLEET table row too (both mount sites inherit it)", async ({ page }) => {
    const w = defaultWorld();
    // One row omits flakeBudget → the fleet table row shows explicit absence, not a clean/healthy row.
    w.trustMonitors = [
      {
        checkId: 7, checkName: "Budget-less monitor", sensitive: false,
        lastGreenAt: "2026-07-01T20:00:00Z", lastRunAt: "2026-07-01T20:05:00Z",
        runCount: 100, retryCount: 1, retryRate: 0.01, incidents: { total: 0, realOutage: 0, flakyTransient: 0, selectorDrift: 0, environmentRegional: 0, perfRegression: 0, unclassified: 0 },
        redTest: { captured: false }, specProvenance: { executedSha256: "0007", specPath: "monitors/x.spec.ts" },
        dimensions: { flap: { state: "ok" }, retry: { state: "ok" }, monitorNoise: { state: "ok" }, spuriousRed: { state: "ok" } },
        trust: "proven-live",
        // flakeBudget OMITTED
      },
    ];
    await mockApi(page, w);
    await page.goto("/reports?tab=trust");
    await expect(page.getByTestId("trust-flake-budget-absent").first()).toBeVisible();
    await expect(page.getByTestId("trust-flake-budget-absent").first()).toContainText(/no flake-budget data/i);
  });

  // ★ PART 2 — the dimensions seam. An absent dimensions payload must render EXPLICIT unknown, NOT four clean
  // "ok" dims. The chip does NOT mitigate: it downgrades to "unverified" only on no-green/no-runs, so a monitor
  // WITH a green + runs whose dimensions went missing reads chip "nominal" beside four fake-clean axes.
  test("★ absent dimensions payload renders UNKNOWN dims, not fake-clean 'ok' (the chip does not mitigate)", async ({ page }) => {
    const w = defaultWorld();
    w.trustMonitors = [
      {
        checkId: 1, checkName: "API health", sensitive: false,
        lastGreenAt: "2026-07-01T20:00:00Z", lastRunAt: "2026-07-01T20:05:00Z", // ★ WITH a green
        runCount: 500, retryCount: 6, retryRate: 0.012, // ★ WITH runs → chip is NOT "unverified"
        incidents: { total: 0, realOutage: 0, flakyTransient: 0, selectorDrift: 0, environmentRegional: 0, perfRegression: 0, unclassified: 0 },
        redTest: { captured: false }, specProvenance: { executedSha256: "abc123def456", specPath: "monitors/api/health.spec.ts" },
        trust: "nominal", // the API-computed chip — reads fine on its own
        flakeBudget: { state: "ok", target: 0.02, targetIsDefault: true, scheduledRuns: 500, monitorSide: 0, serviceSide: 0, indeterminate: 0, budget: 10, consumed: 0, remaining: 10, remainingPct: 1, burnRate: 0, directedTask: null },
        // dimensions + transients DELIBERATELY OMITTED — models the payload going missing.
      },
    ];
    await mockApi(page, w);
    await page.goto("/checks/1");

    const strip = page.getByTestId("trust-card-dimensions");
    await expect(strip).toBeVisible();
    // ★ every axis reads UNKNOWN, never "ok"
    for (const k of ["flap", "retry", "monitor_noise", "spurious_red"]) {
      await expect(strip.getByTestId(`trust-dim-${k}`)).toHaveAttribute("data-state", "unknown");
    }
    await expect(strip.getByTestId("trust-dim-flap")).toContainText(/no data/i);
    await expect(strip.locator('[data-state="ok"]')).toHaveCount(0); // NOT one fake-clean axis
    // ★ the chip beside it reads "nominal" — proof that nothing mitigates a fake-clean strip
    await expect(page.getByTestId("trust-chip-nominal")).toBeVisible();
  });

  test("a present dimension state still renders normally (ok/elevated/flaky unchanged)", async ({ page }) => {
    // regression guard: valid states are untouched — only ABSENT → unknown changed.
    await mockApi(page, defaultWorld());
    await page.goto("/reports?tab=trust");
    // check 2 (Homepage flow): retry flaky, spurious-red flaky — present states render as before.
    const row2 = page.getByTestId("trust-row-2");
    await expect(row2.getByTestId("trust-dim-retry")).toHaveAttribute("data-state", "flaky");
    await expect(row2.getByTestId("trust-dim-flap")).toHaveAttribute("data-state", "elevated");
    await expect(row2.locator('[data-state="unknown"]')).toHaveCount(0); // present payload → no unknowns
  });

  // ★ THE FOURTH fake-quiet instance (this PR): an absent incidents rollup must render EXPLICIT "no data",
  // never the healthy "No incidents in this window" / a zero count.
  test("★ absent incidents rollup renders 'no incident data', not the healthy 'No incidents'", async ({ page }) => {
    const w = defaultWorld();
    w.trustMonitors = [
      {
        checkId: 1, checkName: "API health", sensitive: false,
        lastGreenAt: "2026-07-01T20:00:00Z", lastRunAt: "2026-07-01T20:05:00Z",
        runCount: 500, retryCount: 6, retryRate: 0.012,
        redTest: { captured: false }, specProvenance: { executedSha256: "abc123def456", specPath: "monitors/api/health.spec.ts" },
        dimensions: { flap: { state: "ok" }, retry: { state: "ok" }, monitorNoise: { state: "ok" }, spuriousRed: { state: "ok" } },
        flakeBudget: { state: "ok", target: 0.02, targetIsDefault: true, scheduledRuns: 500, monitorSide: 0, serviceSide: 0, indeterminate: 0, budget: 10, consumed: 0, remaining: 10, remainingPct: 1, burnRate: 0, directedTask: null },
        trust: "proven-live",
        // incidents DELIBERATELY OMITTED → maps to null → explicit "no data".
      },
    ];
    await mockApi(page, w);
    await page.goto("/checks/1");

    const card = page.getByTestId("trust-card");
    await expect(card).toBeVisible();
    // summary surfaces the absence loudly (not hidden, not a zero count)
    await expect(card.getByTestId("trust-incidents-nodata-summary")).toContainText(/no data/i);
    // ★ NOT the healthy "No incidents in this window", and no fake count
    await expect(page.getByTestId("trust-incidents-none")).toHaveCount(0);
    await expect(card.getByTestId("trust-incidents-count")).toHaveCount(0);
    // the by-cause disclosure says "no incident data", distinct from a genuine zero
    await card.getByTestId("trust-details-toggle").click();
    await expect(card.getByTestId("trust-incidents-nodata")).toContainText(/no incident data/i);
  });

  test("a genuine zero-incident monitor still reads 'No incidents in this window' (not 'no data')", async ({ page }) => {
    // regression guard: total:0 (present rollup) ≠ null (absent rollup). defaultWorld check 1 has trustInc() → 0.
    await mockApi(page, defaultWorld());
    await page.goto("/checks/1");
    await page.getByTestId("trust-details-toggle").click();
    await expect(page.getByTestId("trust-incidents-none")).toContainText(/no incidents in this window/i);
    await expect(page.getByTestId("trust-incidents-nodata")).toHaveCount(0); // present-zero ≠ absent
  });
});
