import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";
import { detail, run } from "./fixtures";
import type { RawObj } from "./fixtures";

// P3 error-diff panel on the monitor detail page. NEW leads + expanded; first-party by default with
// third-party behind a counted toggle; severity-sorted; truncation flagged; positive empty state.

const item = (o: RawObj): RawObj => ({
  fingerprint: "fp", kind: "console-error", origin: "first-party", level: "error", status: null,
  sourceHost: "www.wegmans.com", message: "an error", count: 1, severity: 4, severityLabel: "first-party-error",
  firstSeenRunId: 946553, ...o,
});

// Craig's scenario on the shop-flow: first-party API 5xx/4xx + console error ABOVE third-party tracker noise.
function worldWithDiff(diff: RawObj) {
  const w = defaultWorld();
  w.details[1] = detail({ id: 1, name: "Wegmans full shop flow", kind: "browser", flowName: "shop" }, [run({ id: 946553, status: "pass" })]);
  w.errorDiff = { 1: diff };
  return w;
}

const FULL_DIFF: RawObj = {
  checkId: 1, runId: 946553, runStartedAt: "2026-07-11T23:57:19Z", location: "eastus2",
  baselineRunIds: [946000, 946100, 946200, 946300],
  new: [
    item({ fingerprint: "n5", kind: "net-5xx", status: 503, sourceHost: "api.digitaldevelopment.wegmans.cloud", message: "GET /cart returned 503", count: 2, severity: 6, severityLabel: "first-party-5xx",
      firstSeenAfterDeploy: { sha: "abc1234def", deployedAt: "2026-07-11T22:00:00Z", targetHost: "www.wegmans.com" } }),
    item({ fingerprint: "n4", kind: "net-4xx", status: 400, sourceHost: "api.digitaldevelopment.wegmans.cloud", message: "POST /cooklist returned 400", count: 1, severity: 5, severityLabel: "first-party-4xx" }),
    item({ fingerprint: "nc", kind: "console-error", sourceHost: "www.wegmans.com", message: "Cannot read properties of undefined (reading 'cart')", count: 3, severity: 4, severityLabel: "first-party-error" }),
    item({ fingerprint: "t1", kind: "net-4xx", origin: "third-party", status: 403, sourceHost: "doubleclick.net", message: "blocked ad request", count: 5, severity: 1, severityLabel: "third-party" }),
    item({ fingerprint: "t2", kind: "csp", origin: "third-party", sourceHost: "rlcdn.com", message: "csp blocked frame", count: 1, severity: 1, severityLabel: "third-party" }),
  ],
  persistent: [item({ fingerprint: "p1", message: "persistent console warning", severity: 2, severityLabel: "warning" })],
  resolved: [item({ fingerprint: "r1", message: "resolved 500", kind: "net-5xx", status: 500, severity: 6, severityLabel: "first-party-5xx" })],
  counts: { newFirstParty: 3, newThirdParty: 2, persistentFirstParty: 1, persistentThirdParty: 0, resolvedFirstParty: 1, resolvedThirdParty: 0 },
  truncated: true, baselineRunCount: 4,
};

test.describe("monitor detail — error-diff panel", () => {
  test("NEW leads, first-party severity-sorted, third-party behind a counted toggle, truncation flagged", async ({ page }) => {
    await mockApi(page, worldWithDiff(FULL_DIFF));
    await page.goto("/checks/1");

    const panel = page.getByTestId("error-diff");
    await expect(panel).toBeVisible();
    // ★ context line: what it's comparing
    await expect(panel.getByTestId("error-diff-context")).toContainText("run #946553");
    await expect(panel.getByTestId("error-diff-context")).toContainText("last 4 runs");
    await expect(panel.getByTestId("error-diff-context")).toContainText("eastus2");
    // ★ truncation note (946553 dropped errors)
    await expect(panel.getByTestId("error-diff-truncated")).toContainText(/incomplete/i);

    // ★ NEW body shows the 3 first-party items severity-sorted (5xx first), third-party HIDDEN by default.
    const newBody = panel.getByTestId("error-diff-new-body");
    const firstPartyRows = newBody.getByTestId("ediff-row");
    await expect(firstPartyRows).toHaveCount(3); // only first-party shown
    await expect(firstPartyRows.first()).toContainText("GET /cart returned 503"); // 5xx at the top
    await expect(newBody.getByText(/blocked ad request/)).toHaveCount(0); // third-party not shown yet

    // ★ third-party behind a counted toggle
    const toggle = newBody.getByTestId("ediff-thirdparty-toggle");
    await expect(toggle).toContainText("2 third-party");
    await toggle.click();
    await expect(newBody.getByTestId("ediff-thirdparty-list")).toContainText("blocked ad request");

    // ★ persistent + resolved collapsed below, expand on click
    await expect(panel.getByTestId("error-diff-persistent-toggle")).toContainText("Persistent");
    await expect(panel.getByText("persistent console warning")).toHaveCount(0);
    await panel.getByTestId("error-diff-persistent-toggle").click();
    await expect(panel.getByText("persistent console warning")).toBeVisible();
  });

  test("positive empty state when there are no new errors", async ({ page }) => {
    const empty: RawObj = { ...FULL_DIFF, new: [], counts: { ...(FULL_DIFF.counts as RawObj), newFirstParty: 0, newThirdParty: 0 }, truncated: false };
    await mockApi(page, worldWithDiff(empty));
    await page.goto("/checks/1");

    await expect(page.getByTestId("error-diff-empty")).toContainText(/no new errors/i);
    await expect(page.getByTestId("error-diff-empty")).toContainText("last 4 runs");
    await expect(page.getByTestId("error-diff-truncated")).toHaveCount(0); // not truncated → no note
  });

  test("P4: a NEW error shows the deploy it first appeared after (correlation)", async ({ page }) => {
    await mockApi(page, worldWithDiff(FULL_DIFF));
    await page.goto("/checks/1");

    // The 5xx row carries firstSeenAfterDeploy → the panel renders "first seen after deploy abc1234 · …".
    const deploy = page.getByTestId("error-diff-new-body").getByTestId("ediff-deploy").first();
    await expect(deploy).toContainText(/first seen after/i);
    await expect(deploy).toContainText("abc1234"); // short sha (7 chars)
  });

  test("P4: mute a NEW error → it leaves NEW, shows in the muted disclosure, unmute restores it", async ({ page }) => {
    await mockApi(page, worldWithDiff(FULL_DIFF)); // seeded editor → mute controls visible
    await page.goto("/checks/1");

    const newBody = page.getByTestId("error-diff-new-body");
    await expect(newBody.getByTestId("ediff-row")).toHaveCount(3);

    // Mute the top row (GET /cart 503). Click "mute" → note field appears → confirm.
    const topRow = newBody.getByTestId("ediff-row").first();
    await topRow.getByTestId("ediff-mute-btn").click();
    await topRow.getByTestId("ediff-mute-note").fill("known flaky cart API");
    await topRow.getByTestId("ediff-mute-confirm").click();

    // ★ it leaves NEW (now 2 first-party rows) and NEVER disappears — the muted disclosure surfaces it.
    await expect(newBody.getByTestId("ediff-row")).toHaveCount(2);
    await expect(newBody.getByText("GET /cart returned 503")).toHaveCount(0);
    const muted = page.getByTestId("error-diff-muted");
    await expect(muted.getByTestId("error-diff-muted-toggle")).toContainText("Muted");
    await expect(muted.getByTestId("error-diff-muted-toggle")).toContainText("(1)");
    await muted.getByTestId("error-diff-muted-toggle").click();
    await expect(muted.getByTestId("error-diff-muted-list")).toContainText("GET /cart returned 503");
    await expect(muted.getByTestId("error-diff-muted-list")).toContainText("known flaky cart API"); // the note

    // Unmute → the error returns to NEW (3 rows again) and the disclosure disappears.
    await muted.getByTestId("ediff-unmute-btn").first().click();
    await expect(newBody.getByTestId("ediff-row")).toHaveCount(3);
    await expect(newBody.getByText("GET /cart returned 503")).toBeVisible();
    await expect(page.getByTestId("error-diff-muted")).toHaveCount(0);
  });

  test("self-hides when the endpoint 404s (no error signals for this run)", async ({ page }) => {
    const w = defaultWorld();
    w.details[1] = detail({ id: 1, name: "Wegmans full shop flow", kind: "browser", flowName: "shop" }, [run({ id: 1, status: "pass" })]);
    // no world.errorDiff → the mock 404s
    await mockApi(page, w);
    await page.goto("/checks/1");

    await expect(page.getByRole("heading", { name: "Wegmans full shop flow" })).toBeVisible();
    await expect(page.getByTestId("error-diff")).toHaveCount(0);
  });
});

// ★ Class-aware truncation (synthwatch-api#229): stay LOUD only when first-party was dropped OR the drop class
// is UNKNOWN; go calm only when we AFFIRMATIVELY know it was third-party (tracker) noise. FULL_DIFF carries NO
// class fields, so it exercises the unknown → LOUD path.
test.describe("monitor detail — error-diff truncation, by class", () => {
  test("first-party dropped → stays LOUD (the diff may be incomplete)", async ({ page }) => {
    const diff: RawObj = { ...FULL_DIFF, truncated: true, firstPartyTruncated: true, droppedThirdParty: 12 };
    await mockApi(page, worldWithDiff(diff));
    await page.goto("/checks/1");

    const note = page.getByTestId("error-diff-truncated");
    await expect(note).toContainText(/first-party errors were dropped/i);
    await expect(note).toContainText(/incomplete/i);
    await expect(page.getByTestId("error-diff-truncated-third-party")).toHaveCount(0);
  });

  test("only third-party dropped (known) → CALM: first-party capture is complete", async ({ page }) => {
    const diff: RawObj = { ...FULL_DIFF, truncated: true, firstPartyTruncated: false, droppedThirdParty: 7 };
    await mockApi(page, worldWithDiff(diff));
    await page.goto("/checks/1");

    const note = page.getByTestId("error-diff-truncated-third-party");
    await expect(note).toContainText("7 third-party errors were dropped");
    await expect(note).toContainText(/first-party capture is complete/i);
    await expect(page.getByTestId("error-diff-truncated")).toHaveCount(0); // NOT the loud generic/first-party note
  });

  test("a single third-party drop reads 'error was', not 'errors were'", async ({ page }) => {
    const diff: RawObj = { ...FULL_DIFF, truncated: true, firstPartyTruncated: false, droppedThirdParty: 1 };
    await mockApi(page, worldWithDiff(diff));
    await page.goto("/checks/1");

    await expect(page.getByTestId("error-diff-truncated-third-party")).toContainText("1 third-party error was dropped");
  });

  test("★ honest-render: truncated but drop-class UNKNOWN (pre-#229 API) → LOUD generic, never 'complete'", async ({ page }) => {
    // FULL_DIFF omits firstPartyTruncated/droppedThirdParty → both default false/0. We do NOT know first-party
    // capture was complete, so it must stay LOUD — the calm "complete" copy would be a fake-healthy claim.
    await mockApi(page, worldWithDiff({ ...FULL_DIFF, truncated: true }));
    await page.goto("/checks/1");

    await expect(page.getByTestId("error-diff-truncated")).toContainText(/some errors were dropped/i);
    await expect(page.getByTestId("error-diff-truncated")).toContainText(/incomplete/i);
    await expect(page.getByTestId("error-diff-truncated-third-party")).toHaveCount(0); // never implies completeness
  });
});

// ★ The JOIN: on a FAILED run, the run's NEW first-party errors render INLINE on the run row (next to the
// failed step / error message) so the operator sees the failure AND the new error signal without opening the
// monitor-level panel — run 955866: add-bread failed while a first-party `Failed to fetch` fired.
test.describe("failed run — NEW first-party errors joined onto the run row", () => {
  const FETCH_FAIL: RawObj = {
    checkId: 1, runId: 955866, location: "eastus2", baselineRunIds: [1, 2, 3, 4],
    new: [
      item({ fingerprint: "ff", kind: "net-error", status: null, sourceHost: "api.digitaldevelopment.wegmans.cloud",
        message: "Product API Error: Failed to fetch", count: 3, severity: 6, severityLabel: "first-party-5xx",
        firstSeenAfterDeploy: { sha: "abc1234def", deployedAt: "2026-07-12T22:00:00Z", targetHost: "www.wegmans.com" } }),
      item({ fingerprint: "t1", kind: "net-4xx", origin: "third-party", status: 403, sourceHost: "doubleclick.net", message: "blocked ad request", count: 5, severity: 1, severityLabel: "third-party" }),
    ],
    persistent: [], resolved: [],
    counts: { newFirstParty: 1, newThirdParty: 1, persistentFirstParty: 0, persistentThirdParty: 0, resolvedFirstParty: 0, resolvedThirdParty: 0 },
    truncated: false, baselineRunCount: 4,
  };

  function worldWithFailedRun(diff: RawObj | null) {
    const w = defaultWorld();
    const at = new Date(Date.now() - 60_000).toISOString(); // recent → inside the run-history (now-7d) window
    w.details[1] = detail(
      { id: 1, name: "Wegmans full shop flow", kind: "browser", flowName: "shop", currentStatus: "error" },
      [run({ id: 955866, status: "error", failedStep: "add-bread", startedAt: at, errorMessage: "Add to Cart affordance not found — expected element visible within 20000ms" })],
    );
    if (diff) w.errorDiff = { 1: diff };
    return w;
  }

  // The newest run auto-expands on load (run-history #126), so the failed run's body is open without a click.
  async function openFailedRun(page: import("@playwright/test").Page) {
    await expect(page.getByTestId("run-history")).toBeVisible();
    await expect(page.locator("#run-955866")).toContainText("✕ add-bread"); // the failed STEP is on the row
    await expect(page.getByText("Funnel · run #955866")).toBeVisible(); // body is expanded
  }

  test("★ 955866 replay: the add-bread failure and the NEW first-party 'Failed to fetch' are shown together, no second panel", async ({ page }) => {
    await mockApi(page, worldWithFailedRun(FETCH_FAIL));
    await page.goto("/checks/1");
    await openFailedRun(page);

    // ★ BOTH facts in the SAME expanded run body — no navigation to the monitor-level error-diff panel.
    const join = page.getByTestId("run-new-errors");
    await expect(join).toBeVisible();
    const list = join.getByTestId("run-new-errors-list");
    await expect(list).toContainText("Product API Error: Failed to fetch");
    await expect(list).toContainText("api.digitaldevelopment.wegmans.cloud");
    await expect(list).toContainText("×3"); // the captured count
    // deploy correlation rides along (the existing badge, reused)
    await expect(join.getByTestId("ediff-deploy")).toContainText(/first seen after/i);
    await expect(join.getByTestId("ediff-deploy")).toContainText("abc1234");
    // the failure message (the step's error) is right there in the same view — the whole point
    await expect(page.getByText(/Add to Cart affordance not found/)).toBeVisible();

    // ★ third-party tracker noise stays behind the counted toggle (first-party only by default)
    await expect(join.getByText(/blocked ad request/)).toHaveCount(0);
    await expect(join.getByTestId("ediff-thirdparty-toggle")).toContainText("1 third-party");
    await join.getByTestId("ediff-thirdparty-toggle").click();
    await expect(join.getByTestId("ediff-thirdparty-list")).toContainText("blocked ad request");

    // ★ CITES, never GUESSES — no inferred-cause language; the disclaimer is explicit.
    await expect(join).not.toContainText(/caused|probabl|likely|because of/i);
    await expect(join).toContainText(/not inferred as its cause/i);
  });

  test("no new first-party errors (clean capture) → says so EXPLICITLY (itself diagnostic)", async ({ page }) => {
    const clean: RawObj = { ...FETCH_FAIL, new: [], counts: { ...(FETCH_FAIL.counts as RawObj), newFirstParty: 0, newThirdParty: 0 }, truncated: false };
    await mockApi(page, worldWithFailedRun(clean));
    await page.goto("/checks/1");
    await openFailedRun(page);

    const none = page.getByTestId("run-new-errors").getByTestId("run-new-errors-none");
    await expect(none).toContainText(/no new first-party errors this run/i);
    await expect(none).toContainText(/not accompanied by a new error signal/i);
    // it is NOT a truncated case → no "incomplete/truncated" caveat
    await expect(page.getByTestId("run-new-errors").getByTestId("run-new-errors-truncated")).toHaveCount(0);
  });

  test("truncated capture → says capture was incomplete, never implies 'no errors'", async ({ page }) => {
    const truncatedEmpty: RawObj = { ...FETCH_FAIL, new: [], counts: { ...(FETCH_FAIL.counts as RawObj), newFirstParty: 0, newThirdParty: 0 }, truncated: true };
    await mockApi(page, worldWithFailedRun(truncatedEmpty));
    await page.goto("/checks/1");
    await openFailedRun(page);

    const join = page.getByTestId("run-new-errors");
    await expect(join.getByTestId("run-new-errors-truncated")).toContainText(/truncated/i);
    await expect(join.getByTestId("run-new-errors-truncated")).toContainText(/incomplete|can’t be concluded/i);
    // ★ never claims "no errors" when capture may have missed them
    await expect(join.getByTestId("run-new-errors-none")).toHaveCount(0);
  });

  test("self-hides on a run with no captured error signal (endpoint 404s)", async ({ page }) => {
    await mockApi(page, worldWithFailedRun(null)); // no world.errorDiff → the mock 404s
    await page.goto("/checks/1");
    await openFailedRun(page);
    await expect(page.getByTestId("run-new-errors")).toHaveCount(0);
  });
});
