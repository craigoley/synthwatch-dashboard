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
      window: "30d",
      headline: "Fleet mostly healthy, one latency regression",
      body: "Availability held at **99.2%** this window.\n\n- API p95 rose to `420ms`\n- One incident on checkout",
      highlights: ["p95 +15%", "1 incident"],
      factPack: [
        { label: "p95", value: "420ms", delta: "+15%" },
        { label: "availability", value: "99.2%", delta: "-0.3pp" },
      ],
      generatedAt: "2026-06-20T09:00:00Z",
      stale: false,
    },
    monitor: {
      "1": {
        scope: "monitor",
        window: "30d",
        headline: "API health steady",
        body: "No regressions; p95 stable.",
        highlights: [],
        factPack: [{ label: "p95", value: "180ms", delta: "0%" }],
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

    const facts = page.locator('[data-scope="fleet"] [data-testid="narrative-fact"]');
    await expect(facts).toHaveCount(2);
    const p95 = facts.filter({ hasText: "p95" });
    await expect(p95).toContainText("420ms"); // the actual number, verifiable against the prose
    await expect(p95).toContainText("+15%"); // the cited delta
  });

  test("graceful: no narrative served → card hidden (no error, no empty box)", async ({ page }) => {
    await mockApi(page, defaultWorld()); // no narratives → /reports/narrative 404s
    await page.goto("/reports");

    await expect(page.getByTestId("monitor-list")).toBeVisible(); // page itself fine
    await expect(page.getByTestId("narrative-card")).toHaveCount(0); // card hidden
  });

  test("compact per-monitor narrative on a row's drill-down", async ({ page }) => {
    await mockApi(page, worldWithNarrative());
    await page.goto("/reports");

    await page.getByTestId("row-1").getByRole("button").first().click();
    const monitorCard = page.locator('[data-testid="narrative-card"][data-scope="monitor"]');
    await expect(monitorCard).toBeVisible();
    await expect(monitorCard).toContainText("API health steady");
    await expect(monitorCard).toContainText("180ms"); // its cited number
    await expect(monitorCard).toContainText("stale"); // freshness hint
  });
});
