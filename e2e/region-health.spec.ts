import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

// Region health (the F-4 pair: api #168 + this panel) — per-region freshness on /status, the visible
// alarm for a silently-dead region. Four honest states, none silent (#175/#177): fresh / stale /
// never_reported / fetch-error. Absent endpoint (pre-deploy) → the section hides cleanly.

const REGIONS = [
  { region: "eastus2", lastRunAt: "2026-07-05T13:59:00Z", ageSeconds: 60, status: "fresh" },
  { region: "westus2", lastRunAt: "2026-07-05T10:00:00Z", ageSeconds: 14_400, status: "stale" },
  { region: "centralus", lastRunAt: null, ageSeconds: null, status: "never_reported" },
];

test.describe("region health — the F-4 alarm panel", () => {
  test("★ all three api states render DISTINCTLY: fresh calm, stale LOUD, never_reported its own state", async ({ page }) => {
    const w = defaultWorld();
    w.regionHealth = REGIONS;
    await mockApi(page, w);
    await page.goto("/status");

    const section = page.getByTestId("region-health-section");
    await expect(section).toBeVisible();

    // fresh: calm row with proof-of-life age (not just a green dot)
    const fresh = page.getByTestId("region-health-eastus2");
    await expect(fresh).toHaveAttribute("data-status", "fresh");
    await expect(fresh).toContainText("fresh");
    await expect(fresh).toContainText("last run 1m ago"); // 60s → coarse span units

    // ★ stale IS the alarm — loud fail-toned banner text, not a chip demotion
    const stale = page.getByTestId("region-health-westus2");
    await expect(stale).toHaveAttribute("data-status", "stale");
    await expect(stale).toContainText("STALE — region silent");
    await expect(stale).toContainText("no runs for 4h 0m"); // 14400s → hour-scale units, matching the "ago" suffix
    // the alarm styling: fail-toned left rail + tinted background (assert the inline style carries the token)
    await expect(stale).toHaveCSS("border-left-width", "4px");
    const bg = await stale.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe("rgba(0, 0, 0, 0)"); // filled, not transparent — a banner, unlike the calm rows

    // never_reported: a CONFIGURED region with no data ever — distinct copy, not stale, no fabricated age
    const never = page.getByTestId("region-health-centralus");
    await expect(never).toHaveAttribute("data-status", "never_reported");
    await expect(never).toContainText("never reported");
    await expect(never).toContainText("no run has ever arrived");
    await expect(never).not.toContainText("STALE");
  });

  test("★ fetch error → LOUD ErrorState, never a silently-blank alarm panel (#175)", async ({ page }) => {
    const w = defaultWorld();
    w.regionHealth500 = true;
    await mockApi(page, w);
    await page.goto("/status");

    await expect(page.getByTestId("region-health-error")).toBeVisible();
    await expect(page.getByTestId("region-health-error")).toContainText(/failed to load/i);
  });

  test("absent endpoint (pre-#168 deploy) → the section hides cleanly — not broken, not an error", async ({ page }) => {
    await mockApi(page, defaultWorld()); // regionHealth unset → the mock 404s the endpoint
    await page.goto("/status");

    // anchor on a sibling section so we assert "loaded page without the panel", not a blank page
    await expect(page.getByTestId("egress-section")).toBeVisible();
    await expect(page.getByTestId("region-health-section")).toHaveCount(0);
    await expect(page.getByTestId("region-health-error")).toHaveCount(0);
  });

  test("polling panel → no staleness stamp (the #178 rule: self-freshening panels carry no manual stamp)", async ({ page }) => {
    const w = defaultWorld();
    w.regionHealth = REGIONS;
    await mockApi(page, w);
    await page.goto("/status");
    await expect(page.getByTestId("region-health-section")).toBeVisible();
    await expect(page.getByTestId("region-health-fetched")).toHaveCount(0);
  });
});
