import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";
import { detail, run, runStep } from "./fixtures";

// ★ a11y: the funnel's failed step must be legible WITHOUT colour (≈8% of men are red-green colourblind).
// It carries a text headline, a ✕ on the failed cell, and a ✕/✓ glyph per legend row.
test.describe("funnel — failed step is not conveyed by colour alone", () => {
  function worldWithFailedRun() {
    const w = defaultWorld();
    const at = new Date(Date.now() - 60_000).toISOString();
    w.details[1] = detail(
      { id: 1, name: "Shop flow", kind: "browser", flowName: "shop", currentStatus: "error" },
      [run({ id: 900, checkId: 1, status: "error", failedStep: "checkout-pickup", startedAt: at, errorMessage: "locator timeout" })],
    );
    w.steps = { 900: [
      runStep({ id: 1, runId: 900, stepIndex: 0, name: "login", status: "pass", durationMs: 19000 }),
      runStep({ id: 2, runId: 900, stepIndex: 1, name: "add-bread", status: "pass", durationMs: 24000 }),
      runStep({ id: 3, runId: 900, stepIndex: 2, name: "checkout-pickup", status: "fail", durationMs: 5000, errorMessage: "locator.click timeout" }),
      runStep({ id: 4, runId: 900, stepIndex: 3, name: "logout", status: "pass", durationMs: 2000 }),
    ] };
    return w;
  }

  test("★ a text headline names the failed step (not just a red cell)", async ({ page }) => {
    await mockApi(page, worldWithFailedRun());
    await page.goto("/checks/1");
    // the newest run auto-expands → the funnel renders
    const headline = page.getByTestId("funnel-failed-step");
    await expect(headline).toBeVisible();
    await expect(headline).toContainText("Failed at step 3");
    await expect(headline).toContainText("checkout-pickup");
    await expect(headline).toContainText("✕"); // a SHAPE glyph, not only hue
  });

  test("the legend marks the failed step with ✕ and passing steps with ✓", async ({ page }) => {
    await mockApi(page, worldWithFailedRun());
    await page.goto("/checks/1");
    await expect(page.getByTestId("funnel-failed-step")).toBeVisible();
    // ✕ appears for the failed step; ✓ for passing steps — legible in greyscale
    await expect(page.getByText("✕", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("✓", { exact: false }).first()).toBeVisible();
  });
});
