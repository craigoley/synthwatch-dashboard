import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

// React error boundaries: a render throw must degrade to an inline recovery panel WITH the app shell/nav still
// alive — NOT a white screen. Exercised via the inert /throw-test self-test route (?boom=1 forces a throw).

test.describe("error boundaries", () => {
  test("a render throw shows the recovery panel and the shell/nav still works (not a white screen)", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/throw-test?boom=1");

    // the route-segment boundary (app/error.tsx) caught the throw → recovery UI, not a blank page
    const boundary = page.getByTestId("error-boundary");
    await expect(boundary).toBeVisible();
    await expect(page.getByTestId("error-retry")).toBeVisible();

    // ★ the app shell + nav survived (the boundary renders inside the layout) → the user can navigate away
    await page.getByRole("link", { name: "Monitors" }).click();
    await expect(page).toHaveURL(/\/monitors$/);
    await expect(page.getByRole("heading", { name: "Monitors" })).toBeVisible();
  });

  test("the self-test route is inert without the flag (no accidental error UI)", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/throw-test");

    await expect(page.getByText(/self-test route/i)).toBeVisible();
    await expect(page.getByTestId("error-boundary")).toHaveCount(0);
  });
});
