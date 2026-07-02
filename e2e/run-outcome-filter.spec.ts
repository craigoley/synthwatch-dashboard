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

function mixedWorld() {
  const w = defaultWorld();
  // one run per bucket, newest-first (the mock sorts DESC started_at anyway)
  const runs = [
    run({ id: 5, checkId: CID, status: "pass", startedAt: "2026-07-02T10:05:00Z" }),
    run({ id: 4, checkId: CID, status: "warn", startedAt: "2026-07-02T10:04:00Z" }),
    run({ id: 3, checkId: CID, status: "fail", startedAt: "2026-07-02T10:03:00Z" }),
    run({ id: 2, checkId: CID, status: "error", startedAt: "2026-07-02T10:02:00Z" }),
    run({ id: 1, checkId: CID, status: "infra_error", startedAt: "2026-07-02T10:01:00Z" }),
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
