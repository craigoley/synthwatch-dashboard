import { test, expect } from "@playwright/test";

import { mockApi } from "./mock";

// ★ Regression lock for the mobile-header overflow: at ~390px the nav used to clip
// ("Incide…") and push Monitors off-screen. Originally only the first three tabs were locked; the nav
// then grew to seven items and its overflow-x-auto CLIPPED the rest with no fade/chevron/any affordance
// ("Catalog" rendered as "atalog") — hidden navigation, the failure #253 fixed on the Reports sub-tabs.
// The nav now WRAPS on mobile, so EVERY item must sit fully inside the viewport at rest.
test.describe("header (phone width)", () => {
  test("★ ALL seven nav tabs fully inside the viewport (none clipped, none off-screen) + fleet badges at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockApi(page);
    await page.goto("/");

    for (const name of ["Status", "Incidents", "Monitors", "Catalog", "Notifications", "Reports", "Environments"]) {
      const link = page.getByRole("link", { name, exact: true }).first();
      await expect(link).toBeVisible();
      const box = await link.boundingBox();
      expect(box).toBeTruthy();
      // fully within the 390px viewport (not clipped / off-screen)
      expect(box?.x ?? -1, `${name} left edge`).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0), `${name} right edge`).toBeLessThanOrEqual(391);
    }

    // the wrap fixes the row itself — the HEADER must not scroll horizontally (page-level overflow is
    // owned by page content and can be transiently non-zero while charts mount; not this test's concern)
    const headerOverflow = await page.evaluate(() => {
      const h = document.querySelector("header")!;
      return h.scrollWidth - h.clientWidth;
    });
    expect(headerOverflow).toBe(0);

    // incident-count badges stay visible on the phone header
    await expect(page.locator('[aria-label="fleet status summary"]')).toBeVisible();
  });

  // ★ #254's review catch: sm:flex-nowrap left a 640–1150px band where the single row overflowed the
  // header with NO scroll and NO wrap (measured: 496px over at 640, 287px at 768, 112px at lg/1024) —
  // the same hidden-content failure, relocated to tablet. The wrap now stays engaged until xl (1280).
  for (const width of [640, 768, 1024]) {
    test(`tablet band (${width}px): all seven nav tabs fully visible — wrapped, no header overflow`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mockApi(page);
      await page.goto("/");
      for (const name of ["Status", "Incidents", "Monitors", "Catalog", "Notifications", "Reports", "Environments"]) {
        const box = (await page.getByRole("link", { name, exact: true }).first().boundingBox())!;
        expect(box.x, `${name} left edge`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${name} right edge`).toBeLessThanOrEqual(width + 1);
      }
      const headerOverflow = await page.evaluate(() => {
        const h = document.querySelector("header")!;
        return h.scrollWidth - h.clientWidth;
      });
      expect(headerOverflow).toBe(0);
    });
  }

  test("desktop (1280px = xl): the nav is a single row on the h-14 bar (wrap disengages)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await mockApi(page);
    await page.goto("/");
    const first = (await page.getByRole("link", { name: "Status", exact: true }).first().boundingBox())!;
    const last = (await page.getByRole("link", { name: "Environments", exact: true }).first().boundingBox())!;
    expect(Math.abs(first.y - last.y), "first and last nav item on the same row").toBeLessThan(2);
    const headerOverflow = await page.evaluate(() => {
      const h = document.querySelector("header")!;
      return h.scrollWidth - h.clientWidth;
    });
    expect(headerOverflow, "single row must actually FIT at xl").toBe(0);
  });
});
