import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";
import { listItem } from "./fixtures";

/**
 * Archived monitors × operational views. Archive (0071) = "I have retired this monitor"; the Status grid and
 * the public status page are "what is happening RIGHT NOW" views — an archived monitor has nothing happening,
 * by definition. The tests that matter: archived is EXCLUDED from every operational surface by default, but
 * stays OPT-IN findable (the Archived tab) and reactivatable (Monitors) — collapse the boring, never make an
 * exception unfindable.
 */

// The observed bug case: b2c-login-test, archived (still enabled — archive doesn't touch `enabled`),
// api 0071 projects its current_status as "archived".
const archived = (over: Record<string, unknown> = {}) =>
  listItem({
    id: 2,
    name: "Wegmans B2C login — InfoSec test",
    kind: "browser",
    flowName: "b2c-login-test",
    currentStatus: "archived",
    archivedAt: "2026-07-09T13:00:00Z",
    runs24h: 0,
    severity: "warning",
    ...over,
  });

test.describe("archived monitors — status grid", () => {
  test("★ the DEFAULT grid does not show an archived monitor; the Archived tab still finds it", async ({ page }) => {
    const w = defaultWorld();
    w.checks = [
      listItem({ id: 1, name: "API health", currentStatus: "pass", severity: "warning" }),
      archived(),
      listItem({ id: 3, name: "Homepage flow", kind: "browser", currentStatus: "pass", severity: "warning" }),
    ];
    await mockApi(page, w);
    await page.goto("/");

    // healthy neighbors render; the archived card is gone from the operational view
    await expect(page.locator('a[href="/checks/1"]')).toBeVisible();
    await expect(page.locator('a[href="/checks/3"]')).toBeVisible();
    await expect(page.locator('a[href="/checks/2"]')).toHaveCount(0);
    // the subset is flagged honestly (the existing filter-count affordance)
    await expect(page.getByTestId("filter-count")).toContainText("Showing 2 of 3");

    // ★ findability: one tap into the Archived tab and it's there — hidden from ops, never unfindable
    await page.getByRole("button", { name: "Archived" }).click();
    await expect(page.locator('a[href="/checks/2"]')).toBeVisible();
    await expect(page.locator('a[href="/checks/1"]')).toHaveCount(0);
  });

  test("archived-then-REMOVED stays visible in 'All' (removed supersedes archived — the purge clock is a call to action)", async ({ page }) => {
    const w = defaultWorld();
    w.checks = [
      listItem({ id: 1, name: "API health", currentStatus: "pass", severity: "warning" }),
      archived({ removedAt: "2026-07-11T09:00:00Z", currentStatus: "removed" }),
    ];
    await mockApi(page, w);
    await page.goto("/");
    // the co-occurring timestamps must not hide the purge-clock state from the landing view
    await expect(page.locator('a[href="/checks/2"]')).toBeVisible();
  });

  test("★ an archived card reads RETIRED, not warming up: no sparkline/p50/p95, no '24h avail building…'", async ({ page }) => {
    const w = defaultWorld();
    w.checks = [archived()];
    await mockApi(page, w);
    await page.goto("/?status=archived");

    const card = page.locator('a[href="/checks/2"]');
    await expect(card).toBeVisible();
    // the retired statement replaces the live-metrics row
    await expect(card.getByTestId("card-retired-2")).toContainText("Retired — archived");
    await expect(card.getByText("p50 24h")).toHaveCount(0);
    await expect(card.getByText("p95 24h")).toHaveCount(0);
    await expect(card.getByText("24h avail")).toHaveCount(0);
    await expect(card.getByText(/building/)).toHaveCount(0);
    // the honest facts stay: the Archived pill and the last-run timestamp
    await expect(card.getByText("Archived", { exact: true })).toBeVisible();
    await expect(card.getByText(/last run/)).toBeVisible();
  });

  test("header fleet pulse never counts an archived monitor — even if its projected status drifts to a raw fail", async ({ page }) => {
    // Belt-and-braces case: the 0071 projection masks archived → "archived", but the exclusion must be
    // structural. Simulate projection drift (an archived check leaking currentStatus "fail").
    const w = defaultWorld();
    w.checks = [
      listItem({ id: 1, name: "API health", currentStatus: "pass", severity: "warning" }),
      archived({ currentStatus: "fail" }),
    ];
    await mockApi(page, w);
    await page.goto("/");

    const pulse = page.locator('[aria-label="fleet status summary"]');
    await expect(pulse).toBeVisible();
    // buckets: fail 0 (the archived drift is NOT counted) · warn 0 · pass 1. Each count carries an a11y glyph
    // (✕/⚠/✓) so severity isn't conveyed by colour alone.
    const counts = await pulse.locator("span.sw-mono").allTextContents();
    expect(counts.map((c) => c.trim())).toEqual(["✕ 0", "⚠ 0", "✓ 1"]);
  });
});

test.describe("archived monitors — PUBLIC status page", () => {
  test("★ MUST-GO-RED: a lingering open incident on an ARCHIVED check must not flip the public banner", async ({ page }) => {
    // Revert the deriveSystemStatus archived guard and this FAILS: the open-incident branch fires
    // regardless of settled status → "Major Outage" from a retired monitor.
    const w = defaultWorld();
    w.checks = [
      listItem({ id: 1, name: "API health", currentStatus: "pass", severity: "warning" }),
      archived({ openIncidentCount: 1, maxOpenSeverity: "critical", hasOpenIncident: true, severity: "critical" }),
    ];
    await mockApi(page, w);
    await page.goto("/status");
    await expect(page.getByTestId("system-status-label")).toHaveText("All Systems Operational");
  });

  test("an archived check renders NO component row on the public page (no fake 'No data' presence)", async ({ page }) => {
    const w = defaultWorld();
    w.checks = [
      listItem({ id: 1, name: "API health", currentStatus: "pass", severity: "warning" }),
      archived(), // enabled=true — pre-fix this rendered a "No data" component row
    ];
    await mockApi(page, w);
    await page.goto("/status");
    await expect(page.getByTestId("component-row-1")).toBeVisible();
    await expect(page.getByTestId("component-row-2")).toHaveCount(0);
  });
});

test.describe("archived monitors — still manageable", () => {
  test("★ Monitors lists it, badged 'archived', with a working Unarchive (reactivation stays one click away)", async ({ page }) => {
    const w = defaultWorld();
    w.checks = [
      listItem({ id: 1, name: "API health", currentStatus: "pass", severity: "warning" }),
      archived(),
    ];
    await mockApi(page, w);
    await page.goto("/monitors");

    // the list row is the grid div wrapping this check's detail link
    const row = page
      .locator('div[class*="sm:grid-cols-"]')
      .filter({ has: page.locator('a[href="/checks/2"]') });
    await expect(row.getByText("archived", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Unarchive" })).toBeEnabled();
  });
});
