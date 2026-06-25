import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";
import { detail, spreadRuns } from "./fixtures";

// A check whose runs straddle the 7d / 30d / 90d windows: 30 in 7d, 50 in 30d, 60 in 90d.
// The 90d window (60 > one 50-run page) is what makes "Load more" appear.
function worldWithSpread() {
  const world = defaultWorld();
  world.details[20] = detail({ id: 20, name: "Paginated", kind: "http" }, spreadRuns(20));
  return world;
}

function rangeControl(page: import("@playwright/test").Page) {
  return page.getByTestId("run-history");
}

test.describe("runs pagination + date-range", () => {
  test("default window is the recent 7d and BOUNDED — not an all-time load", async ({ page }) => {
    await mockApi(page, worldWithSpread());
    await page.goto("/checks/20");

    // 7d is the default (pre-pressed); only the 30 runs inside it load — the 30 older runs do not.
    await expect(
      rangeControl(page).getByRole("button", { name: "Last 7d", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => page.getByTestId("run-row").count()).toBe(30);
    // 30 < one 50-run page → the query is exhausted, no Load more.
    await expect(page.getByTestId("run-history-load-more")).toHaveCount(0);
  });

  test("the date-range control filters the window", async ({ page }) => {
    await mockApi(page, worldWithSpread());
    await page.goto("/checks/20");
    await expect.poll(() => page.getByTestId("run-row").count()).toBe(30); // 7d default

    // Widen to 90d → more runs in range; the first page caps at 50 with more to come.
    await rangeControl(page).getByRole("button", { name: "90d", exact: true }).click();
    await expect.poll(() => page.getByTestId("run-row").count()).toBe(50);
    await expect(page.getByTestId("run-history-load-more")).toBeVisible();

    // Narrow back to 7d → fewer runs again, and Load more is gone.
    await rangeControl(page).getByRole("button", { name: "Last 7d", exact: true }).click();
    await expect.poll(() => page.getByTestId("run-row").count()).toBe(30);
    await expect(page.getByTestId("run-history-load-more")).toHaveCount(0);
  });

  test("Load more walks the cursor to the end of the window", async ({ page }) => {
    await mockApi(page, worldWithSpread());
    await page.goto("/checks/20");

    await rangeControl(page).getByRole("button", { name: "90d", exact: true }).click();
    await expect.poll(() => page.getByTestId("run-row").count()).toBe(50); // first page

    await page.getByTestId("run-history-load-more").click();
    // Second page brings the remaining 10 → 60 total, then the window is exhausted.
    await expect.poll(() => page.getByTestId("run-row").count()).toBe(60);
    await expect(page.getByTestId("run-history-load-more")).toHaveCount(0);
  });

  test("a check with no runs in the window shows a graceful empty state", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await mockApi(page); // default world: check 9 has no runs
    await page.goto("/checks/9");

    await expect(page.getByText(/No runs recorded yet/i)).toBeVisible();
    await expect(page.getByTestId("run-history-load-more")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
