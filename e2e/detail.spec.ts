import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";
import { slaResponse, slaRow } from "./fixtures";

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
    // the proxy served a real PNG and apiUrl() resolved the path → it decoded
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBeGreaterThan(0);
    // download fallback + the new in-app "View trace" affordance both present
    await expect(page.getByRole("link", { name: /Download/ })).toBeVisible();
    await expect(page.getByTestId("view-trace-200")).toBeVisible();
  });

  // ★ Phase 10: embed the self-hosted Playwright trace viewer for failed runs.
  test("embeds the trace viewer in-app (forensics), pointed at the proxied trace", async ({ page }) => {
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
    // ★ SAME-ORIGIN: the viewer fetches the dashboard's own /trace-proxy, NOT the
    // cross-origin API — the documented CORS trap (Playwright #38622) is dodged.
    expect(decoded).toContain("/trace-proxy/200");
    expect(decoded).not.toContain("mock.synthwatch.test"); // not the API origin
    const pageOrigin = new URL(page.url()).origin;
    expect(decoded).toContain(`${pageOrigin}/trace-proxy/200`); // absolute, same-origin

    // the vendored viewer bundle is served on-domain
    expect((await page.request.get("/trace-viewer/index.html")).status()).toBe(200);
    // the same-origin trace proxy route is wired (server-side; upstream is unreachable
    // in the hermetic mock → 502, NOT 404 — proving the route exists and proxies).
    expect((await page.request.get("/trace-proxy/200")).status()).not.toBe(404);
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
});
