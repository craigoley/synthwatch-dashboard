import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";
import { listItem } from "./fixtures";

/**
 * Env-aware display (api #205 projects checks.environment). A non-prod (staging) check must be badged +
 * filterable in the grid, EXCLUDED from the fleet status banner (a staging fail can't flip the prod promise),
 * and flagged as intentionally-excluded on the SLO/trust reports. Env comes from the authoritative column, not
 * the user-mutable env: tag.
 */

// A fleet: two healthy PROD checks + one CRITICAL-FAILING STAGING check. Without the deriveSystemStatus guard
// the staging fail (down + severity critical) would roll the banner to "Major Outage".
function fleetWithStagingFail() {
  const w = defaultWorld();
  w.checks = [
    listItem({ id: 1, name: "API health (prod)", currentStatus: "pass" }),
    listItem({ id: 2, name: "Checkout (prod)", currentStatus: "pass" }),
    listItem({
      id: 354,
      name: "Wegmans PREVIEW (staging)",
      environment: "staging",
      currentStatus: "fail",
      severity: "critical",
      openIncidentCount: 1,
      maxOpenSeverity: "critical",
    }),
  ];
  return w;
}

test.describe("env-aware display — badge, filter, banner guard, exclusion caption", () => {
  test("grid: the staging check is badged; prod checks are not; the env filter appears", async ({ page }) => {
    await mockApi(page, fleetWithStagingFail());
    await page.goto("/");

    // (2) env badge on the non-prod card, reading the real env value; prod cards show none.
    await expect(page.getByTestId("env-badge-354")).toHaveText(/staging/i);
    await expect(page.getByTestId("env-badge-1")).toHaveCount(0);
    await expect(page.getByTestId("env-badge-2")).toHaveCount(0);
    // (3) the env facet appears (a non-prod check exists) and filters to just the staging check.
    await expect(page.getByTestId("env-filter")).toBeVisible();
    await page.getByRole("button", { name: "Non-prod", exact: true }).click();
    await expect(page.getByTestId("env-badge-354")).toBeVisible();
    await expect(page.getByText("API health (prod)")).toHaveCount(0);
  });

  test("★ MUST-GO-RED: a staging CRITICAL-FAIL does NOT flip the prod banner (guard excludes non-prod)", async ({ page }) => {
    await mockApi(page, fleetWithStagingFail());
    await page.goto("/status");

    // The two prod checks are healthy → the banner is Operational. The staging critical-fail is EXCLUDED by the
    // deriveSystemStatus env-guard. Revert `if (!c.enabled || (c.environment ?? "prod") !== "prod") continue;`
    // and this flips to "Major Outage" — the exact display-side pollution the guard prevents.
    await expect(page.getByTestId("system-status-label")).toHaveText("All Systems Operational");
  });

  test("reports: SLO + trust panels flag the excluded non-prod count (not missing data)", async ({ page }) => {
    await mockApi(page, fleetWithStagingFail());

    await page.goto("/reports?tab=reliability");
    await expect(page.getByTestId("nonprod-excluded-note")).toContainText("1 non-prod monitor excluded");

    await page.goto("/reports?tab=trust");
    await expect(page.getByTestId("nonprod-excluded-note")).toContainText("1 non-prod monitor excluded");
  });

  test("prod-only fleet is UNCHANGED: no badge, no env filter, no exclusion caption", async ({ page }) => {
    const w = defaultWorld();
    w.checks = [
      listItem({ id: 1, name: "API health", currentStatus: "pass" }),
      listItem({ id: 2, name: "Checkout", currentStatus: "pass" }),
    ];
    await mockApi(page, w);

    await page.goto("/");
    await expect(page.getByTestId("env-badge-1")).toHaveCount(0);
    await expect(page.getByTestId("env-filter")).toHaveCount(0); // no non-prod → facet absent

    await page.goto("/reports?tab=reliability");
    await expect(page.getByTestId("nonprod-excluded-note")).toHaveCount(0);

    await page.goto("/status");
    await expect(page.getByTestId("system-status-label")).toHaveText("All Systems Operational");
  });
});
