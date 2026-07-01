import { test, expect } from "@playwright/test";

import { mockApi } from "./mock";

/**
 * Client breadcrumb panel — the DEBUG-GATED, in-memory error trail. Verifies the two things only a real
 * browser can: the debug.ts gate hides/shows the panel, and live window errors + unhandled rejections land in
 * it. (Ring eviction + capture-mapping logic is pinned in the pure-Node contract, breadcrumbs.contract.ts.)
 */
test.describe("debug breadcrumbs", () => {
  test("panel is HIDDEN for normal users (no debug flag)", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await expect(page.getByTestId("debug-breadcrumbs")).toHaveCount(0);
  });

  // ★ MUST-GO-RED regression for the leak: SYNTHWATCH_DEBUG=1 is the sticky, general-purpose switch for the
  // INVISIBLE console debug channels (e.g. runsDebug). It must NOT force the VISIBLE breadcrumb panel on. Before
  // the fix the panel rode this global flag, so anyone who ever debugged the runs funnel got it permanently.
  test("panel stays HIDDEN when only the global SYNTHWATCH_DEBUG console flag is set (no ?debug=errors)", async ({ page }) => {
    await mockApi(page);
    await page.addInitScript(() => window.localStorage.setItem("SYNTHWATCH_DEBUG", "1"));
    await page.goto("/"); // a normal navigation — no ?debug=errors
    await expect(page.getByTestId("debug-breadcrumbs")).toHaveCount(0);
  });

  test("panel SHOWS when gated via ?debug=errors", async ({ page }) => {
    await mockApi(page);
    await page.goto("/?debug=errors");
    await expect(page.getByTestId("debug-breadcrumbs")).toBeVisible();
    await expect(page.getByTestId("debug-breadcrumbs")).toContainText("BREADCRUMBS");
  });

  test("panel SHOWS via its dedicated sticky key (SYNTHWATCH_DEBUG_ERRORS=1), not the global flag", async ({ page }) => {
    await mockApi(page);
    await page.addInitScript(() => window.localStorage.setItem("SYNTHWATCH_DEBUG_ERRORS", "1"));
    await page.goto("/"); // no ?debug param — the panel's OWN sticky opt-in, distinct from the console flag
    await expect(page.getByTestId("debug-breadcrumbs")).toBeVisible();
  });

  test("captures a live window error and an unhandled rejection", async ({ page }) => {
    await mockApi(page);
    await page.goto("/?debug=errors");
    await expect(page.getByTestId("debug-breadcrumbs")).toBeVisible();

    await page.evaluate(() => {
      window.dispatchEvent(new ErrorEvent("error", { message: "boom", error: new Error("live boom") }));
      window.dispatchEvent(
        new PromiseRejectionEvent("unhandledrejection", {
          promise: Promise.resolve(), // resolved: we only read `reason`, avoids a real rejection
          reason: new Error("live reject"),
        }),
      );
    });

    const log = page.getByTestId("debug-breadcrumbs-log");
    await expect(log).toContainText("onerror");
    await expect(log).toContainText("live boom");
    await expect(log).toContainText("unhandledrejection");
    await expect(log).toContainText("live reject");
  });

  test("Clear empties the captured trail", async ({ page }) => {
    await mockApi(page);
    await page.goto("/?debug=errors");
    // Wait for the panel to mount (so installErrorCapture's effect has run) BEFORE dispatching — otherwise the
    // event can fire before the listener is attached and the crumb is missed (a flaky race, matches the
    // "captures a live window error" test above).
    await expect(page.getByTestId("debug-breadcrumbs")).toBeVisible();
    await page.evaluate(() => {
      window.dispatchEvent(new ErrorEvent("error", { message: "x", error: new Error("to clear") }));
    });
    await expect(page.getByTestId("debug-breadcrumbs-log")).toContainText("to clear");
    await page.getByTestId("debug-breadcrumbs-clear").click();
    await expect(page.getByText("No client errors captured this session.")).toBeVisible();
  });
});
