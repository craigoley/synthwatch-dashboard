import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";
import { run } from "./fixtures";

/**
 * Run-history outcome filter → api #153's server-side ?outcome=. The honest-bucket assertions are the point:
 * "Failed" is (fail,error) and NEVER folds in infra_error; "Errored" is infra_error alone (it "didn't run",
 * not a failure). Server-side (not client) because the list is cursor-paginated — the filter must re-fetch
 * page 0, so the count reflects the whole filtered set, not just a loaded page.
 */
const CID = 1;

// ★ Seed timestamps RELATIVE to now, never a hardcoded calendar date. The run-history list defaults to a
// 7d window (useDateRange("7d") → lookbackRange(7) = [now-7d, now]) and the API filters runs to that window,
// so fixed 2026-07-02 seeds fell OUT of range once the wall clock passed +7d and every row vanished (count 0)
// — the frozen-window-vs-advancing-now drift class. Minutes-ago always lands inside the window; mirrors the
// NOW derivation in fixtures.ts. newest-first (descending), one run per bucket.
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function mixedWorld() {
  const w = defaultWorld();
  const runs = [
    run({ id: 5, checkId: CID, status: "pass", startedAt: minutesAgo(1) }),
    run({ id: 4, checkId: CID, status: "warn", startedAt: minutesAgo(2) }),
    run({ id: 3, checkId: CID, status: "fail", startedAt: minutesAgo(3) }),
    run({ id: 2, checkId: CID, status: "error", startedAt: minutesAgo(4) }),
    run({ id: 1, checkId: CID, status: "infra_error", startedAt: minutesAgo(5) }),
  ];
  w.details[CID] = { ...w.details[CID], recentRuns: runs };
  return w;
}

test.describe("run history — outcome filter (api #153)", () => {
  test("All shows every outcome (baseline)", async ({ page }) => {
    await mockApi(page, mixedWorld());
    await page.goto(`/checks/${CID}`);
    await expect(page.getByTestId("run-history")).toBeVisible();
    await expect(page.getByTestId("run-row")).toHaveCount(5);
  });

  test("★ Failed → ?outcome=failed, only fail/error rows, infra_error NOT folded in", async ({ page }) => {
    await mockApi(page, mixedWorld());
    await page.goto(`/checks/${CID}`);
    await expect(page.getByTestId("run-row")).toHaveCount(5);

    // the outbound request carries ?outcome=failed AND no cursor (fresh page 0 = cursor reset for the new filter)
    const reqP = page.waitForRequest(
      (r) => /\/checks\/1\/runs\?/.test(r.url()) && r.url().includes("outcome=failed"),
    );
    await page.getByTestId("run-outcome-failed").click();
    const req = await reqP;
    expect(req.url()).not.toContain("cursor="); // ★ cursor reset — not paging the old unfiltered walk

    // ★ 2 rows (fail + error), NOT 3 — infra_error is its own bucket, never folded into Failed
    await expect(page.getByTestId("run-row")).toHaveCount(2);
  });

  test("★ Errored → only infra_error (its own honest bucket, distinct from Failed)", async ({ page }) => {
    await mockApi(page, mixedWorld());
    await page.goto(`/checks/${CID}`);
    const reqP = page.waitForRequest((r) => r.url().includes("/checks/1/runs?") && r.url().includes("outcome=errored"));
    await page.getByTestId("run-outcome-errored").click();
    await reqP;
    await expect(page.getByTestId("run-row")).toHaveCount(1); // just the infra_error run
  });

  test("Passed → pass + warn", async ({ page }) => {
    await mockApi(page, mixedWorld());
    await page.goto(`/checks/${CID}`);
    await page.getByTestId("run-outcome-passed").click();
    await expect(page.getByTestId("run-row")).toHaveCount(2);
    // switching back to All restores the full set (fresh walk, no stale filtered cursor)
    await page.getByTestId("run-outcome-all").click();
    await expect(page.getByTestId("run-row")).toHaveCount(5);
  });
});
