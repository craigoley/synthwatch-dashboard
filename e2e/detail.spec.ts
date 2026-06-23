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

  test("browser failure: screenshot renders via the proxy + trace link", async ({ page }) => {
    await mockApi(page);
    await page.goto("/checks/2");

    const img = page.locator('img[alt="Failure screenshot for run 200"]');
    await expect(img).toBeVisible();
    // the proxy served a real PNG and apiUrl() resolved the path → it decoded
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBeGreaterThan(0);
    await expect(page.getByRole("link", { name: /Download trace/ })).toBeVisible();
    await expect(page.getByText(/playwright show-trace/)).toBeVisible();
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

    await expect(page.getByRole("heading", { name: "By location" })).toBeVisible();
    await expect(page.getByText("eastus2")).toBeVisible();
    await expect(page.getByText("westus2")).toBeVisible();
    // partial failure → "regional", visually distinct from a global outage
    await expect(page.getByText(/Regional — 1\/2 locations failing/)).toBeVisible();
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
