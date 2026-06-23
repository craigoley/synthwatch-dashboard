import { test, expect } from "@playwright/test";

import { mockApi } from "./mock";

// ★ Regression lock for the mobile-header overflow: at ~390px the nav used to clip
// ("Incide…") and push Monitors off-screen. All three tabs must stay reachable.
test.describe("header (phone width)", () => {
  test("all nav tabs are reachable + fleet badges visible at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockApi(page);
    await page.goto("/");

    for (const name of ["Status", "Incidents", "Monitors"]) {
      const link = page.getByRole("link", { name, exact: true }).first();
      await expect(link).toBeVisible();
      const box = await link.boundingBox();
      expect(box).toBeTruthy();
      // fully within the 390px viewport (not clipped / off-screen)
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(391);
    }

    // incident-count badges stay visible on the phone header
    await expect(page.locator('[aria-label="fleet status summary"]')).toBeVisible();
  });
});
