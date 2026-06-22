import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

test.describe("graceful degradation", () => {
  // ★ Retention/expiry: the DB url persists but the blob is gone (404). The <img>
  // onError must show a neutral "unavailable" — not a broken-image icon, no crash.
  test("an expired (404) screenshot shows 'unavailable', no broken image", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    const world = defaultWorld();
    world.screenshot404 = true;
    await mockApi(page, world);
    await page.goto("/checks/2");

    await expect(page.getByText(/Screenshot unavailable/i)).toBeVisible();
    // the broken <img> is replaced by the fallback, not left dangling
    await expect(page.locator('img[alt="Failure screenshot for run 200"]')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("API error renders a sane error state, not a white screen", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    const world = defaultWorld();
    world.failAllReads = true;
    await mockApi(page, world);
    await page.goto("/");

    // the home page shows ErrorState ("ERROR · …"), and the app shell still renders
    await expect(page.getByText(/ERROR/).first()).toBeVisible();
    expect(errors).toEqual([]);
  });
});
