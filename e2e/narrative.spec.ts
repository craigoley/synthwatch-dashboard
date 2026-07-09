import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

// Reporting Layer 3: the AI narrative card. Fleet card atop /reports; compact
// per-monitor card on a row's drill-down. Cited factPack numbers shown for
// auditability. Hides entirely when the endpoint serves no narrative.
function worldWithNarrative() {
  const w = defaultWorld();
  w.narratives = {
    fleet: {
      scope: "fleet",
      window: "7d",
      headline: "Fleet mostly healthy, one latency regression",
      body: "Availability held at **99.2%** this window.\n\n- API p95 rose to `420ms`\n- One incident on checkout",
      highlights: ["p95 +15%", "1 incident"],
      // ★ The runner writes fact_pack as an OBJECT (current/deltas), NOT a chip array — the API passes it
      // through verbatim and the client derives chips from it. Fixture mirrors the real shape.
      factPack: {
        current: { availabilityPct: 99.2, p95: 420, incidents: 1, downtimeMin: 45 },
        deltas: { availabilityPts: -0.3, p95Pct: 15, incidents: 1, downtimeMin: 30 },
        scopeType: "fleet",
        window: "7d",
      },
      generatedAt: "2026-06-20T09:00:00Z",
      stale: false,
    },
    monitor: {
      "1": {
        scope: "monitor",
        window: "7d",
        headline: "API health steady",
        body: "No regressions; p95 stable.",
        highlights: [],
        factPack: { current: { availabilityPct: 100, p95: 180, incidents: 0, downtimeMin: 0 }, deltas: {} },
        generatedAt: "2026-06-20T09:00:00Z",
        stale: true,
      },
    },
  };
  return w;
}

test.describe("reporting layer 3 — narrative card", () => {
  test("fleet card renders headline + markdown body atop the reports page", async ({ page }) => {
    await mockApi(page, worldWithNarrative());
    await page.goto("/reports");

    const fleet = page.locator('[data-testid="narrative-card"][data-scope="fleet"]');
    await expect(fleet).toBeVisible();
    await expect(fleet).toContainText("Fleet mostly healthy, one latency regression");
    // markdown rendered: bold figure + bullet list + inline code text all present
    await expect(fleet.getByTestId("narrative-body")).toContainText("99.2%");
    await expect(fleet.getByTestId("narrative-body")).toContainText("API p95 rose to");
    await expect(fleet.getByTestId("narrative-body")).toContainText("420ms");
  });

  test("★ shows the cited factPack numbers beside the prose (auditability)", async ({ page }) => {
    await mockApi(page, worldWithNarrative());
    await page.goto("/reports");

    // Derived from the fact_pack object: Availability, p95, Incidents, Downtime.
    const facts = page.locator('[data-scope="fleet"] [data-testid="narrative-fact"]');
    await expect(facts).toHaveCount(4);
    const p95 = facts.filter({ hasText: "p95" });
    await expect(p95).toContainText("420ms"); // the actual number, verifiable against the prose
    await expect(p95).toContainText("+15%"); // the cited delta
    await expect(facts.filter({ hasText: "Availability" })).toContainText("99.2%");
  });

  test("graceful: no narrative served → card hidden (no error, no empty box)", async ({ page }) => {
    await mockApi(page, defaultWorld()); // no narratives → /reports/narrative 404s
    await page.goto("/reports"); // Summary is the default tab

    await expect(page.getByTestId("reports-panel-summary")).toHaveCount(1); // the tab/panel mounted (empty is fine)
    await expect(page.getByTestId("reports-tab-summary")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("narrative-card")).toHaveCount(0); // card hidden — no error, no empty box
  });

  test("Summary tab under a tag filter → fleet-only note, not a fleet story read as the subset", async ({ page }) => {
    const w = worldWithNarrative();
    w.tags = [{ key: "env", value: "prod", count: 1 }]; // in-use tag → the global TagFilter renders
    await mockApi(page, w);
    await page.goto("/reports?tags=env:prod"); // Summary is default; a tag filter is active

    await expect(page.getByTestId("reports-panel-summary")).toBeVisible();
    // The fleet narrative is NOT shown scoped to a tag subset — a note explains instead.
    await expect(page.getByTestId("narrative-card")).toHaveCount(0);
    await expect(page.getByTestId("summary-fleet-only-note")).toBeVisible();

    // Clearing the filter reveals the fleet narrative.
    await page.getByTestId("clear-tag-filter").click();
    await expect(page.locator('[data-testid="narrative-card"][data-scope="fleet"]')).toBeVisible();
    await expect(page.getByTestId("summary-fleet-only-note")).toHaveCount(0);
  });

  test("compact per-monitor narrative shows directly on the monitor's report card", async ({ page }) => {
    await mockApi(page, worldWithNarrative());
    await page.goto("/reports?tab=monitors"); // the per-monitor card lives in the Monitors tab

    // Redesign: the per-monitor narrative is surfaced ON the card (not hidden behind the drill-down).
    const monitorCard = page.getByTestId("report-1").locator('[data-testid="narrative-card"][data-scope="monitor"]');
    await expect(monitorCard).toBeVisible();
    await expect(monitorCard).toContainText("API health steady");
    await expect(monitorCard).toContainText("180ms"); // its cited number
    await expect(monitorCard).toContainText("stale"); // freshness hint
  });
});
