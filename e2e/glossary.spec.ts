import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

// The 2am glossary (Diátaxis REFERENCE) + its entry point from the Trust legend. The copy is the point:
// operator language ("recovered on recheck"), not schema language ("superseded_by_run_id").
test.describe("glossary — the 2am reference", () => {
  test("renders each term in plain, operator-facing language", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/glossary");

    await expect(page.getByTestId("glossary")).toBeVisible();
    // ★ the words an on-call engineer actually hits, each defined
    for (const id of ["trust-chip", "flap", "recheck", "transient", "spurious-red", "flake-budget", "error-diff"]) {
      await expect(page.getByTestId(`glossary-term-${id}`)).toBeVisible();
    }
    // ★ operator language, not the schema's — "flap" is "recovered on recheck", not "superseded_by_run_id"
    await expect(page.getByTestId("glossary-term-flap")).toContainText(/recovered on recheck|passed on an automatic recheck/i);
    await expect(page.getByTestId("glossary-term-flap")).not.toContainText(/superseded_by_run_id/);
    // spurious-red = the monitor's OWN fault, and n/a for simple checks (the honest framing)
    await expect(page.getByTestId("glossary-term-spurious-red")).toContainText(/cried wolf|its own fault/i);
    await expect(page.getByTestId("glossary-term-spurious-red")).toContainText(/http\/dns\/ssl.*isn.t applicable|not applicable/i);
    // monitor-side vs service-side: the good/bad distinction is explicit
    await expect(page.getByTestId("glossary-term-transient")).toContainText(/service-side/i);
    await expect(page.getByTestId("glossary-term-transient")).toContainText(/monitor-side/i);
    await expect(page.getByTestId("glossary-term-transient")).toContainText(/crying wolf|cry/i);
  });

  test("★ the Trust legend links to the glossary (the 2am entry point)", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/reports?tab=trust");

    const link = page.getByTestId("trust-legend-glossary-link");
    await expect(link).toBeVisible();
    await expect(link).toHaveText(/what do these words mean/i);
    await link.click();
    await expect(page).toHaveURL(/\/glossary/);
    await expect(page.getByTestId("glossary-term-flake-budget")).toContainText(/degraded as a monitor/i);
  });
});
