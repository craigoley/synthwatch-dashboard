import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";
import { listItem } from "./fixtures";

// "Run all" on /monitors — fan out the per-check Run-now trigger across the filtered set, with a capped
// fan-out, live aggregate progress, partial-failure surfacing, and an editor-only gate.

test.describe("Run all (monitors)", () => {
  test("triggers the filtered set, shows live aggregate, then re-enables with the result", async ({ page }) => {
    const w = defaultWorld();
    w.checks = [
      listItem({ id: 1, name: "Alpha", currentStatus: "pass" }),
      listItem({ id: 2, name: "Bravo", currentStatus: "pass" }),
      listItem({ id: 3, name: "Charlie", currentStatus: "pass" }),
    ];
    const triggered: number[] = [];
    page.on("request", (r) => {
      const mt = r.url().match(/\/api\/checks\/(\d+)\/run$/);
      if (mt && r.method() === "POST") triggered.push(Number(mt[1]));
    });
    await mockApi(page, w);
    await page.goto("/monitors");

    const btn = page.getByTestId("run-all-button");
    await expect(btn).toHaveText("Run 3 monitors"); // count is always on the button — never a surprise mass-fire

    await btn.click();
    await expect(btn).toBeDisabled(); // disabled while the batch is in flight

    // the whole filtered set was triggered (the fan-out)
    await expect.poll(() => triggered.slice().sort((a, b) => a - b)).toEqual([1, 2, 3]);

    // the runs complete off-cron — advance each monitor's latest run (2 pass, 1 fail)
    const later = new Date(Date.now() + 5000).toISOString();
    w.checks = [
      listItem({ id: 1, name: "Alpha", currentStatus: "pass", lastRunAt: later }),
      listItem({ id: 2, name: "Bravo", currentStatus: "fail", lastRunAt: later }),
      listItem({ id: 3, name: "Charlie", currentStatus: "pass", lastRunAt: later }),
    ];

    // aggregate settles LIVE (the fast-poll), no reload → result summary + button re-enabled
    await expect(page.getByTestId("run-all-progress")).toContainText("2 passed, 1 failed", { timeout: 10_000 });
    await expect(btn).toBeEnabled();
  });

  test("a monitor that can't start is surfaced without aborting the rest", async ({ page }) => {
    const w = defaultWorld();
    w.checks = [
      listItem({ id: 1, name: "Alpha", currentStatus: "pass" }),
      listItem({ id: 2, name: "Bravo", currentStatus: "pass" }),
    ];
    w.runTriggerFailIds = [2]; // Bravo's trigger 500s
    await mockApi(page, w);
    await page.goto("/monitors");

    await page.getByTestId("run-all-button").click();

    // Alpha runs + completes; Bravo never started (its trigger failed)
    const later = new Date(Date.now() + 5000).toISOString();
    w.checks = [
      listItem({ id: 1, name: "Alpha", currentStatus: "pass", lastRunAt: later }),
      listItem({ id: 2, name: "Bravo", currentStatus: "pass" }), // unchanged → didn't start
    ];

    await expect(page.getByTestId("run-all-trigger-failed")).toContainText(/1 couldn.t start/, { timeout: 10_000 });
    await expect(page.getByTestId("run-all-button")).toBeEnabled(); // batch finished, not stuck
  });

  test("Run all is editor-only — hidden for a signed-out viewer", async ({ page }) => {
    await mockApi(page, defaultWorld(), { seedSession: false });
    await page.goto("/monitors");

    await expect(page.getByRole("heading", { name: "Monitors" })).toBeVisible();
    await expect(page.getByTestId("run-all-button")).toHaveCount(0); // no compute-spending trigger for viewers
  });
});
