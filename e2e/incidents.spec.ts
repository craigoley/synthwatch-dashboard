import { test, expect } from "@playwright/test";

import { mockApi } from "./mock";

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
});
