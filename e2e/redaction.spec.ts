import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";
import { listItem, detail, run } from "./fixtures";

// B10 redaction-health surface (#121): a sensitive-but-unredacted monitor (the leak class that hid for months)
// must be visible — a loud per-check badge + a fleet-level gap indicator. null/legacy → no badge.

test.describe("B10 redaction health", () => {
  test("per-check badges: misconfigured is loud, ok is subtle, n/a + legacy show nothing", async ({ page }) => {
    const w = defaultWorld();
    w.checks = [
      listItem({ id: 1, name: "Secrets API", sensitive: true, hasRedactPatterns: false, redactionHealth: "misconfigured" }),
      listItem({ id: 2, name: "Login flow", sensitive: true, hasRedactPatterns: true, redactionHealth: "ok" }),
      listItem({ id: 3, name: "Public homepage", sensitive: false, redactionHealth: "n/a" }),
      listItem({ id: 4, name: "Legacy monitor" }), // no redaction fields → null → no badge
    ];
    await mockApi(page, w);
    await page.goto("/monitors");

    // exactly the misconfigured + ok checks get a badge; n/a and legacy show none
    await expect(page.getByTestId("redaction-badge")).toHaveCount(2);

    const bad = page.locator('[data-testid="redaction-badge"][data-health="misconfigured"]');
    await expect(bad).toBeVisible();
    await expect(bad).toContainText(/misconfigured/i);
    await expect(bad).toContainText(/secrets may persist/i); // the loud leak-state message

    const ok = page.locator('[data-testid="redaction-badge"][data-health="ok"]');
    await expect(ok).toBeVisible();
    await expect(ok).toContainText(/redacted/i);
  });

  test("fleet indicator: a sensitive-but-unredacted GAP is loud", async ({ page }) => {
    const w = defaultWorld();
    w.checks = [
      listItem({ id: 1, name: "A", sensitive: true, redactionHealth: "misconfigured" }),
      listItem({ id: 2, name: "B", sensitive: true, redactionHealth: "ok" }),
      listItem({ id: 3, name: "C", sensitive: false, redactionHealth: "n/a" }),
    ];
    await mockApi(page, w);
    await page.goto("/monitors");

    const fleet = page.getByTestId("redaction-fleet");
    await expect(fleet).toHaveAttribute("data-state", "gap");
    await expect(fleet).toContainText("1 of 2 sensitive monitors run UNREDACTED");
  });

  test("fleet indicator: the all-clear state when nothing is sensitive (the current fleet B10 state)", async ({ page }) => {
    const w = defaultWorld();
    w.checks = [
      listItem({ id: 1, name: "A", sensitive: false, redactionHealth: "n/a" }),
      listItem({ id: 2, name: "B", sensitive: false, redactionHealth: "n/a" }),
    ];
    await mockApi(page, w);
    await page.goto("/monitors");

    const fleet = page.getByTestId("redaction-fleet");
    await expect(fleet).toHaveAttribute("data-state", "none-sensitive");
    await expect(fleet).toContainText(/no monitors marked sensitive/i);
  });

  test("null-tolerant: a legacy fleet (no redaction_health) shows no fleet line and no badges", async ({ page }) => {
    const w = defaultWorld();
    w.checks = [listItem({ id: 1, name: "A" }), listItem({ id: 2, name: "B" })]; // no redaction fields
    await mockApi(page, w);
    await page.goto("/monitors");

    await expect(page.getByRole("heading", { name: "Monitors" })).toBeVisible();
    await expect(page.getByTestId("redaction-fleet")).toHaveCount(0);
    await expect(page.getByTestId("redaction-badge")).toHaveCount(0);
  });

  test("check-detail: a misconfigured monitor is flagged loudly in the header", async ({ page }) => {
    const w = defaultWorld();
    w.details[2] = detail(
      { id: 2, name: "Secrets API", kind: "http", currentStatus: "pass", sensitive: true, hasRedactPatterns: false, redactionHealth: "misconfigured" },
      [run({ id: 220, checkId: 2, status: "pass" })],
    );
    await mockApi(page, w);
    await page.goto("/checks/2");

    const bad = page.locator('[data-testid="redaction-badge"][data-health="misconfigured"]');
    await expect(bad).toBeVisible();
    await expect(bad).toContainText(/secrets may persist/i);
  });
});
