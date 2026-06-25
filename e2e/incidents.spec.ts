import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

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

    // ★ timeline centerpiece: rows + screenshot/trace links out
    await expect(page.getByRole("heading", { name: "Run timeline" })).toBeVisible();
    await expect(page.getByText("503 Service Unavailable from westus2")).toBeVisible();
    const shot = page.getByRole("link", { name: /screenshot/ });
    await expect(shot).toHaveAttribute("href", /\/api\/runs\/1001\/screenshot$/);
    await expect(page.getByRole("link", { name: /trace/ })).toHaveAttribute("href", /\/api\/runs\/1001\/trace$/);

    // recurrence links to a sibling incident
    await expect(page.getByRole("heading", { name: "Recurrence" })).toBeVisible();
    await expect(page.getByRole("link", { name: /earlier westus2 blip/ })).toHaveAttribute("href", "/incidents/3");
  });

  test("an rca-null incident detail renders with no RCA panel", async ({ page }) => {
    await mockApi(page);
    await page.goto("/incidents/2");

    await expect(page.getByRole("heading", { name: "Incident #2" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Run timeline" })).toBeVisible(); // timeline still renders
    await expect(page.getByText("Root cause")).toHaveCount(0); // no RCA panel
  });
});
