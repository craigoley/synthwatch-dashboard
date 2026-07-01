import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

// ★ §A3: the by-PROPERTY rollup on /status (stakeholder-legible, above the per-check Components). Current
// state is DISTINCT from historical uptime; a building-baseline property shows "—", never a fake %; hides
// gracefully when the /status endpoint isn't deployed. Null-safe (the .tone-crash lesson).

test.describe("status page — by-property rollup", () => {
  test("renders property cards with state + uptime; building baseline shows no fake %", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/status");

    await expect(page.getByTestId("status-properties-section")).toBeVisible();
    // a DOWN property surfaces its state badge
    await expect(page.getByTestId("status-property-meals2go").getByTestId("status-badge-down")).toBeVisible();
    // ★ state (now) is distinct from uptime (historical): meals2go is "down" now, with an 88.94% 30d uptime
    await expect(page.getByTestId("status-uptime-meals2go")).toContainText("88.94");
    // an up property with a real %
    await expect(page.getByTestId("status-property-wegmans.com").getByTestId("status-badge-up")).toBeVisible();
    await expect(page.getByTestId("status-uptime-wegmans.com")).toContainText("97.23");
    // ★ building baseline: state up NOW but the uptime is an em-dash + labelled, never a fabricated %
    await expect(page.getByTestId("status-property-newprop")).toContainText("building baseline");
    await expect(page.getByTestId("status-uptime-newprop")).toHaveText("—");
  });

  test("endpoint not deployed (404) → the by-property section hides; the page still renders", async ({ page }) => {
    const w = defaultWorld();
    w.statusServed = false; // GET /status 404s
    await mockApi(page, w);
    await page.goto("/status");

    await expect(page.getByTestId("status-properties-section")).toHaveCount(0); // section absent
    await expect(page.getByText("Components")).toBeVisible(); // the rest of the status page still renders
  });
});
