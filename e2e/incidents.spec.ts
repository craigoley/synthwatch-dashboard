import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";
import { incident, incidentDetail } from "./fixtures";

test.describe("incidents — RCA render", () => {
  test("a populated rca shows the badge, confidence, and observed-vs-inferred", async ({ page }) => {
    await mockApi(page);
    await page.goto("/incidents");

    await expect(page.getByText("Root cause")).toBeVisible();
    await expect(page.getByText("Environment / regional")).toBeVisible();
    await expect(page.getByText(/high confidence/i)).toBeVisible();

    // ★ observed (facts) and inferred (hypotheses) are visually distinct sections
    await expect(page.getByText("Observed · facts")).toBeVisible();
    await expect(page.getByText(/Inferred ·/)).toBeVisible();
    await expect(page.getByText(/westus2 returned 503/)).toBeVisible(); // an observed fact
    await expect(page.getByText(/likely a regional provider outage/)).toBeVisible(); // an inferred hypothesis
  });

  // ★ Graceful-empty (the assertion the prior PR deferred): an rca-null incident
  // renders with NO RCA panel. Only the one populated incident has "Root cause".
  test("an rca-null incident renders with no RCA panel", async ({ page }) => {
    await mockApi(page);
    await page.goto("/incidents");

    await expect(page.getByText("Legacy check")).toBeVisible(); // the rca-null incident row exists
    await expect(page.getByText("Root cause")).toHaveCount(1); // exactly one panel (the populated one)
  });

  // ★ List rows are clickable → /incidents/{id} (the investigation page), while the
  // check-name link still points at the check.
  test("a list row links to the incident detail route", async ({ page }) => {
    await mockApi(page);
    await page.goto("/incidents");

    const rowLink = page.getByRole("link", { name: /Investigate incident 1/ });
    await expect(rowLink).toHaveAttribute("href", "/incidents/1");
    // the check-name link still navigates to the check (not the incident)
    await expect(page.getByRole("link", { name: "Global API" })).toHaveAttribute("href", "/checks/10");
  });
});

// ★ Regression: GET /api/incidents is a CURSOR ENVELOPE ({ items, nextCursor, pageSize }), not a bare
// array. listIncidents used to `.map` the envelope → "(intermediate value).map is not a function", which
// surfaced as the page's ERROR state. These lock in reading `items` (open + resolved fetched separately)
// and graceful empty handling.
// Regression + graceful-empty: the cursor ENVELOPE must render as a list (never the old
// "(intermediate value).map is not a function"), and an empty response → empty states, not a crash.
// (The envelope/pagination behaviour itself is covered in incidents-pagination.spec.ts.)
test.describe("incidents — graceful empty", () => {
  test("empty incidents → empty states in both sections, not a crash", async ({ page }) => {
    const w = defaultWorld();
    w.incidents = [];
    await mockApi(page, w);
    await page.goto("/incidents");

    await expect(page.getByText("All clear — no open incidents.")).toBeVisible();
    await expect(page.getByText("No resolved incidents in this window.")).toBeVisible();
    await expect(page.getByText(/is not a function/)).toHaveCount(0);
    await expect(page.getByText(/^ERROR ·/)).toHaveCount(0);
  });
});

test.describe("incident detail page", () => {
  test("renders the timeline, RCA, recurrence, and metadata", async ({ page }) => {
    await mockApi(page);
    await page.goto("/incidents/1");

    // header metadata + link back to the check
    await expect(page.getByRole("heading", { name: "Incident #1" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Global API" })).toHaveAttribute("href", "/checks/10");

    // RCA (reused panel) with observed-vs-inferred
    await expect(page.getByText("Root cause")).toBeVisible();
    await expect(page.getByText("Real outage")).toBeVisible();
    await expect(page.getByText("Observed · facts")).toBeVisible();

    // ★ timeline centerpiece: rows + screenshot (same-origin proxy) / trace (mints a short-TTL SAS on click,
    // then opens the blob directly) links out — never a bare cross-origin API href (bearer-gated #154 → 401).
    await expect(page.getByRole("heading", { name: "Run timeline" })).toBeVisible();
    await expect(page.getByText("503 Service Unavailable from westus2")).toBeVisible();
    const shot = page.getByRole("link", { name: /screenshot/ });
    await expect(shot).toHaveAttribute("href", "/screenshot-proxy/1001");
    await expect(page.getByRole("button", { name: /trace/ })).toBeVisible(); // SAS on click, no proxy path
    // ★ each timeline row deep-links into the check's run history — the #run-<id> anchor is where
    // the funnel, AI insights, baseline-diff, and embedded trace viewer live
    await expect(page.getByTestId("timeline-run-link-1001")).toHaveAttribute("href", "/checks/10#run-1001");

    // recurrence links to a sibling incident
    await expect(page.getByRole("heading", { name: "Recurrence" })).toBeVisible();
    await expect(page.getByRole("link", { name: /earlier westus2 blip/ })).toHaveAttribute("href", "/incidents/3");
  });

  test("★ deploy-proximity: renders nearby deploys (before + after, SHA + fingerprint) as correlation, not causation", async ({ page }) => {
    await mockApi(page);
    await page.goto("/incidents/1");
    const section = page.getByTestId("incident-nearby-deploys");
    await expect(section).toBeVisible();
    // ★ WORDING IS LOAD-BEARING: correlation not causation; timestamp is DETECTION time
    await expect(section).toContainText("not causation");
    await expect(section).toContainText("detection");
    await expect(section).not.toContainText("caused by");
    await expect(section).not.toContainText("broke");
    // two rows: -15min (SHA → short-SHA) before, +5min (fingerprint/etag) after
    await expect(section.getByTestId("incident-nearby-deploy")).toHaveCount(2);
    await expect(section).toContainText("15 min before");
    await expect(section).toContainText("abcdef1"); // short SHA (7 chars)…
    await expect(section).not.toContainText("abcdef1234567890"); // …not the full 16
    await expect(section).toContainText("5 min after");
    await expect(section).toContainText("etag-9f8e");
  });

  test("★ deploy-proximity: absent (honest-empty) when there are no nearby deploys — no fabricated row", async ({ page }) => {
    await mockApi(page);
    await page.goto("/incidents/2"); // fixture has no nearbyDeploys → mapper → [] → section absent
    await expect(page.getByRole("heading", { name: "Incident #2" })).toBeVisible();
    await expect(page.getByTestId("incident-nearby-deploys")).toHaveCount(0);
  });

  test("★ deploy-proximity: a fetch error is LOUD (ErrorState), never silently absent", async ({ page }) => {
    const w = defaultWorld();
    w.failAllReads = true; // the incident GET 500s → the whole detail errors (this data rides that payload)
    await mockApi(page, w);
    await page.goto("/incidents/1");
    await expect(page.getByText(/ERROR ·/)).toBeVisible(); // loud ErrorState (#175), not a silent blank
    await expect(page.getByTestId("incident-nearby-deploys")).toHaveCount(0);
  });

  test("an rca-null incident detail renders with no RCA panel", async ({ page }) => {
    await mockApi(page);
    await page.goto("/incidents/2");

    await expect(page.getByRole("heading", { name: "Incident #2" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Run timeline" })).toBeVisible(); // timeline still renders
    await expect(page.getByText("Root cause")).toHaveCount(0); // no RCA panel
  });

  // ★ Forward-compatible timeline cap (api-side bounded timeline): when the API reports a total larger
  // than the rows it served, the count captions "showing newest N of M" — honest truncation, never a
  // silent partial list. Absent field (today's API) → the plain "(N)" renders exactly as before.
  test("timeline cap: timelineTotal > rows served → 'showing newest N of M' caption", async ({ page }) => {
    const w = defaultWorld();
    const detail = w.incidentDetails[1] as { timeline?: unknown[] } & Record<string, unknown>;
    const served = (detail.timeline ?? []).length;
    detail.timelineTotal = served + 2306; // a long incident, capped server-side
    await mockApi(page, w);
    await page.goto("/incidents/1");

    await expect(page.getByTestId("timeline-count")).toHaveText(`showing newest ${served} of ${served + 2306}`);
  });

  test("timeline cap: absent timelineTotal (pre-cap API) → the plain count, no caption", async ({ page }) => {
    await mockApi(page);
    await page.goto("/incidents/1");
    await expect(page.getByTestId("timeline-count")).toHaveText(/^\(\d+\)$/);
  });

  // ★ A NEW incident (always page 0) must appear on the steady poll WITHOUT a manual reload — page 0 stale =
  // a missed alert. Pre-fix (revalidateFirstPage:false) page 0 was skipped on every tick → invisible until
  // reload. ★★ DEFAULT TEETH: useIncidentHistory no longer passes revalidateFirstPage explicitly — it relies
  // on the useCursorHistory SAFE DEFAULT (true). So this test now ALSO guards that default: flip the default
  // back to false and this fails. (The run-history live tests in detail.spec.ts guard it the same way.)
  test("live: a new incident appears in the open list without a manual reload", async ({ page }) => {
    const w = defaultWorld();
    await mockApi(page, w);
    await page.goto("/incidents");
    await expect(page.getByTestId("incidents-open")).toBeVisible();
    await expect(page.getByText("FRESH OUTAGE on payments")).toHaveCount(0); // not yet

    // a new incident opens (mutate the shared world — the mock reads world.incidents fresh on each poll)
    w.incidents.unshift(
      incident({
        id: 99001,
        checkId: 1,
        status: "open",
        severity: "critical",
        checkName: "Payments API",
        summary: "FRESH OUTAGE on payments",
        openedAt: new Date(Date.now() + 1000).toISOString(), // newest → page 0
      }),
    );

    // ★ the steady poll refetches page 0 (via the safe-default revalidateFirstPage) → it shows up, NO reload.
    // (timeout > the 15s idle cadence; fails if the default is false because page 0 is never refetched.)
    await expect(page.getByText("FRESH OUTAGE on payments")).toBeVisible({ timeout: 20000 });
  });
});

// ★ Resolution reason (runner 0095 closeStrandedIncidents / api #286 → resolutionReason). A resolved incident
// with resolution_reason set was NOT recovered — the monitor stopped running, so it was closed administratively
// (no green recovery run, resolved_run_id NULL). The detail must SAY SO and the red final run must be explained,
// never faked green. A null-reason (genuine recovery) incident must render exactly as before.
test.describe("incident — resolution reason (run-less resolve)", () => {
  const failRun = (runId: number) => ({
    runId, status: "fail", startedAt: "2026-06-22T17:50:00Z", durationMs: 120,
    httpStatus: 500, errorMessage: "500 from origin", failedStep: null,
    screenshotUrl: null, traceUrl: null, location: "eastus2",
  });

  // ITEM 7 — an incident with resolutionReason set renders the explanation (and the timeline explains the red
  // terminal). The prove-can-fail (drop the field from the mapper → this reds) is demonstrated in the PR.
  test("★ a run-less resolve (monitor archived) explains itself; the red timeline is expected, not a recovery", async ({ page }) => {
    const w = defaultWorld();
    // resolved + monitor_archived + an ALL-FAIL timeline (no recovery run) — a real administrative close.
    w.incidentDetails[50] = incidentDetail({
      id: 50, checkName: "Archived monitor", resolutionReason: "monitor_archived",
      timeline: [failRun(5001), failRun(5000)], rca: null,
    });
    await mockApi(page, w);
    await page.goto("/incidents/50");

    const note = page.getByTestId("resolution-reason-note");
    await expect(note).toBeVisible();
    await expect(note).toContainText("Closed without recovery");
    await expect(note).toContainText("archived"); // names WHICH cause
    await expect(note).toContainText("not a recovery"); // explicitly NOT a recovery
    await expect(note).toContainText("never confirmed fixed"); // the failure was not fixed
    await expect(note).not.toContainText("recovered");

    // the timeline explains the (correct) red final run — not faked green, not suppressed.
    const tnote = page.getByTestId("timeline-no-recovery-note");
    await expect(tnote).toBeVisible();
    await expect(tnote).toContainText("No recovery run");
    await expect(page.getByText("500 from origin").first()).toBeVisible(); // the red run is still shown, not hidden
  });

  // ITEM 9 — cover MORE THAN ONE reason value. paused + removed here, archived above → all three exercised.
  for (const { reason, word } of [
    { reason: "monitor_paused", word: "paused" },
    { reason: "monitor_removed", word: "removed" },
  ] as const) {
    test(`★ a run-less resolve (${reason}) names its cause in the explanation`, async ({ page }) => {
      const w = defaultWorld();
      w.incidentDetails[51] = incidentDetail({
        id: 51, checkName: "Stopped monitor", resolutionReason: reason,
        timeline: [failRun(5101)], rca: null,
      });
      await mockApi(page, w);
      await page.goto("/incidents/51");
      const note = page.getByTestId("resolution-reason-note");
      await expect(note).toBeVisible();
      await expect(note).toContainText(word);
      await expect(note).toContainText("not a recovery");
    });
  }

  // ITEM 8 — NEGATIVE: a genuinely-recovered incident (resolutionReason absent → null) renders EXACTLY as today:
  // no close-reason banner, no timeline note, and its green recovery run still shows.
  test("★ a genuinely-recovered incident (null reason) shows no close-reason UI (unchanged)", async ({ page }) => {
    await mockApi(page); // default world: incident 1 is a fail→PASS recovery, resolutionReason absent → null
    await page.goto("/incidents/1");
    await expect(page.getByRole("heading", { name: "Incident #1" })).toBeVisible();
    await expect(page.getByTestId("resolution-reason-note")).toHaveCount(0);
    await expect(page.getByTestId("timeline-no-recovery-note")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Run timeline" })).toBeVisible();
    await expect(page.getByText("503 Service Unavailable from westus2")).toBeVisible(); // unchanged
  });

  // ITEM 5 — the LIST marks a run-less resolve with a neutral chip; a genuine recovery gets none.
  test("★ the incidents LIST chips a run-less resolve, not a genuine recovery", async ({ page }) => {
    const w = defaultWorld();
    const at = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    w.incidents = [
      incident({ id: 70, status: "resolved", severity: "warning", openedAt: at(1), resolvedAt: at(0.5), checkName: "Paused monitor", summary: "was failing", resolutionReason: "monitor_paused", rca: null }),
      incident({ id: 71, status: "resolved", severity: "warning", openedAt: at(1), resolvedAt: at(0.5), checkName: "Recovered monitor", summary: "blip", rca: null }),
    ];
    await mockApi(page, w);
    await page.goto("/incidents");
    const chip = page.getByTestId("resolution-reason-chip");
    await expect(chip).toHaveCount(1); // only the run-less close, never the genuine recovery
    await expect(chip).toContainText("Monitor paused");
  });
});
