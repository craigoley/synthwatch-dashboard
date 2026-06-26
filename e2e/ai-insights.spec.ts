import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

// Trace AI insights (slice 3 — the UI). The button lives on the run-detail trace view (check 2 / run 200
// has a trace). The endpoint is gated (editor/admin) + inert-until-configured, so every non-happy state
// must degrade gracefully — never a broken card.

const FULL_INSIGHTS = {
  configured: true,
  insights: {
    summary: "Slow SPA boot, image-heavy page, and one site-origin console error.",
    performance: [
      {
        severity: "medium",
        confidence: "high",
        title: "Slow JS chunk TTFB",
        detail: "Several _next chunks wait ~700ms before any bytes.",
        evidence: "05qfr1.js 1026ms (wait 613ms)",
        scope: "site",
      },
    ],
    network: [
      {
        severity: "medium",
        confidence: "medium",
        title: "images.wegmans.com dominates page weight",
        detail: "70 requests / 6.6 MB.",
        evidence: "hero image 2.2 MB",
        scope: "site",
      },
    ],
    errors: [
      {
        severity: "high",
        confidence: "high",
        title: "Invalid discovery pages storage data",
        detail: "Console error on load in the search header.",
        evidence: "console error from _next chunk",
        scope: "site",
      },
    ],
    suggestions: [
      { severity: "low", confidence: "low", title: "Unused CSS preloads", detail: "Two chunks preloaded but unused.", evidence: null, scope: null },
    ],
    caveats: ["SPA Web Vitals are best-effort, not authoritative.", "Not a Lighthouse audit."],
  },
};

test.describe("trace AI insights (slice 3)", () => {
  test("happy: Get AI insights → categorized cards + summary + caveats + status-color severity", async ({ page }) => {
    const w = defaultWorld();
    w.aiInsights = FULL_INSIGHTS;
    await mockApi(page, w);
    await page.goto("/checks/2");

    await page.getByTestId("get-ai-insights-200").click();

    const result = page.getByTestId("ai-insights-result");
    await expect(result).toBeVisible();
    await expect(result).toContainText("Slow SPA boot"); // the summary
    // categories render with evidence + the high-severity error
    await expect(page.getByTestId("ai-category-performance")).toContainText("Evidence: 05qfr1.js 1026ms");
    await expect(page.getByTestId("ai-category-errors")).toContainText("Invalid discovery pages storage data");
    await expect(page.getByTestId("ai-caveats")).toContainText("best-effort"); // honesty surfaced
    // ★ severity reuses the status-color law: the HIGH error is colored with --color-fail (red), not invented
    await expect(page.getByTestId("ai-category-errors").locator('[style*="--color-fail"]').first()).toBeVisible();
  });

  test("★ not-configured (the live state) → a clean message, NOT an error or broken card", async ({ page }) => {
    await mockApi(page); // default world → aiInsights unset → endpoint returns configured:false
    await page.goto("/checks/2");

    await page.getByTestId("get-ai-insights-200").click();
    await expect(page.getByTestId("ai-not-configured")).toBeVisible();
    await expect(page.getByTestId("ai-not-configured")).toContainText("configured yet");
    await expect(page.getByTestId("ai-insights-result")).toHaveCount(0); // no insights card
  });

  test("AOAI returned null (non-fatal) → graceful 'try again', not a crash", async ({ page }) => {
    const w = defaultWorld();
    w.aiInsights = { configured: true, insights: null };
    await mockApi(page, w);
    await page.goto("/checks/2");

    await page.getByTestId("get-ai-insights-200").click();
    await expect(page.getByTestId("ai-unavailable")).toBeVisible();
    await expect(page.getByTestId("ai-retry-200")).toBeVisible();
  });

  test("gated: a signed-out viewer sees a sign-in nudge, not the analyze action", async ({ page }) => {
    await mockApi(page, defaultWorld(), { seedSession: false });
    await page.goto("/checks/2");

    await expect(page.getByTestId("ai-insights-signin-200")).toBeVisible();
    await expect(page.getByTestId("get-ai-insights-200")).toHaveCount(0); // no token-spend affordance
  });
});
