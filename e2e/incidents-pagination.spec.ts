import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";
import { spreadIncidents } from "./fixtures";

// Incidents straddling the 7d / 30d / 90d windows: 8 / 20 / 65 resolved + 2 open (one 45d old).
function worldWithIncidents() {
  const world = defaultWorld();
  world.incidents = spreadIncidents();
  return world;
}

const open = (page: import("@playwright/test").Page) => page.getByTestId("incidents-open");
const resolved = (page: import("@playwright/test").Page) => page.getByTestId("incidents-resolved");

test.describe("incidents pagination + date-range", () => {
  test("open list is unwindowed; resolved default is the recent 30d and BOUNDED", async ({ page }) => {
    await mockApi(page, worldWithIncidents());
    await page.goto("/incidents");

    // Open: BOTH open incidents show — including the one opened 45d ago (older than the 30d window),
    // proving the open list is not date-clipped.
    await expect.poll(() => open(page).getByTestId("incident-row").count()).toBe(2);
    await expect(page.locator('a[href="/incidents/6901"]')).toBeVisible(); // the 45d-old open incident

    // Resolved default 30d is pre-pressed and bounded: 20 of the 65 resolved (the rest are >30d old).
    await expect(
      resolved(page).getByRole("button", { name: "30d", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => resolved(page).getByTestId("incident-row").count()).toBe(20);
    await expect(page.getByTestId("incidents-load-more")).toHaveCount(0); // 20 < one 50-row page
  });

  test("the resolved date-range control filters the window", async ({ page }) => {
    await mockApi(page, worldWithIncidents());
    await page.goto("/incidents");
    await expect.poll(() => resolved(page).getByTestId("incident-row").count()).toBe(20); // 30d default

    // Narrow to 7d → fewer resolved.
    await resolved(page).getByRole("button", { name: "Last 7d", exact: true }).click();
    await expect.poll(() => resolved(page).getByTestId("incident-row").count()).toBe(8);
    await expect(page.getByTestId("incidents-load-more")).toHaveCount(0);

    // Widen to 90d → the first 50-row page, with more to come.
    await resolved(page).getByRole("button", { name: "90d", exact: true }).click();
    await expect.poll(() => resolved(page).getByTestId("incident-row").count()).toBe(50);
    await expect(page.getByTestId("incidents-load-more")).toBeVisible();
  });

  test("Load more walks the resolved cursor to the end of the window", async ({ page }) => {
    await mockApi(page, worldWithIncidents());
    await page.goto("/incidents");

    await resolved(page).getByRole("button", { name: "90d", exact: true }).click();
    await expect.poll(() => resolved(page).getByTestId("incident-row").count()).toBe(50); // first page

    await page.getByTestId("incidents-load-more").click();
    // Second page brings the remaining 15 → 65 total, then the window is exhausted.
    await expect.poll(() => resolved(page).getByTestId("incident-row").count()).toBe(65);
    await expect(page.getByTestId("incidents-load-more")).toHaveCount(0);
  });
});
