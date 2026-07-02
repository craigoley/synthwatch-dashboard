import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

/**
 * The `?? []` / `?? 0` fast-follow to #175: a failed/absent fetch must not render as "all quiet" (empty list,
 * fake zero, or — worst — a green "All Systems Operational"). These must-go-red tests each assert the LOUD
 * error IS shown AND the fake-quiet is NOT — a test that only checked the happy path would pass on the old
 * swallow. `failAllReads` makes every GET 500 (a real error, not a 404-absent).
 */
test.describe("nullish read seams — loud on error, not fake-quiet", () => {
  test("★ status page: a failed checks fetch shows a LOUD error, NOT fake 'All Systems Operational'", async ({ page }) => {
    const w = defaultWorld();
    w.failAllReads = true;
    await mockApi(page, w);
    await page.goto("/status");

    await expect(page.getByTestId("status-load-error")).toBeVisible();
    // ★ the killer: deriveSystemStatus([]) is "operational" → the old swallow rendered a green all-clear banner
    await expect(page.getByText("All Systems Operational")).toHaveCount(0);
    await expect(page.getByText("Partial Outage")).toHaveCount(0);
  });

  test("★ reports monitor list: a failed checks fetch shows a LOUD error, NOT fake 'No monitors to report on'", async ({ page }) => {
    const w = defaultWorld();
    w.failAllReads = true;
    await mockApi(page, w);
    await page.goto("/reports?tab=monitors");

    await expect(page.getByTestId("monitor-list-error")).toBeVisible();
    await expect(page.getByText("No monitors to report on.")).toHaveCount(0); // not a fake-empty fleet
    await expect(page.getByTestId("monitor-list")).toHaveCount(0);
  });

  test("★ specs catalog: a failed fetch shows a LOUD error, NOT a blank/'no specs'", async ({ page }) => {
    const w = defaultWorld();
    w.failAllReads = true;
    await mockApi(page, w);
    await page.goto("/specs");

    await expect(page.getByTestId("specs-load-error")).toBeVisible();
  });
});
