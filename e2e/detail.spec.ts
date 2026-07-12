import { readFileSync } from "node:fs";

import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";
import { slaResponse, slaRow, run, detail } from "./fixtures";

test.describe("check detail", () => {
  test("SLA: the 90d window toggle is present and renders its value", async ({ page }) => {
    const world = defaultWorld();
    world.slaByWindow = {
      "90d": slaResponse("90d", [slaRow({ checkId: 1, availabilityPct: 99.9, insufficientData: false })]),
    };
    await mockApi(page, world);
    await page.goto("/checks/1");

    // scope to the SLA panel (the availability chart also has a 90d toggle)
    const sla = page.locator(".sw-panel", { hasText: "Availability (SLA)" });
    await expect(sla.getByRole("button", { name: "90d", exact: true })).toBeVisible();
    // its value renders (the other windows are empty → this 99.90% is the 90d card)
    await expect(sla.getByText("99.90%")).toBeVisible();
  });

  test("SLA: a thin 90d window reads 'building baseline'", async ({ page }) => {
    const world = defaultWorld();
    world.slaByWindow = {
      "90d": slaResponse("90d", [slaRow({ checkId: 1, availabilityPct: null, insufficientData: true })]),
    };
    await mockApi(page, world);
    await page.goto("/checks/1");

    const sla = page.locator(".sw-panel", { hasText: "Availability (SLA)" });
    await expect(sla.getByRole("button", { name: "90d", exact: true })).toBeVisible();
    await expect(sla.getByText(/building baseline/i).first()).toBeVisible();
  });

  test("availability: over-time chart renders with a null gap (not a 0 dip)", async ({ page }) => {
    await mockApi(page); // default world serves a series with a dip + a null bucket
    await page.goto("/checks/1");

    const card = page.locator(".sw-panel", { hasText: "Availability over time" });
    await expect(card.getByRole("heading", { name: "Availability over time" })).toBeVisible();
    await page.waitForTimeout(500); // let recharts paint

    // the line renders
    const line = card.locator(".recharts-line-curve").first();
    await expect(line).toBeVisible();

    // ★ null bucket → a GAP: connectNulls=false breaks the path into >1 segment (M cmd).
    // A 0% dip (or connectNulls) would be a single continuous path (one M).
    const segments = await line.evaluate((el) => (el.getAttribute("d")?.match(/M/g) || []).length);
    expect(segments).toBeGreaterThan(1);
  });

  test("availability: its own window toggle switches and re-renders", async ({ page }) => {
    await mockApi(page);
    await page.goto("/checks/1");
    const card = page.locator(".sw-panel", { hasText: "Availability over time" });
    await card.getByRole("button", { name: "90d", exact: true }).click();
    await page.waitForTimeout(400);
    await expect(card.locator(".recharts-line-curve").first()).toBeVisible();
  });

  test("availability: empty series shows a graceful empty state (no crash)", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const world = defaultWorld();
    world.availability = null; // no series
    await mockApi(page, world);
    await page.goto("/checks/1");

    const card = page.locator(".sw-panel", { hasText: "Availability over time" });
    await expect(card.getByText(/no availability data/i)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("multistep: shows the step chain + flags the failed step", async ({ page }) => {
    await mockApi(page);
    await page.goto("/checks/7");

    await expect(page.getByRole("heading", { name: "Step chain" })).toBeVisible();
    await expect(page.getByText("login", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("verify", { exact: false }).first()).toBeVisible();
    // the latest run failed at "verify" — the chain flags it
    await expect(page.getByText("✕ failed here")).toBeVisible();
  });

  test("browser failure: screenshot renders via the proxy + trace download/view", async ({ page }) => {
    await mockApi(page);
    await page.goto("/checks/2");

    const img = page.locator('img[alt="Failure screenshot for run 200"]');
    await expect(img).toBeVisible();
    // ★ SAME-ORIGIN: the screenshot loads through the dashboard's own /screenshot-proxy (cookie→bearer,
    // the /trace-proxy sibling) — never the raw bearer-gated API endpoint, which 401s even signed-in.
    await expect(img).toHaveAttribute("src", "/screenshot-proxy/200");
    // the proxy served a real PNG → it decoded
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBeGreaterThan(0);
    // download (mints a SAS on click) + the in-app "View trace" affordance both present
    await expect(page.getByRole("button", { name: /Download/ })).toBeVisible();
    await expect(page.getByTestId("view-trace-200")).toBeVisible();
  });

  // ★ Phase 10: embed the self-hosted Playwright trace viewer for failed runs.
  test("embeds the trace viewer in-app (forensics), pointed at the direct SAS blob URL", async ({ page }) => {
    await mockApi(page);
    await page.goto("/checks/2");

    // hidden until opened
    await expect(page.getByTestId("trace-viewer-200")).toHaveCount(0);
    await page.getByTestId("view-trace-200").click();

    const viewer = page.getByTestId("trace-viewer-200");
    await expect(viewer).toBeVisible();
    const src = await viewer.getAttribute("src");
    const decoded = decodeURIComponent(src ?? "");
    expect(src).toContain("/trace-viewer/index.html?trace=");
    // ★ DIRECT SAS: the viewer fetches the blob DIRECTLY via the short-TTL read-only SAS URL the API minted
    // (off the Vercel proxy that can't stream 124MB). CORS is solved because auth lives IN the SAS URL.
    expect(decoded).toContain("traces/run-200.zip"); // the run-200 trace blob
    expect(decoded).toContain("sp=r"); // read-only SAS
    expect(decoded).not.toContain("mock.synthwatch.test"); // not the API origin

    // the vendored viewer bundle is served on-domain
    expect((await page.request.get("/trace-viewer/index.html")).status()).toBe(200);
    // ★ the trace proxy route is GONE — full cutover to SAS (one path for all sizes; no serverless size trap).
    expect((await page.request.get("/trace-proxy/200")).status()).toBe(404);
  });

  // ★ Resilience patch (scripts/vendor-trace-viewer.mjs): the vendored viewer must SKIP an
  // unparseable NDJSON line instead of failing the whole load with the opaque "Could not load
  // trace". A sensitive-monitor REDACTED trace can carry exactly one such line (runner
  // traceRedact.ts non-escape-aware header scrub) — the zip is valid + downloadable but wouldn't
  // render inline without this. Guards against a `node scripts/vendor-trace-viewer.mjs` re-vendor
  // being committed with the patch dropped (the vendor script itself exits non-zero if the target
  // codegen moved; this pins that the committed bundle actually carries the patch).
  test("the vendored trace-viewer bundle carries the skip-unparseable-line resilience patch", () => {
    const sw = readFileSync("public/trace-viewer/sw.bundle.js", "utf8");
    // the resilient form is present …
    expect(sw).toContain("skipped an unparseable trace line");
    // … and the original throw-on-any-line form is gone (a bare JSON.parse feeding _modernize).
    expect(sw).not.toContain("const e=this._modernize(JSON.parse(t));for(const n of e)");
  });

  // ★ The vendored viewer forces html,body{min-width:550px;min-height:450px;overflow:auto}, so an embed
  // shorter than 450px makes IT render a scrollbar (which can cascade a second one). On a short viewport
  // h-[70vh] would be 420px (< 450) — the min-h floor must keep the embed above Playwright's minimum so it
  // fills the panel cleanly instead of double-scrolling.
  test("the trace embed stays above Playwright's 450px min-height on a short viewport", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 600 }); // 70vh = 420px < the viewer's 450px floor
    await mockApi(page);
    await page.goto("/checks/2");
    await page.getByTestId("view-trace-200").click();

    const box = await page.getByTestId("trace-viewer-200").boundingBox();
    expect(box, "trace iframe is laid out").toBeTruthy();
    expect(box!.height).toBeGreaterThanOrEqual(450); // floored above the viewer's min-height, not 420
  });

  test("a passing run shows no trace affordance (no trace captured)", async ({ page }) => {
    await mockApi(page);
    await page.goto("/checks/1"); // http, passing run (no trace_url)
    await expect(page.getByTestId("view-trace-100")).toHaveCount(0);
  });

  // ★ Mobile containment: a long target_url must truncate INSIDE the header, never force horizontal page
  // scroll. The trap was flex min-width:auto — the URL <a> (and its wrapper div, both flex items) refused
  // to shrink below the nowrap URL's full width, so its `truncate` never engaged and the page scrolled
  // sideways at phone widths. min-w-0 on both is the fix; this pins it (page overflow was 578px before).
  test("mobile (390px): a long target_url truncates — no horizontal page scroll", async ({ page }) => {
    const LONG_URL =
      "https://wegapi.azure-api.net/kitting/stores/16/storefronts/1/menus?catering=true&radius=standard&api-version=2021-02-01";
    await page.setViewportSize({ width: 390, height: 844 });
    const w = defaultWorld();
    w.details[1] = detail({ id: 1, name: "Long URL check", targetUrl: LONG_URL });
    await mockApi(page, w);
    await page.goto("/checks/1");
    await expect(page.getByRole("heading", { name: "Long URL check" })).toBeVisible();

    // the URL renders (accessible name is the full text; visually ellipsized) and stays inside the viewport
    const url = page.getByRole("link", { name: LONG_URL });
    await expect(url).toBeVisible();
    await expect(url).toHaveAttribute("title", LONG_URL); // full URL still reachable on hover
    const box = await url.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);

    // the must-not-regress guard: the page itself has NO horizontal overflow
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
  });

  test("ssl: shows the TLS certificate panel", async ({ page }) => {
    await mockApi(page);
    await page.goto("/checks/3");
    await expect(page.getByRole("heading", { name: "TLS certificate" })).toBeVisible();
  });

  test("dns: shows the network result", async ({ page }) => {
    await mockApi(page);
    await page.goto("/checks/4");
    await expect(page.getByRole("heading", { name: "DNS resolution" })).toBeVisible();
    await expect(page.getByText("A example.com: 93.184.216.34").first()).toBeVisible();
  });

  test("multi-location: shows the per-location panel with a regional verdict", async ({ page }) => {
    await mockApi(page);
    await page.goto("/checks/10");

    // Scope location names to the per-location panel — the run-history below now
    // auto-expands the newest run (the westus2 failure), whose error also names the region.
    const byLocation = page.locator(".sw-panel", { hasText: "By location" });
    await expect(byLocation.getByRole("heading", { name: "By location" })).toBeVisible();
    await expect(byLocation.getByText("eastus2")).toBeVisible();
    await expect(byLocation.getByText("westus2")).toBeVisible();
    // partial failure → "regional", visually distinct from a global outage
    await expect(page.getByText(/Regional — 1\/2 locations failing/)).toBeVisible();
  });

  // ★ #47 — a pass+warn mix (no fail/error) must read as DEGRADED, not the green
  // "Healthy in all locations" that contradicted the amber per-location badge.
  test("multi-location: a warn location reads as 'degraded', not healthy", async ({ page }) => {
    await mockApi(page);
    await page.goto("/checks/14");

    await expect(page.getByRole("heading", { name: "By location" })).toBeVisible();
    await expect(page.getByText(/Degraded — 1\/2 location degraded/)).toBeVisible();
    await expect(page.getByText(/Healthy in all locations/)).toHaveCount(0);
  });

  test("single-location: NO per-location panel (no regression)", async ({ page }) => {
    await mockApi(page);
    await page.goto("/checks/1"); // only "default"
    await expect(page.getByRole("heading", { name: "By location" })).toHaveCount(0);
  });

  // ★ Per-location → run link: each "By location" row links to THAT location's latest run, which expands in
  // the history list below. The failing location → its failing run (what you want to troubleshoot).
  test("per-location row links to that location's latest run (regional fail → its failing run)", async ({ page }) => {
    await mockApi(page);
    await page.goto("/checks/10"); // eastus2 pass (run 1001), westus2 fail (run 1002)

    const byLocation = page.locator(".sw-panel", { hasText: "By location" });
    await expect(byLocation.getByTestId("location-run-westus2")).toHaveAttribute("href", "#run-1002"); // FAIL run
    await expect(byLocation.getByTestId("location-run-eastus2")).toHaveAttribute("href", "#run-1001"); // PASS run

    // clicking the failing location expands ITS run in the history below (not the default newest)
    await byLocation.getByTestId("location-run-westus2").click();
    await expect(page.getByText("Funnel · run #1002")).toBeVisible();
  });

  test("★ a failing browser location → its failing run with the trace + Get AI insights reachable", async ({ page }) => {
    const w = defaultWorld();
    // a browser check across two locations; the failing (westus2) run HAS a trace → trace + AI insights.
    w.details[2] = detail(
      { id: 2, name: "Homepage flow", kind: "browser", flowName: "homepage-load", currentStatus: "fail" },
      [
        run({ id: 9001, checkId: 2, status: "pass", location: "eastus2" }),
        run({ id: 9002, checkId: 2, status: "fail", location: "westus2", errorMessage: "nav failed in westus2", traceUrl: "/api/runs/9002/trace" }),
      ],
    );
    await mockApi(page, w);
    await page.goto("/checks/2");

    await page.getByTestId("location-run-westus2").click();
    await expect(page.getByText("Funnel · run #9002")).toBeVisible();
    // the failing run's forensics are reachable from the location row: the trace embed + Get AI insights
    await expect(page.getByTestId("view-trace-9002")).toBeVisible();
    await expect(page.getByTestId("get-ai-insights-9002")).toBeVisible();
  });

  test("SLO: shows the error-budget + burn state when an SLO is set", async ({ page }) => {
    await mockApi(page);
    await page.goto("/checks/12");

    await expect(page.getByRole("heading", { name: "Error budget (SLO)" })).toBeVisible();
    await expect(page.getByText(/99\.90% target/)).toBeVisible();
    await expect(page.getByText(/budget remaining/i)).toBeVisible();
    await expect(page.getByText(/15\.0× burn rate/)).toBeVisible();
    await expect(page.getByText(/Fast burn \(1h\): firing/i)).toBeVisible();
    await expect(page.getByText(/Slow burn \(6h\): ok/i)).toBeVisible();
  });

  test("SLO: an exhausted budget reads as blown", async ({ page }) => {
    await mockApi(page);
    await page.goto("/checks/13");

    await expect(page.getByText("Budget blown")).toBeVisible();
    await expect(page.getByText(/over budget/i)).toBeVisible();
  });

  test("SLO: no panel when the check has no SLO (opt-in)", async ({ page }) => {
    await mockApi(page);
    await page.goto("/checks/1"); // slo null
    await expect(page.getByRole("heading", { name: "Error budget (SLO)" })).toHaveCount(0);
  });

  test("no runs yet: degrades gracefully (no crash)", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await mockApi(page);
    await page.goto("/checks/9");

    await expect(page.getByText(/No runs recorded yet/i)).toBeVisible();
    expect(errors).toEqual([]);
  });

  // ★ Live run status: an in-flight run transitions running→done on the page via SCOPED fast polling — no
  // manual refresh. The mock serves a running detail first, then the terminal one on the next poll.
  test("live: an in-flight run shows 'Running' then its terminal status via polling (no reload)", async ({ page }) => {
    const w = defaultWorld();
    w.detailSequence = {
      1: [
        detail({ id: 1, name: "API health", kind: "http", currentStatus: "running" },
          [run({ id: 5000, checkId: 1, status: "running", finishedAt: null, durationMs: null, httpStatus: null })]),
        detail({ id: 1, name: "API health", kind: "http", currentStatus: "pass" },
          [run({ id: 5000, checkId: 1, status: "pass" })]),
      ],
    };
    await mockApi(page, w);
    await page.goto("/checks/1");

    // the live indicator shows Running (the runner's in-flight state)…
    await expect(page.getByText("Running", { exact: true })).toBeVisible();
    // …then flips to the terminal verdict via the fast poll — WITHOUT a manual reload.
    await expect(page.getByText("Pass", { exact: true })).toBeVisible();
  });

  test("★ Run now → the run goes Starting → Running → done live (no manual refresh)", async ({ page }) => {
    const w = defaultWorld();
    w.detailSequence = {
      1: [
        detail({ id: 1, name: "API health", kind: "http", currentStatus: "pass" }, [run({ id: 4000, status: "pass" })]), // settled
        detail({ id: 1, name: "API health", kind: "http", currentStatus: "running" },
          [run({ id: 4001, checkId: 1, status: "running", finishedAt: null, durationMs: null, httpStatus: null })]),
        detail({ id: 1, name: "API health", kind: "http", currentStatus: "pass" }, [run({ id: 4001, status: "pass" })]),
      ],
    };
    await mockApi(page, w); // seeded editor → Run now is visible
    await page.goto("/checks/1");

    const runNow = page.getByTestId("run-now");
    await expect(runNow).toHaveText("Run now"); // settled
    await runNow.click(); // triggers + activates the scoped fast poll (expectRun)

    // the run is caught live: the header shows Running, then settles back to Pass — no reload
    await expect(page.getByText("Running", { exact: true })).toBeVisible();
    await expect(page.getByText("Pass", { exact: true })).toBeVisible();
    await expect(runNow).toHaveText("Run now"); // poll settled → button re-enabled
  });

  // ★ The fix: the run-history LIST + the per-run TRACE ride the SAME poll-while-running lifecycle as the
  // badge — so a completed run's row + its trace appear WITHOUT a manual reload (the list was previously on
  // a static interval with revalidateFirstPage:false, so page 0 — the new run — never refreshed).
  test("live: a completed run's row + trace appear in the run history without a reload", async ({ page }) => {
    const w = defaultWorld();
    const runningRun = run({ id: 7000, checkId: 1, status: "running", finishedAt: null, durationMs: null, httpStatus: null, traceUrl: null });
    const doneRun = run({ id: 7000, checkId: 1, status: "fail", errorMessage: "boom", traceUrl: "/api/runs/7000/trace" });
    // badge (useCheck) goes running→fail; the list (useRunHistory) goes running → completed+trace.
    w.detailSequence = {
      1: [
        detail({ id: 1, name: "API health", kind: "http", currentStatus: "running" }, [runningRun]),
        detail({ id: 1, name: "API health", kind: "http", currentStatus: "fail" }, [doneRun]),
      ],
    };
    w.runsSequence = { 1: [[runningRun], [doneRun]] };
    await mockApi(page, w);
    await page.goto("/checks/1");

    // the run is in-flight (puts the list on the fast lifecycle)…
    await expect(page.getByText("Running", { exact: true })).toBeVisible();
    // …then the completed run's TRACE affordance shows up in the history list — via polling, no manual reload.
    await expect(page.getByTestId("view-trace-7000")).toBeVisible();
  });

  // ★ Craig's exact "Run now" case: the list is ALREADY populated with historical runs, then a BRAND-NEW run
  // is prepended to page 0 by the poll. This is the strongest page-0 assertion (the prior test started from a
  // near-empty list). It rides revalidateFirstPage:true — if page 0 were skipped on the tick the fresh run
  // would never appear (only after a hard reload), which is the reported symptom.
  test("live: a NEW run appears at the TOP of an already-populated run-history list via the poll (no reload)", async ({ page }) => {
    const w = defaultWorld();
    const r100 = run({ id: 100, checkId: 1, status: "pass" });
    const r99 = run({ id: 99, checkId: 1, status: "pass" });
    const freshRunning = run({ id: 9999, checkId: 1, status: "running", finishedAt: null, durationMs: null, httpStatus: null, traceUrl: null });
    const freshDone = run({ id: 9999, checkId: 1, status: "fail", errorMessage: "fresh failure", traceUrl: "/api/runs/9999/trace" });
    // The page derives the live state from recent_runs[0].status — so the badge carries the RUNNING fresh run
    // for runLive to engage and the list to fast-poll (running → fail, plus the post-terminal settle window).
    w.detailSequence = {
      1: [
        detail({ id: 1, name: "API health", kind: "http", currentStatus: "running" }, [freshRunning, r100, r99]),
        detail({ id: 1, name: "API health", kind: "http", currentStatus: "fail" }, [freshDone, r100, r99]),
      ],
    };
    // page 0 starts populated (r100, r99); the poll PREPENDS the brand-new completed run — the "Run now" flow.
    w.runsSequence = { 1: [[r100, r99], [freshDone, r100, r99]] };
    await mockApi(page, w);
    await page.goto("/checks/1");

    // populated, but the fresh run is not there yet
    await expect(page.getByTestId("run-history")).toBeVisible();
    await expect(page.getByTestId("view-trace-9999")).toHaveCount(0);

    // ★ the fresh run appears at the TOP of the populated page-0 list via the poll — WITHOUT a reload (rides
    //    revalidateFirstPage:true; if page 0 were skipped it would never show, the reported symptom).
    await expect(page.getByTestId("run-row").first()).toHaveAttribute("id", "run-9999", { timeout: 15000 });
    await expect(page.getByTestId("view-trace-9999")).toBeVisible({ timeout: 15000 });
  });

  // ★ The metrics ("Telemetry") section is collapsible, and the preference persists APP-WIDE — collapse it on
  // one monitor and every monitor opens collapsed, surviving reloads (check-id-agnostic localStorage key).
  test("metrics section: collapse persists across monitors AND reloads (app-wide), default expanded", async ({ page }) => {
    await mockApi(page);
    await page.goto("/checks/1");

    // default: EXPANDED (nothing stored yet — don't surprise existing users)
    await expect(page.getByTestId("metrics-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("metrics-body")).toBeVisible();

    // ★ the disclosure wraps the WHOLE chart stack — Availability + Latency + Telemetry all inside it
    const body = page.getByTestId("metrics-body");
    await expect(body.getByText("Availability over time")).toBeVisible();
    await expect(body.getByText("Latency over time")).toBeVisible();
    await expect(body.getByRole("heading", { name: "Telemetry" })).toBeVisible();

    // collapse on check 1 → the ENTIRE stack collapses (not just Telemetry); the header stays
    await page.getByTestId("metrics-toggle").click();
    await expect(page.getByTestId("metrics-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("metrics-body")).toHaveCount(0);
    await expect(page.getByText("Availability over time")).toHaveCount(0); // the big charts collapsed too
    await expect(page.getByText("Latency over time")).toHaveCount(0);

    // ★ a DIFFERENT monitor opens collapsed too (the key is not per-check)
    await page.goto("/checks/2");
    await expect(page.getByTestId("metrics-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("metrics-body")).toHaveCount(0);

    // ★ persists across a reload
    await page.reload();
    await expect(page.getByTestId("metrics-toggle")).toHaveAttribute("aria-expanded", "false");

    // re-expand → the preference flips back app-wide
    await page.getByTestId("metrics-toggle").click();
    await expect(page.getByTestId("metrics-body")).toBeVisible();
    await page.goto("/checks/1");
    await expect(page.getByTestId("metrics-toggle")).toHaveAttribute("aria-expanded", "true");
  });

  // ★ Run-history "updating…" affordance: while a run is in-flight the list is fast-polling — show it so the
  // short wait reads as ACTIVE, not stuck. Hidden when idle.
  test("run history shows an 'updating…' live indicator only while a run is in-flight", async ({ page }) => {
    // idle check → no live indicator
    await mockApi(page);
    await page.goto("/checks/1");
    await expect(page.getByTestId("run-history")).toBeVisible();
    await expect(page.getByTestId("run-history-live")).toHaveCount(0);

    // an in-flight run → the indicator appears (run is 'running' → runLive → list fast-polls)
    const w = defaultWorld();
    w.detailSequence = {
      1: [
        detail({ id: 1, name: "API health", kind: "http", currentStatus: "running" },
          [run({ id: 8000, checkId: 1, status: "running", finishedAt: null, durationMs: null, httpStatus: null })]),
      ],
    };
    await mockApi(page, w);
    await page.goto("/checks/1");
    await expect(page.getByTestId("run-history-live")).toBeVisible();
    await expect(page.getByTestId("run-history-live")).toContainText("updating");
  });

  // ★ Gated diagnostics: the [runs-debug] funnel is OFF for normal users and ON with ?debug=runs (or
  // localStorage.SYNTHWATCH_DEBUG='1'). Lets the user capture the fetch→merge→render→expand funnel in
  // DevTools during a Run-now to pinpoint where a new run falls out — with zero behavior change when off.
  test("debug funnel: [runs-debug] telemetry is gated — silent by default, emits with ?debug=runs", async ({ page }) => {
    await mockApi(page);
    const logs: string[] = [];
    page.on("console", (m) => {
      if (m.text().includes("[runs-debug]")) logs.push(m.text());
    });

    // OFF by default — no funnel noise for normal users
    await page.goto("/checks/1");
    await expect(page.getByTestId("run-history")).toBeVisible();
    await page.waitForTimeout(700);
    expect(logs, "no [runs-debug] logs without the flag").toEqual([]);

    // ON with ?debug=runs — the funnel emits its stages
    await page.goto("/checks/1?debug=runs");
    await expect(page.getByTestId("run-history")).toBeVisible();
    await page.waitForTimeout(900);
    expect(logs.length, "funnel emits with ?debug=runs").toBeGreaterThan(0);
    expect(logs.some((l) => l.includes("post-merge → render")), "render stage present").toBe(true);
    expect(
      logs.some((l) => l.includes("page-0 fetch") || l.includes("poll-tick")),
      "engine stage (fetch/poll) present",
    ).toBe(true);
    // ★ the raw-HTTP ground-truth line (status + cache headers + a monotonic real-fetch seq) emits too
    expect(
      logs.some((l) => l.includes("request ←") && l.includes("status=")),
      "raw-HTTP fetch line present",
    ).toBe(true);
  });

  // ★ Frozen-`to` root cause: the live run-history window's `to` was Date.now() pinned at mount, so every poll
  // requested [mount-7d, mount) and the API excluded new runs (started_at >= mount) until a reload. The live
  // preset must OMIT `to` (server windows to its own now); a CUSTOM range must still pin `to` (historical).
  test("live run-history omits the `to` window param (so new runs aren't excluded); custom range keeps it", async ({ page }) => {
    await mockApi(page);
    const runsUrls: string[] = [];
    page.on("request", (r) => {
      if (/\/checks\/1\/runs(\?|$)/.test(r.url())) runsUrls.push(r.url());
    });

    await page.goto("/checks/1");
    await expect(page.getByTestId("run-history")).toBeVisible();
    await page.waitForTimeout(600);

    // default preset (Last 7d): `from` is sent (bounded lookback) but `to` is OMITTED → API windows to now
    expect(runsUrls.length, "run-history fetched").toBeGreaterThan(0);
    expect(runsUrls.some((u) => /[?&]from=/.test(u)), "preset keeps from").toBe(true);
    expect(runsUrls.every((u) => !/[?&]to=/.test(u)), "live preset omits to").toBe(true);

    // custom range: `to` IS pinned (a historical window legitimately freezes its upper bound)
    runsUrls.length = 0;
    const rh = page.getByTestId("run-history");
    await rh.getByRole("button", { name: "Custom" }).click();
    await page.getByTestId("run-history-from").fill("2026-06-01");
    await page.getByTestId("run-history-to").fill("2026-06-15");
    await page.waitForTimeout(600);
    expect(runsUrls.some((u) => /[?&]to=/.test(u)), "custom range pins to").toBe(true);
  });

  // ★ retry_count (runner 0048): a PASS that needed >1 attempt is "degrading-but-green" → soft-warning badge.
  // A clean pass (1) and a pre-telemetry run (null) show nothing; a fail's retries render faint (status is the
  // signal there). The badge only appears when retry_count > 1.
  test("run-history: pass-on-retry shows a soft-warning attempts badge; clean/null show none; fail is faint", async ({ page }) => {
    const w = defaultWorld();
    const at = new Date(Date.now() - 60_000).toISOString(); // recent → inside the live (now-7d) window
    const passOnRetry = run({ id: 510, checkId: 1, status: "pass", retryCount: 3, startedAt: at }); // degrading-but-green
    const cleanPass = run({ id: 509, checkId: 1, status: "pass", retryCount: 1, startedAt: at }); // healthy → no badge
    const preTelemetry = run({ id: 508, checkId: 1, status: "pass", startedAt: at }); // retryCount absent → null → no badge
    const failRetried = run({ id: 507, checkId: 1, status: "fail", errorMessage: "boom", retryCount: 3, startedAt: at }); // confirmed-down
    w.details[1] = detail({ id: 1, name: "API health", kind: "http", currentStatus: "pass" }, [
      passOnRetry,
      cleanPass,
      preTelemetry,
      failRetried,
    ]);
    await mockApi(page, w);
    await page.goto("/checks/1");
    await expect(page.getByTestId("run-history")).toBeVisible();

    // only the two runs with retry_count > 1 get a badge (clean=1 and null show nothing)
    await expect(page.getByTestId("retry-badge")).toHaveCount(2);
    // the degrading PASS is framed as a soft-warning ("Degrading: passed only after 3 attempts")
    await expect(page.getByTitle("Degrading: passed only after 3 attempts")).toBeVisible();
    await expect(page.getByTitle("Degrading: passed only after 3 attempts")).toContainText("3 attempts");
    // the FAIL's retries are secondary (status already says down) → neutral "Took N attempts", not degrading
    await expect(page.getByTitle("Took 3 attempts")).toBeVisible();
  });

  // ★ sandbox (runner 0065): a PAUSED monitor's on-demand validation persists a normal run row but skips
  // evaluate() (no alert, no SLO). The row is badged so a resumed monitor's history isn't misread — a real
  // run shows no badge. This is the per-row disambiguation the runs.sandbox → RunDto → badge chain delivers.
  test("run-history: a sandbox run is badged; a real run is not", async ({ page }) => {
    const w = defaultWorld();
    const at = new Date(Date.now() - 60_000).toISOString(); // recent → inside the live (now-7d) window
    const sandboxRun = run({ id: 610, checkId: 1, status: "pass", startedAt: at, sandbox: true });
    const realRun = run({ id: 609, checkId: 1, status: "pass", startedAt: at }); // sandbox absent → no badge
    w.details[1] = detail({ id: 1, name: "API health", kind: "http", currentStatus: "pass" }, [
      sandboxRun,
      realRun,
    ]);
    await mockApi(page, w);
    await page.goto("/checks/1");
    await expect(page.getByTestId("run-history")).toBeVisible();

    // exactly the one sandbox run is badged (the real run shows nothing)
    await expect(page.getByTestId("sandbox-badge")).toHaveCount(1);
    await expect(page.getByTestId("sandbox-badge")).toContainText(/sandbox/i);
    // the honesty tooltip spells out why it's not a real health signal
    await expect(page.getByTestId("sandbox-badge")).toHaveAttribute("title", /paused.*does not count.*SLO/i);
  });

  // ★ confirmation-retry P2 (runner 0077): a TRANSIENT failure (superseded — its confirmation passed) stays
  // visible as fail/error but is badged "transient" (didn't count) + linked to the confirmation; the
  // confirmation run is badged back to the original. A silently-suppressed failure becomes acknowledged.
  test("run-history: a transient (superseded) run is badged + linked; its confirmation is badged back", async ({ page }) => {
    const w = defaultWorld();
    const at = new Date(Date.now() - 60_000).toISOString();
    const confirmationRun = run({ id: 701, checkId: 1, status: "pass", startedAt: new Date(Date.now() - 57_000).toISOString(), confirmationOfRunId: 700 });
    const transientRun = run({ id: 700, checkId: 1, status: "error", startedAt: at, supersededByRunId: 701 });
    const normalRun = run({ id: 699, checkId: 1, status: "pass", startedAt: at }); // no confirmation/superseded → no badge
    w.details[1] = detail({ id: 1, name: "API health", kind: "http", currentStatus: "pass" }, [
      confirmationRun,
      transientRun,
      normalRun,
    ]);
    await mockApi(page, w);
    await page.goto("/checks/1");
    await expect(page.getByTestId("run-history")).toBeVisible();

    // the transient run (700): badged, links to the confirmation (701), honesty tooltip = "didn't count"
    const transient = page.getByTestId("transient-badge");
    await expect(transient).toHaveCount(1);
    await expect(transient).toContainText(/transient.*701/i);
    await expect(transient).toHaveAttribute("title", /does not count.*(availability|SLO)/i);
    // the confirmation run (701): badged back to the original (700)
    const confirmation = page.getByTestId("confirmation-badge");
    await expect(confirmation).toHaveCount(1);
    await expect(confirmation).toContainText(/confirmation of.*700/i);
    // the transient still reads as a failure (no new status invented) — the badge sits on the real error row
    await expect(page.locator("#run-700")).toBeVisible();
  });

  // ★ RCA verdict badge (#118): the baseline-diff insight's verdict ("which layer failed") renders as an
  // at-a-glance badge — additive to the existing cause/summary; absent on legacy insights → no badge.
  function baselineDiffBody(verdict?: string) {
    return {
      configured: true,
      failing: { runId: 200, location: "eastus2", status: "fail" },
      baseline: { source: "success-baseline", capturedAt: null, location: "centralus" },
      diff: { console: { onlyInA: [], onlyInB: [], shared: 0 }, network: {} },
      insight: {
        summary: "Login selector not found — the page itself rendered.",
        ...(verdict ? { verdict } : {}),
        likelyCause: "undetermined",
        confidence: "high",
        isFlaky: false,
        findings: [],
        caveats: [],
      },
    };
  }

  test("baseline-diff: a monitor-verification-bug verdict shows a distinct badge, additive to the cause", async ({ page }) => {
    const w = defaultWorld();
    w.baselineDiff = baselineDiffBody("monitor-verification-bug");
    await mockApi(page, w);
    await page.goto("/checks/2"); // browser check with a failing run (200), auto-expanded
    await page.getByTestId("get-baseline-diff-200").click();

    const verdict = page.getByTestId("baseline-diff-verdict");
    await expect(verdict).toBeVisible();
    await expect(verdict).toHaveAttribute("data-verdict", "monitor-verification-bug");
    await expect(verdict).toContainText("Monitor bug"); // false-negative flagged: site may be OK
    // additive: the existing cause + summary still render
    await expect(page.getByTestId("baseline-diff-cause")).toBeVisible();
    await expect(page.getByTestId("baseline-diff-insight")).toContainText("Login selector not found");
  });

  test("baseline-diff: a legacy insight without a verdict renders NO badge (back-compat)", async ({ page }) => {
    const w = defaultWorld();
    w.baselineDiff = baselineDiffBody(undefined); // pre-#118 shape
    await mockApi(page, w);
    await page.goto("/checks/2");
    await page.getByTestId("get-baseline-diff-200").click();

    await expect(page.getByTestId("baseline-diff-insight")).toBeVisible(); // the insight still renders
    await expect(page.getByTestId("baseline-diff-verdict")).toHaveCount(0); // but no verdict badge
  });
});

// ★ Write-gate: Pause/Resume + Edit on check detail are EDITOR-only (mirror Run-now). A viewer sees read-only —
// these PATCH the check (and Edit's tag editor auto-saves), so they must not leak to viewers.
test.describe("check detail — write gate", () => {
  test("an EDITOR sees Run now / Pause / Edit", async ({ page }) => {
    await mockApi(page); // default world = seeded editor session
    await page.goto("/checks/1");

    await expect(page.getByTestId("run-now")).toBeVisible();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible(); // check 1 is enabled
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  });

  test("a VIEWER (non-editor) sees NONE of the write controls", async ({ page }) => {
    await mockApi(page, defaultWorld(), { seedSession: false }); // no editor session → read-only
    await page.goto("/checks/1");

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible(); // page still renders
    await expect(page.getByTestId("run-now")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Pause" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Resume" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  });
});

// ★ Sandbox validation for a PAUSED monitor (api #195 / runner #225): a paused check can be run on-demand
// as a SANDBOX validation — the button is present but labeled distinctly, POSTs ?sandbox=true, and the
// result/trace renders via the SAME live view. An enabled check is unchanged (normal Run now, no flag).
test.describe("check detail — sandbox run for a paused monitor", () => {
  test("paused: Run-now is a SANDBOX validation — distinct label, ?sandbox=true, result renders live, never resumes", async ({ page }) => {
    const runPosts: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && /\/checks\/1\/run(\?|$)/.test(r.url())) runPosts.push(r.url());
    });

    const w = defaultWorld();
    // check 1 is PAUSED (enabled:false). The sandbox run goes running→pass; enabled stays false throughout.
    w.detailSequence = {
      1: [
        detail({ id: 1, name: "Paused API", kind: "http", enabled: false, currentStatus: "paused" }, [run({ id: 6000, status: "pass" })]),
        detail({ id: 1, name: "Paused API", kind: "http", enabled: false, currentStatus: "running" },
          [run({ id: 6001, checkId: 1, status: "running", finishedAt: null, durationMs: null, httpStatus: null })]),
        detail({ id: 1, name: "Paused API", kind: "http", enabled: false, currentStatus: "pass" }, [run({ id: 6001, status: "pass" })]),
      ],
    };
    w.runsSequence = { 1: [[run({ id: 6000, status: "pass" })], [run({ id: 6001, status: "pass" })]] };
    await mockApi(page, w); // seeded editor → the control is visible
    await page.goto("/checks/1");

    // ★ present for a PAUSED check, labeled a sandbox validation (NOT "Run now")
    const btn = page.getByTestId("run-now");
    await expect(btn).toHaveText("Sandbox validation");
    await expect(btn).toHaveAttribute("data-sandbox", "true");
    // ★ honesty caption so a green sandbox result isn't misread as a real pass
    await expect(page.getByTestId("sandbox-runs-note")).toBeVisible();
    await expect(page.getByTestId("sandbox-runs-note")).toContainText(/no alert.*no SLO.*no resume/i);

    await btn.click();

    // ★ the POST carried ?sandbox=true (a normal run on a paused check would 409)
    await expect.poll(() => runPosts.length).toBeGreaterThan(0);
    expect(runPosts.some((u) => /[?&]sandbox=true/.test(u)), "run POST carries ?sandbox=true").toBe(true);

    // ★ the result renders live via the EXISTING view — running→pass, no new progress view
    await expect(page.getByText("Running", { exact: true })).toBeVisible();
    await expect(page.getByText("Pass", { exact: true })).toBeVisible();
    // ★ never resumes: the control is still a sandbox validation after the run (enabled stayed false)
    await expect(btn).toHaveText("Sandbox validation");
  });

  test("enabled: Run-now is unchanged — normal run, no ?sandbox, no sandbox caption", async ({ page }) => {
    const runPosts: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && /\/checks\/1\/run(\?|$)/.test(r.url())) runPosts.push(r.url());
    });
    await mockApi(page); // default world: check 1 enabled, seeded editor
    await page.goto("/checks/1");

    const btn = page.getByTestId("run-now");
    await expect(btn).toHaveText("Run now");
    await expect(btn).not.toHaveAttribute("data-sandbox", "true");
    await expect(page.getByTestId("sandbox-runs-note")).toHaveCount(0); // no sandbox note for an enabled check

    await btn.click();
    await expect.poll(() => runPosts.length).toBeGreaterThan(0);
    // ★ must-go-red: a normal run OMITS the flag (a bug that always-sends sandbox fails here)
    expect(runPosts.every((u) => !/[?&]sandbox=/.test(u)), "normal run omits ?sandbox").toBe(true);
  });
});

// ★ Model-B credential EDITOR (Step C). The API stores ENCRYPTED VALUES (write-only) and masks every
// configured slot to "set" on read ({ name → "set" }), session-gated to editors. This panel lets an editor
// SET values (secret_headers + login_credentials) via PUT /checks/{id}/credentials; the value is never read
// back. NO real secret in these tests — dummy values only.
test.describe("check detail — credential editor (model B, write-only, editor-gated)", () => {
  test("editor sees value inputs + current slots masked as 'set' (never a value)", async ({ page }) => {
    const w = defaultWorld();
    w.details[1] = detail(
      // masked read shape: { name → "set" } for a configured slot (the API never serves the value)
      { id: 1, name: "Wegmans API", kind: "http", secretHeaders: { "X-Api-Key": "set" }, loginCredentials: { username: "set" } },
      [run({ id: 100, status: "pass" })],
    );
    await mockApi(page, w); // default seeds an EDITOR session → canWrite
    await page.goto("/checks/1");

    const panel = page.getByTestId("credentials-panel");
    await expect(panel).toBeVisible();
    // ★ COLLAPSED by default (top-of-page footprint): the body is hidden until the disclosure is clicked.
    await expect(panel.getByTestId("credentials-body")).toHaveCount(0);
    await panel.getByTestId("credentials-disclosure").click();
    await expect(panel.getByTestId("credentials-body")).toBeVisible();
    // configured slots render masked "set", never a value/ciphertext
    await expect(panel.getByTestId("cred-slot-secretHeaders-X-Api-Key")).toContainText("set");
    await expect(panel.getByTestId("cred-slot-loginCredentials-username")).toContainText("set");
    // it's an EDITOR now: value inputs exist for both columns
    await expect(panel.getByTestId("cred-value-secretHeaders-0")).toBeVisible();
    await expect(panel.getByTestId("cred-value-loginCredentials-0")).toBeVisible();
    // honesty caption: encrypted + write-only
    await expect(panel.getByTestId("credentials-honesty")).toContainText(/encrypted/i);
    await expect(panel.getByTestId("credentials-honesty")).toContainText(/write-only/i);
  });

  test("non-editor sees NOTHING (inherited gate — API nulls the fields, panel canWrite-gated)", async ({ page }) => {
    const w = defaultWorld();
    w.details[1] = detail({ id: 1, name: "Wegmans API", kind: "http", secretHeaders: null, loginCredentials: null }, [run({ id: 100, status: "pass" })]);
    await mockApi(page, w, { seedSession: false }); // anonymous → not canWrite
    await page.goto("/checks/1");

    await expect(page.getByRole("heading", { name: "Wegmans API" })).toBeVisible();
    await expect(page.getByTestId("credentials-panel")).toHaveCount(0);
  });

  test("★ writing a secret PUTs the right body (dummy value) and refreshes the masked state", async ({ page }) => {
    const w = defaultWorld();
    w.details[1] = detail({ id: 1, name: "Wegmans API", kind: "http", secretHeaders: null, loginCredentials: null }, [run({ id: 100, status: "pass" })]);
    await mockApi(page, w);
    await page.goto("/checks/1");

    const panel = page.getByTestId("credentials-panel");
    await expect(panel).toBeVisible();
    await panel.getByTestId("credentials-disclosure").click(); // expand the collapsed-by-default box
    // no slot yet
    await expect(panel.getByTestId("cred-slot-secretHeaders-X-Api-Key")).toHaveCount(0);

    // capture the outbound PUT — assert it carries the plaintext body we typed (a DUMMY, never a real secret)
    const putP = page.waitForRequest(
      (r) => r.method() === "PUT" && /\/checks\/1\/credentials$/.test(r.url()),
    );
    await panel.getByTestId("cred-name-secretHeaders-0").fill("X-Api-Key");
    await panel.getByTestId("cred-value-secretHeaders-0").fill("dummy-not-a-real-secret");
    await panel.getByTestId("cred-save-secretHeaders").click();

    const put = await putP;
    expect(JSON.parse(put.postData() || "{}")).toEqual({ secretHeaders: { "X-Api-Key": "dummy-not-a-real-secret" } });

    // after the write the mock re-GETs and the slot now shows masked "set" — the value is NOT round-tripped
    await expect(panel.getByTestId("cred-slot-secretHeaders-X-Api-Key")).toContainText("set");
    await expect(panel).not.toContainText("dummy-not-a-real-secret");
  });

  // ★ MUST-GO-RED: editing one login-credential role must NOT wipe the others. The API REPLACES the whole
  // column and values are write-only, so the editor pre-fills every stored role by name and blocks a save that
  // would silently drop one. Revert the pre-fill → a single-field save clobbers the other → this fails.
  test("★ partial save preserves the other role (was clobbering unset roles)", async ({ page }) => {
    const w = defaultWorld();
    w.details[1] = detail(
      { id: 1, name: "Shop flow", kind: "browser", loginCredentials: { username: "set", password: "set" } },
      [run({ id: 100, status: "pass" })],
    );
    await mockApi(page, w); // editor session
    await page.goto("/checks/1");

    const panel = page.getByTestId("credentials-panel");
    await panel.getByTestId("credentials-disclosure").click();

    // ★ both stored roles are pre-filled by name so neither can be silently dropped on save
    await expect(panel.getByTestId("cred-name-loginCredentials-0")).toHaveValue("username");
    await expect(panel.getByTestId("cred-name-loginCredentials-1")).toHaveValue("password");

    // set ONLY the new password, leave username blank → the guard blocks; NO write goes out (no clobber)
    let putFired = false;
    page.on("request", (r) => {
      if (r.method() === "PUT" && /\/checks\/1\/credentials$/.test(r.url())) putFired = true;
    });
    await panel.getByTestId("cred-value-loginCredentials-1").fill("newpass-dummy");
    await panel.getByTestId("cred-save-loginCredentials").click();
    await expect(panel.getByTestId("cred-error-loginCredentials")).toContainText(/username/i);
    expect(putFired, "a blank-username save must NOT PUT (would clobber username)").toBe(false);
    await expect(panel.getByTestId("cred-slot-loginCredentials-username")).toContainText("set"); // still stored

    // re-enter username too → save carries BOTH roles → neither is clobbered by the REPLACE write
    const putP = page.waitForRequest((r) => r.method() === "PUT" && /\/checks\/1\/credentials$/.test(r.url()));
    await panel.getByTestId("cred-value-loginCredentials-0").fill("user-dummy");
    await panel.getByTestId("cred-save-loginCredentials").click();
    const put = await putP;
    expect(JSON.parse(put.postData() || "{}")).toEqual({
      loginCredentials: { username: "user-dummy", password: "newpass-dummy" },
    });
    // both slots remain set after the write — the other role was preserved, not wiped
    await expect(panel.getByTestId("cred-slot-loginCredentials-username")).toContainText("set");
    await expect(panel.getByTestId("cred-slot-loginCredentials-password")).toContainText("set");
  });
});

test.describe("check detail — compact top layout", () => {
  test("config options render in one compact row that does not overflow on mobile", async ({ page }) => {
    const w = defaultWorld();
    w.details[1] = detail({ id: 1, name: "API health", kind: "http" }, [run({ id: 100, status: "pass" })]);
    await mockApi(page, w);

    // Narrow (mobile) viewport — the row must WRAP, never force a horizontal scrollbar.
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/checks/1");

    const row = page.getByTestId("config-row");
    await expect(row).toBeVisible();
    await expect(row).toContainText("Interval"); // the config values are preserved, just compact
    // ★ the timeout field is the PER-ACTION timeout, shown in SECONDS (30000ms → 30s), not the raw ms label
    await expect(row).toContainText("Per-action timeout");
    await expect(row).toContainText("30s");
    await expect(row).not.toContainText("30000ms");
    // ★ no horizontal page overflow (the mobile one-line trap)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1); // sub-pixel rounding tolerance
  });

  test("credentials box is collapsed by default (footprint reduced), expands on click", async ({ page }) => {
    const w = defaultWorld();
    w.details[1] = detail({ id: 1, name: "API health", kind: "http", secretHeaders: { "X-Api-Key": "set" } }, [run({ id: 100, status: "pass" })]);
    await mockApi(page, w); // editor session
    await page.goto("/checks/1");

    const panel = page.getByTestId("credentials-panel");
    await expect(panel.getByTestId("credentials-disclosure")).toBeVisible(); // header always shown
    await expect(panel.getByTestId("credentials-body")).toHaveCount(0); // collapsed by default
    await panel.getByTestId("credentials-disclosure").click();
    await expect(panel.getByTestId("credentials-body")).toBeVisible(); // expands
  });
});

test.describe("check detail — spec-cache observability", () => {
  test("Git-managed check shows the cached commit + fetched-at", async ({ page }) => {
    const w = defaultWorld();
    w.details[1] = detail(
      { id: 1, name: "Shop flow", kind: "browser", specPath: "monitors/shop.spec.ts" },
      [run({ id: 100, status: "pass" })],
    );
    w.specCache = {
      1: { gitManaged: true, specPath: "monitors/shop.spec.ts", cachedSha: "abc1234deadbeef", fetchedAt: "2026-07-09T00:00:00Z" },
    };
    await mockApi(page, w);
    await page.goto("/checks/1");

    const line = page.getByTestId("spec-cache-line");
    await expect(line).toBeVisible();
    await expect(line).toContainText("abc1234"); // short (7-char) SHA — makes cached-vs-HEAD observable
    await expect(line).toContainText(/fetched/i);
  });

  test("baked-in (non-Git) check shows no spec-cache line", async ({ page }) => {
    const w = defaultWorld();
    w.details[2] = detail({ id: 2, name: "API health", kind: "http" }, [run({ id: 200, status: "pass" })]);
    await mockApi(page, w);
    await page.goto("/checks/2");

    await expect(page.getByRole("heading", { name: "API health" })).toBeVisible();
    await expect(page.getByTestId("spec-cache-line")).toHaveCount(0); // no spec_path → not Git-managed
  });
});
