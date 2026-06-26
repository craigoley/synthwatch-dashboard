import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

// Trace AI insights — the UI consuming POST /api/runs/{id}/ai-insights (check 2 / run 200 has a trace).
// The endpoint is gated (editor/admin) and returns a FLAT AiInsightsDto body. These pin: the POST carries
// the auth token (bug A), and the error mapping (bug B) — only configured:false shows "not configured";
// 401→re-login, 403→toast, configured-but-empty→retry.

// ★ The REAL API shape: categories at the TOP level (NOT wrapped in `insights`), note (NOT message).
const FLAT_INSIGHTS = {
  configured: true,
  summary: "Slow SPA boot, image-heavy page, and one site-origin console error.",
  performance: [
    { severity: "medium", confidence: "high", title: "Slow JS chunk TTFB", detail: "Several _next chunks wait ~700ms.", evidence: "05qfr1.js 1026ms (wait 613ms)" },
  ],
  network: [
    { severity: "medium", confidence: "medium", title: "images.wegmans.com dominates page weight", detail: "70 requests / 6.6 MB.", evidence: "hero image 2.2 MB" },
  ],
  errors: [
    { severity: "high", confidence: "high", title: "Invalid discovery pages storage data", detail: "Console error on load.", evidence: "console error from _next chunk" },
  ],
  suggestions: [
    { severity: "low", confidence: "low", title: "Unused CSS preloads", detail: "Two chunks preloaded but unused.", evidence: null },
  ],
  caveats: ["SPA Web Vitals are best-effort, not authoritative.", "Not a Lighthouse audit."],
  note: null,
};

test.describe("trace AI insights — auth + error mapping", () => {
  test("signed-in: the POST carries the auth token and renders the FLAT insights", async ({ page }) => {
    const w = defaultWorld();
    w.aiInsights = FLAT_INSIGHTS;
    await mockApi(page, w); // default = a seeded editor session
    await page.goto("/checks/2");

    const reqP = page.waitForRequest((r) => /\/api\/runs\/200\/ai-insights$/.test(r.url()) && r.method() === "POST");
    await page.getByTestId("get-ai-insights-200").click();
    const req = await reqP;
    // ★ Bug A: the call goes through request() → the bearer token IS attached (same as every authed write).
    expect(req.headers()["authorization"] ?? "").toMatch(/^Bearer /);

    const result = page.getByTestId("ai-insights-result");
    await expect(result).toContainText("Slow SPA boot"); // summary (top-level, flat)
    await expect(page.getByTestId("ai-category-errors")).toContainText("Invalid discovery pages storage data");
    await expect(page.getByTestId("ai-category-performance")).toContainText("Evidence: 05qfr1.js 1026ms");
    await expect(page.getByTestId("ai-not-configured")).toHaveCount(0);
  });

  test("★ a 401 triggers re-login — NOT the 'not configured' message (the reported bug)", async ({ page }) => {
    const w = defaultWorld();
    w.aiInsightsStatus = 401; // the gate rejects the token
    await mockApi(page, w);
    await page.goto("/checks/2");

    await page.getByTestId("get-ai-insights-200").click();
    await expect(page.getByTestId("login-modal")).toBeVisible(); // global interceptor → re-login
    await expect(page.getByTestId("ai-not-configured")).toHaveCount(0); // ★ must NOT lie "not configured"
  });

  test("a 403 shows the permission toast — NOT the 'not configured' message", async ({ page }) => {
    const w = defaultWorld();
    w.aiInsightsStatus = 403;
    await mockApi(page, w);
    await page.goto("/checks/2");

    await page.getByTestId("get-ai-insights-200").click();
    await expect(page.getByTestId("forbidden-toast")).toBeVisible();
    await expect(page.getByTestId("ai-not-configured")).toHaveCount(0);
  });

  test("configured:false is the ONLY trigger for the 'not configured' message", async ({ page }) => {
    const w = defaultWorld();
    w.aiInsights = { configured: false, note: "AI insights are not configured for this environment yet." };
    await mockApi(page, w);
    await page.goto("/checks/2");

    await page.getByTestId("get-ai-insights-200").click();
    await expect(page.getByTestId("ai-not-configured")).toBeVisible();
    await expect(page.getByTestId("ai-not-configured")).toContainText("not configured");
  });

  test("configured but no insights (AOAI unavailable) → soft try-again, not a crash", async ({ page }) => {
    const w = defaultWorld();
    w.aiInsights = {
      configured: true,
      summary: null,
      performance: [], network: [], errors: [], suggestions: [], caveats: [],
      note: "The AI model was unavailable — please try again.",
    };
    await mockApi(page, w);
    await page.goto("/checks/2");

    await page.getByTestId("get-ai-insights-200").click();
    await expect(page.getByTestId("ai-unavailable")).toBeVisible();
    await expect(page.getByTestId("ai-retry-200")).toBeVisible();
    await expect(page.getByTestId("ai-not-configured")).toHaveCount(0);
  });

  test("gated: a signed-out viewer sees a sign-in nudge, not the analyze action", async ({ page }) => {
    await mockApi(page, defaultWorld(), { seedSession: false });
    await page.goto("/checks/2");
    await expect(page.getByTestId("ai-insights-signin-200")).toBeVisible();
    await expect(page.getByTestId("get-ai-insights-200")).toHaveCount(0);
  });
});
