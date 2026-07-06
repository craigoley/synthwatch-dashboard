import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";
import { slaResponse, slaRow, defaultChecks, listItem } from "./fixtures";

// Reports: per-monitor report CARDS sourced from the live checks list + SLA (+ optional rollup-report
// enrichment), so a monitor that has data always renders. ★ The old list bound only to /reports/availability
// — which returns empty even when monitors exist — so it showed "No monitors to report on" while the fleet
// summary had data. These tests pin the fix (cards render when the report endpoints are empty/404) and the
// redesign (availability/latency/incidents/narrative per monitor, window toggle).
//
// ★ SUB-TABS: the page is now Performance (default) / Reliability / Monitors. The per-monitor list lives in the
// Monitors tab (?tab=monitors); the fleet CWV/trend in Performance (default); breakdown/SLO/MTTR in Reliability.
const MONITORS = "/reports?tab=monitors";

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

test.describe("reports — per-monitor cards + tag filter (Monitors tab)", () => {
  test("renders a report card for every monitor (sourced from the live checks list)", async ({ page }) => {
    await mockApi(page, world());
    await page.goto(MONITORS);
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
    await page.goto(MONITORS);

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
    await page.goto(MONITORS);
    await expect(page.getByTestId("report-1")).toBeVisible();
    await expect(page.getByTestId("report-1")).toContainText("90.00%");
    await expect(page.getByTestId("reports-pending")).toHaveCount(0); // the old blocker is gone
  });

  test("the filter offers ONLY real in-use tags (never invented dimensions)", async ({ page }) => {
    await mockApi(page, world());
    await page.goto("/reports"); // tag filter is a GLOBAL control (above the tabs) — visible on any tab
    const filter = page.getByTestId("tag-filter");
    await expect(filter.getByRole("checkbox", { name: "filter env:prod" })).toBeVisible();
    await expect(filter.getByRole("checkbox", { name: "filter team:web" })).toBeVisible();
    await expect(filter.getByRole("checkbox")).toHaveCount(2);
  });

  test("tags FILTER the list (not group it) — multi-tag AND", async ({ page }) => {
    await mockApi(page, world());
    await page.goto(MONITORS);
    await expect(page.getByTestId("report-1")).toBeVisible();

    await page.getByRole("checkbox", { name: "filter team:web" }).click();
    await expect(page.getByTestId("report-2")).toBeVisible(); // has team:web
    await expect(page.getByTestId("report-1")).toHaveCount(0); // only env:prod → filtered out
    await expect(page.getByTestId("filter-result")).toContainText(/1 of \d+ monitors/);
  });

  test("sortable: availability vs name reorder the cards", async ({ page }) => {
    await mockApi(page, world());
    await page.goto(MONITORS);
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
    await page.goto(MONITORS);

    // browser monitor (check 2) → expand → vitals panel with LCP, no INP
    await page.getByTestId("report-toggle-2").click();
    await expect(page.getByTestId("detail-2")).toBeVisible();
    await expect(page.getByTestId("vitals-2")).toContainText("LCP");
    await expect(page.getByTestId("vitals-2")).toContainText("1.80s");
    await expect(page.getByTestId("errors-2")).toBeVisible();
    await expect(page.getByTestId("detail-2").getByText("INP", { exact: false })).toHaveCount(0);

    // http monitor (check 1) → NO web-vitals section
    await page.getByTestId("report-toggle-1").click();
    await expect(page.getByTestId("detail-1")).toBeVisible();
    await expect(page.getByTestId("vitals-1")).toHaveCount(0);
    await expect(page.getByTestId("errors-1")).toBeVisible();
  });

  // ★ Regression: sorting by Incidents must actually REORDER the cards. It was a guaranteed no-op because
  // the api-client read the wrong report field (`incidentCount` vs the API's `incidentsOpened`) → every
  // monitor's incident count was 0 → all ties → order never changed. (The old mock served `incidentCount`,
  // matching the buggy read, so the test suite never caught it — the same stale-mock divergence.)
  test("★ sorting by Incidents reorders the cards (was a no-op: wrong incident field)", async ({ page }) => {
    const w = defaultWorld();
    // 3 monitors whose availability order ≠ incidents order, so an Incidents sort is observably different:
    //   availPct(id)=100-((id*7)%28)*0.9 → id3=81.1, id1=93.7, id4=100  (avail asc → 3,1,4)
    //   incidentsOpened=id%5            → id4=4, id3=3, id1=1            (inc desc → 4,3,1)
    w.checks = defaultChecks().filter((c) => [1, 3, 4].includes(Number(c.id)));
    await mockApi(page, w);
    await page.goto(MONITORS);

    const order = () =>
      page.locator('[data-testid="monitor-list"] > section').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));

    // default sort = availability asc
    await expect.poll(order).toEqual(["report-3", "report-1", "report-4"]);
    // sort by Incidents (first click → desc): highest incidentsOpened first — a DIFFERENT order
    await page.getByTestId("sort-incidents").click();
    await expect.poll(order).toEqual(["report-4", "report-3", "report-1"]);
  });
});

// ★ Tier-1 P1/P2: render the perf-report data the page already fetches but previously dropped — the FLEET
// Core Web Vitals (p75) card + the fleet availability/avg-latency trends (groups[0].web_vitals + .series).
// These live in the Performance tab (the default — no ?tab= param needed).
test.describe("reports — fleet CWV + trend (P1/P2, Performance tab)", () => {
  test("fleet Core Web Vitals (p75) card renders LCP/CLS/FCP/TTFB + INP + resource count (P9 Stage 3)", async ({ page }) => {
    await mockApi(page, world());
    await page.goto("/reports");

    const cwv = page.getByTestId("report-cwv");
    await expect(cwv).toBeVisible();
    await expect(cwv).toContainText("Core Web Vitals");
    await expect(cwv).toContainText("LCP");
    await expect(cwv).toContainText("CLS");
    await expect(cwv).toContainText("FCP");
    await expect(cwv).toContainText("TTFB");
    // ★ INP now aggregated (Stage 3): a real value, over its own (partial) sample size — not a placeholder.
    const inp = page.getByTestId("report-cwv-inp");
    await expect(inp).toContainText("INP");
    await expect(inp).toContainText("150ms");
    await expect(inp).toContainText("104 of 200 runs"); // its own INP sample size, honestly (inpCount < sampleCount)
    // resource count tile renders (supporting metric)
    await expect(page.getByTestId("report-cwv-res")).toContainText("48");
  });

  // ★ The no-fake-zero honesty test: INP is ~half-null. A rollup with NO INP must render "no interaction data",
  // NEVER "0ms" (a fabricated-good CWV). Doubles as the Stage-2-not-deployed self-degrade (fields absent → null).
  test("★ null INP → 'no interaction data' honestly, NOT a fake 0ms", async ({ page }) => {
    const w = world();
    w.vitalsNoInp = true; // webVitals present, but inpP75Ms/inpCount absent
    await mockApi(page, w);
    await page.goto("/reports");

    const inp = page.getByTestId("report-cwv-inp");
    await expect(inp).toContainText("INP");
    await expect(inp).toContainText("no interaction data");
    await expect(inp).toContainText("—"); // the honest gap glyph
    await expect(inp).not.toContainText("0ms"); // ★ never a fabricated green zero
    await expect(inp).not.toContainText("0.0"); // nor any fake numeric INP
    // the other vitals still render (self-degrade is INP-only)
    await expect(page.getByTestId("report-cwv")).toContainText("LCP");
  });

  test("fleet trend renders from the report series (availability + avg latency)", async ({ page }) => {
    await mockApi(page, world());
    await page.goto("/reports");

    const trend = page.getByTestId("report-fleet-trend");
    await expect(trend).toBeVisible();
    await expect(trend).toContainText("Fleet availability");
    await expect(trend).toContainText("Fleet avg latency");
  });

  test("no CWV card when there are no browser monitors (honest absence, not a zero)", async ({ page }) => {
    const w = world();
    w.checks = w.checks.filter((c) => c.kind !== "browser"); // http-only fleet → no web vitals
    await mockApi(page, w);
    await page.goto("/reports");

    await expect(page.getByTestId("reports-panel-performance")).toBeVisible(); // the tab still renders
    await expect(page.getByTestId("report-cwv")).toHaveCount(0); // but no vitals card (none captured)
  });
});

// ★ Tier-1 P3: cert-expiry runway — the SSL last_cert_days_remaining already on each check, dropped from
// ReportRow until now. A badge + an "expiring soonest" sort. gaps-not-zeros: non-cert checks show nothing.
// Lives in the Monitors tab (it's a per-monitor-list column).
test.describe("reports — cert runway (P3, Monitors tab)", () => {
  test("SSL monitor shows a cert-runway badge; non-cert monitors show none (gaps-not-zeros)", async ({ page }) => {
    await mockApi(page, defaultWorld()); // check 3 = "TLS cert" (ssl), lastCertDaysRemaining 12
    await page.goto(MONITORS);

    const cert = page.getByTestId("report-3").getByTestId("cert-runway");
    await expect(cert).toBeVisible();
    await expect(cert).toContainText("cert 12d"); // 12 <= 30 (check 3's cert_expiry_warn_days) → warn tone
    // a non-cert check (id 1, http) renders NO cert badge — absence, never a misleading "0 days"
    await expect(page.getByTestId("report-1").getByTestId("cert-runway")).toHaveCount(0);
  });

  test("'Cert expiry' sort surfaces cert monitors soonest-first (nulls-last)", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto(MONITORS);

    await page.getByTestId("sort-cert_days").click();
    // the only cert check (report-3) sorts ABOVE the non-cert (null) checks, which fall to the bottom
    const cb = await page.getByTestId("report-3").boundingBox();
    const nb = await page.getByTestId("report-1").boundingBox();
    expect(cb!.y).toBeLessThan(nb!.y);
  });

  // ★ Cert-threshold divergence (the #175/#177 false-green class): the runner warns + emails when a cert has
  // <= the per-check `cert_expiry_warn_days` (default 30) days remaining. The badge must warn EXACTLY then —
  // reading the check's own warn_days, never a hardcoded number — so the dashboard never shows green while the
  // runner already knows the cert is expiring. (Verified live: check 10 warned at 29-30d on 2026-06-23, which
  // the old hardcoded-14d badge would have rendered green.)
  //
  // MUST-GO-RED: with the old `days < 14` hardcoded threshold, the 20d/warn-30 cert below renders "pass" (green)
  // — this test reds. It only passes when the badge reads the per-check cert_expiry_warn_days.
  test("cert badge warns exactly when the runner does — reads per-check cert_expiry_warn_days, not a hardcoded 14", async ({ page }) => {
    const w = defaultWorld();
    // Four SSL monitors that isolate the threshold logic:
    w.checks = [
      // ~20d out, default warn window (30): runner has WARNED → badge must be warn, NOT the old hardcoded-14 green.
      listItem({ id: 40, name: "cert 20d / warn 30", kind: "ssl", currentStatus: "warn", certExpiryWarnDays: 30, lastCertDaysRemaining: 20 }),
      // one day inside the window (warn_days - 1 = 29): warn.
      listItem({ id: 41, name: "cert 29d / warn 30", kind: "ssl", currentStatus: "warn", certExpiryWarnDays: 30, lastCertDaysRemaining: 29 }),
      // well outside the window (90d): healthy → pass (honest green — the runner is green here too).
      listItem({ id: 42, name: "cert 90d / warn 30", kind: "ssl", currentStatus: "pass", certExpiryWarnDays: 30, lastCertDaysRemaining: 90 }),
      // SAME 20d, but a CUSTOM narrow warn_days of 10: outside its window → pass. Same day count, opposite tone
      // as #40 — only possible if the badge reads the PER-CHECK value (a hardcoded threshold would tie them).
      listItem({ id: 43, name: "cert 20d / warn 10", kind: "ssl", currentStatus: "pass", certExpiryWarnDays: 10, lastCertDaysRemaining: 20 }),
    ];
    await mockApi(page, w);
    await page.goto(MONITORS);

    const tone = (id: number) => page.getByTestId(`report-${id}`).getByTestId("cert-runway");

    // ~20d out with the default 30d warn window → WARN (the divergence the runner already flagged; old code: green).
    await expect(tone(40)).toHaveAttribute("data-tone", "warn");
    // warn_days - 1 (29d) → warn.
    await expect(tone(41)).toHaveAttribute("data-tone", "warn");
    // 90d out → healthy pass.
    await expect(tone(42)).toHaveAttribute("data-tone", "pass");
    // ★ same 20d but warn_days=10 → pass: proves the badge respects the per-check value, not any fixed number.
    await expect(tone(43)).toHaveAttribute("data-tone", "pass");
  });
});

// ★ Tag-scoped aggregates: the report tiles (CWV / fleet trend / verdict-breakdown) honor the SAME tag filter
// as the monitor list (server-scoped via ?tag=), with a loud scope banner so a subset number is never read as
// the fleet's — and honest-empty (no fake 0%) when a tag has no matching monitors. The banner is GLOBAL; CWV is
// Performance; the verdict-breakdown moved to the Reliability tab.
test.describe("reports — tag-scoped aggregates", () => {
  test("a tag filter scopes the tiles + shows a scope banner (obvious subset)", async ({ page }) => {
    await mockApi(page, world());
    await page.goto("/reports?tags=team:web"); // only check 2 (browser) carries team:web

    const banner = page.getByTestId("report-scope-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("team:web");
    await expect(banner).toContainText("1 of"); // 1 of N monitors — the subset is explicit
    // Performance tab: the CWV tile still renders, now scoped (check 2 is browser).
    await expect(page.getByTestId("report-cwv")).toBeVisible();
    // Reliability tab: the verdict-breakdown card, also scoped.
    await page.getByTestId("reports-tab-reliability").click();
    await expect(page.getByText("Alert quality — were the reds real?")).toBeVisible();
  });

  test("a tag with no matching monitors → honest empty (no fake 0%), banner shows 0", async ({ page }) => {
    await mockApi(page, world());
    await page.goto("/reports?tags=team:none");

    await expect(page.getByTestId("report-scope-banner")).toContainText("0 of");
    // Performance tab: the aggregate tiles vanish (no data) rather than showing a fabricated number…
    await expect(page.getByTestId("report-cwv")).toHaveCount(0);
    await expect(page.getByTestId("report-fleet-trend")).toHaveCount(0);
    // …and on Reliability the verdict-breakdown reads "nothing to grade" (precision null), never "0% real".
    await page.getByTestId("reports-tab-reliability").click();
    await expect(page.getByText(/nothing to grade/i)).toBeVisible();
  });

  test("no tag filter → no scope banner (whole-fleet, unchanged)", async ({ page }) => {
    await mockApi(page, world());
    await page.goto("/reports");
    await expect(page.getByTestId("report-scope-banner")).toHaveCount(0);
  });
});

// ★ #P4: group-by a tag KEY — per-team / per-application reporting. The API groups server-side (one group per
// tag value); the UI renders one section per value (each with its own CWV/trend + bucketed cards). URL-synced,
// composes with the tag filter. Group-by is now a MONITORS-TAB control; it still suppresses the Performance
// tab's fleet CWV/trend when active.
test.describe("reports — group by tag key (Monitors tab)", () => {
  function groupedWorld() {
    const w = world(); // check 1 = env:prod, check 2 = env:prod + team:web
    // give check 1 a team too so grouping by team yields TWO values (platform + web).
    w.checks = w.checks.map((c) =>
      c.id === 1 ? { ...c, tags: [{ key: "env", value: "prod" }, { key: "team", value: "platform" }] } : c,
    );
    w.tags = [
      { key: "env", value: "prod", count: 2 },
      { key: "team", value: "platform", count: 1 },
      { key: "team", value: "web", count: 1 },
    ];
    return w;
  }

  test("default (no group-by) → single aggregate, no group sections", async ({ page }) => {
    await mockApi(page, groupedWorld());
    await page.goto(MONITORS);

    await expect(page.getByTestId("group-by-select")).toBeVisible(); // the control lives in the Monitors tab
    await expect(page.locator('[data-testid^="group-section-"]')).toHaveCount(0); // no grouping
    // the fleet aggregate lives on the Performance tab (present when ungrouped)
    await page.getByTestId("reports-tab-performance").click();
    await expect(page.getByTestId("report-fleet-trend")).toBeVisible();
  });

  test("group by team → one section per value, headers + cards bucketed; fleet aggregate hidden", async ({ page }) => {
    await mockApi(page, groupedWorld());
    await page.goto("/reports?tab=monitors&groupBy=team"); // ★ URL restores the tab + grouping

    await expect(page.getByTestId("group-by-select")).toHaveValue("team");
    const platform = page.getByTestId("group-section-platform");
    const web = page.getByTestId("group-section-web");
    await expect(platform).toBeVisible();
    await expect(web).toBeVisible();
    await expect(platform).toContainText("team"); // header shows the key…
    await expect(platform).toContainText("platform"); // …and the value
    // ★ cards bucketed by tag value: check 1 under platform, check 2 under web
    await expect(platform.getByTestId("report-1")).toBeVisible();
    await expect(web.getByTestId("report-2")).toBeVisible();
    // ★ the fleet aggregate is HIDDEN when grouped (groups[0] is a tag value, not the fleet)
    await page.getByTestId("reports-tab-performance").click();
    await expect(page.getByTestId("report-fleet-trend")).toHaveCount(0);
  });

  test("group-by composes with a tag filter (scope banner still shows)", async ({ page }) => {
    await mockApi(page, groupedWorld());
    await page.goto("/reports?tab=monitors&tags=env:prod&groupBy=team");

    await expect(page.getByTestId("report-scope-banner")).toBeVisible(); // filter still scoped + loud (global bar)
    await expect(page.getByTestId("group-section-web")).toBeVisible(); // …and still bucketed by team
  });

  test("selecting a key in the dropdown URL-syncs ?groupBy=", async ({ page }) => {
    await mockApi(page, groupedWorld());
    await page.goto(MONITORS);

    await page.getByTestId("group-by-select").selectOption("team");
    await expect(page).toHaveURL(/[?&]groupBy=team/);
    await expect(page.getByTestId("group-section-web")).toBeVisible();
  });
});
