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
