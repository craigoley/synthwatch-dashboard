import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";
import { incident } from "./fixtures";

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

    // ★ timeline centerpiece: rows + screenshot/trace links out — SAME-ORIGIN proxy paths, never the raw
    // cross-origin API (bearer-gated per synthwatch-api #154 → a bare href would 401 even signed-in).
    await expect(page.getByRole("heading", { name: "Run timeline" })).toBeVisible();
    await expect(page.getByText("503 Service Unavailable from westus2")).toBeVisible();
    const shot = page.getByRole("link", { name: /screenshot/ });
    await expect(shot).toHaveAttribute("href", "/screenshot-proxy/1001");
    await expect(page.getByRole("link", { name: /trace/ })).toHaveAttribute("href", "/trace-proxy/1001");
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
