import { test, expect } from "@playwright/test";

import { mockApi } from "./mock";

test.describe("status grid", () => {
  test("renders a card for every kind", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await mockApi(page);
    await page.goto("/");

    for (const name of [
      "API health",
      "Homepage flow",
      "TLS cert",
      "DNS A record",
      "TCP port",
      "Ping host",
      "Login chain",
      "Paused check",
    ]) {
      await expect(page.getByText(name, { exact: false }).first()).toBeVisible();
    }
    // kind labels (lowercase in the DOM; uppercased via CSS)
    for (const kind of ["http", "browser", "ssl", "dns", "tcp", "ping", "multistep"]) {
      await expect(page.getByText(kind, { exact: true }).first()).toBeVisible();
    }
    expect(errors).toEqual([]);
  });

  // ★ Regression lock: the API reports currentStatus "paused" for a disabled
  // check — outside the run-status taxonomy. This once returned undefined from
  // runStatusMeta and crashed the whole grid. It must never regress.
  test("a DISABLED (paused) check does NOT crash the grid", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await mockApi(page);
    await page.goto("/");

    const paused = page.locator('a[href="/checks/8"]');
    await expect(paused).toBeVisible();
    await expect(paused).toContainText(/paused/i);
    // the rest of the grid still rendered (the paused card didn't blow it up)
    await expect(page.locator('a[href="/checks/1"]')).toBeVisible();
    await expect(page.locator('a[href="/checks/7"]')).toBeVisible();
    expect(errors).toEqual([]);
  });

  // ★ Regional: some-but-not-all locations failing reads distinctly from a full
  // outage; a single-location check shows no regional indicator (no regression).
  test("a multi-location check shows the 'regional' indicator; single-location does not", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await expect(page.locator('a[href="/checks/11"]')).toContainText(/regional 1\/2/i);
    await expect(page.locator('a[href="/checks/1"]')).not.toContainText(/regional/i);
  });

  // ★ #47 — a warn location (no fail/error) surfaces as "degraded" on the card,
  // distinct from "regional" and NOT silently green/healthy.
  test("a warn location shows the 'degraded' indicator (not 'regional')", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await expect(page.locator('a[href="/checks/14"]')).toContainText(/degraded 1\/2/i);
    await expect(page.locator('a[href="/checks/14"]')).not.toContainText(/regional/i);
  });

  test("kind-specific card labels (multistep step count, ssl cert, dns record)", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");

    await expect(page.locator('a[href="/checks/7"]')).toContainText(/2 steps/);
    await expect(page.locator('a[href="/checks/3"]')).toContainText(/12d/);
    await expect(page.locator('a[href="/checks/4"]')).toContainText(/A example\.com/);
  });
});
