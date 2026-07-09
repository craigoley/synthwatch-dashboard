import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";
import { listItem } from "./fixtures";

// Header roll-up × running checks (the settled-status contract, #201/#206 hoisted to the banner).
// Pre-fix, deriveSystemStatus read the LIVE current_status: "running" matched neither down nor degraded,
// so a monitor vanished from the tally the moment a run started — a failing monitor's re-run flipped the
// banner green mid-run. Now the banner tallies lastSettledStatus: running never drops a monitor and never
// clears a known-bad status; the banner moves only when a run COMPLETES with a different settled result.

const T0 = "2026-07-07T10:00:00Z";
const T1 = "2026-07-07T10:05:00Z";

test.describe("header roll-up — running checks keep their settled status", () => {
  test("settled-pass + running → banner stays Operational (counted, not dropped, not flipped)", async ({ page }) => {
    const w = defaultWorld();
    w.checks = [
      listItem({ id: 1, name: "Healthy runner", currentStatus: "running", spark: [{ t: T0, d: 100, s: "pass" }] }),
      listItem({ id: 2, name: "Healthy idle", currentStatus: "pass" }),
    ];
    await mockApi(page, w);
    await page.goto("/status");
    await expect(page.getByTestId("system-status-label")).toHaveText("All Systems Operational");
  });

  test("★ MUST-GO-RED: settled-FAIL (critical) + running → banner still Major Outage (running does NOT clear known-bad)", async ({ page }) => {
    // Revert the deriveSystemStatus settled-status fix (read live current_status again) and this test FAILS:
    // "running" matches neither down nor degraded → the failing monitor drops out → banner reads Operational.
    const w = defaultWorld();
    w.checks = [
      listItem({
        id: 1,
        name: "Checkout (failing, re-running)",
        severity: "critical",
        currentStatus: "running",
        spark: [
          { t: T0, d: 100, s: "pass" },
          { t: T1, d: 100, s: "fail" },
        ],
      }),
      listItem({ id: 2, name: "Healthy idle", currentStatus: "pass" }),
    ];
    await mockApi(page, w);
    await page.goto("/status");
    await expect(page.getByTestId("system-status-label")).toHaveText("Major Outage");
  });

  test("never-run + now running → NOT counted as pass; banner still reflects the rest of the fleet", async ({ page }) => {
    const w = defaultWorld();
    w.checks = [
      listItem({ id: 1, name: "Brand new (first run in flight)", currentStatus: "running", spark: [] }),
      listItem({ id: 2, name: "Degraded", currentStatus: "warn" }),
    ];
    await mockApi(page, w);
    await page.goto("/status");
    // the never-settled runner contributes nothing (null ≠ green); the warn check drives Partial
    await expect(page.getByTestId("system-status-label")).toHaveText("Partial Outage");
  });

  test("run COMPLETES with a different settled result → the banner updates on the poll (not frozen)", async ({ page }) => {
    const w = defaultWorld();
    w.checks = [
      listItem({ id: 1, name: "Flipper", severity: "warning", currentStatus: "running", spark: [{ t: T0, d: 100, s: "pass" }] }),
    ];
    await mockApi(page, w);
    await page.goto("/status");
    await expect(page.getByTestId("system-status-label")).toHaveText("All Systems Operational");

    // the run lands as FAIL — the mock reads `world` per-request, so the next 15s checks poll serves this
    w.checks[0] = listItem({
      id: 1,
      name: "Flipper",
      severity: "warning",
      currentStatus: "fail",
      spark: [
        { t: T0, d: 100, s: "pass" },
        { t: T1, d: 100, s: "fail" },
      ],
    });
    await expect(page.getByTestId("system-status-label")).toHaveText("Partial Outage", { timeout: 20_000 });
  });

  test("header and card AGREE for a running check: both read the settled FAIL, plus the card's running dot", async ({ page }) => {
    const w = defaultWorld();
    w.checks = [
      listItem({
        id: 1,
        name: "Agreement check",
        severity: "critical",
        currentStatus: "running",
        spark: [{ t: T0, d: 100, s: "fail" }],
      }),
    ];
    await mockApi(page, w);

    await page.goto("/status");
    await expect(page.getByTestId("system-status-label")).toHaveText("Major Outage");

    await page.goto("/");
    const card = page.locator('a[href="/checks/1"]');
    // the settled pill reads Fail (NOT "Running"); the in-flight run shows via the separate indicator
    await expect(card.getByText("Fail", { exact: true })).toBeVisible();
    await expect(card.getByText("Running", { exact: true })).toHaveCount(0);
    await expect(card.getByTestId("card-running-indicator")).toBeVisible();
  });
});
