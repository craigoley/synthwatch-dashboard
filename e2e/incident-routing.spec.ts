import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";
import { incident } from "./fixtures";

const recent = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();

// ★ 2am routing: the status grid is a dead end after a resolved incident, and the check page never pointed at
// the incident that carries the root cause. Both now route there (link only — no verdict).
test.describe("incident routing — grid banner + check-page link", () => {
  test("★ status grid banner surfaces open + recently-resolved incidents and links to /incidents", async ({ page }) => {
    const w = defaultWorld();
    w.incidents = [
      incident({ id: 900, checkId: 2, status: "open", severity: "critical", openedAt: recent(10), resolvedAt: null, summary: "down" }),
      incident({ id: 901, checkId: 3, status: "resolved", severity: "warning", openedAt: recent(120), resolvedAt: recent(8), summary: "blip" }),
    ];
    await mockApi(page, w);
    await page.goto("/");
    const banner = page.getByTestId("status-incident-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("1 open incident");
    await expect(banner).toContainText(/1 resolved in the last 24h/i);
    await expect(banner).toHaveAttribute("href", "/incidents");
  });

  test("status banner HIDES when there are no open and no recently-resolved incidents", async ({ page }) => {
    const w = defaultWorld();
    // only an OLD resolved incident (2 days ago) → not "recent", not open → no banner
    w.incidents = [incident({ id: 902, checkId: 2, status: "resolved", openedAt: recent(3000), resolvedAt: recent(2880), summary: "old" })];
    await mockApi(page, w);
    await page.goto("/");
    await expect(page.getByTestId("status-incident-banner")).toHaveCount(0);
  });

  test("★ check-detail page links to the check's OPEN incident (root-cause routing, no verdict shown)", async ({ page }) => {
    const w = defaultWorld();
    w.incidents = [incident({ id: 910, checkId: 1, status: "open", severity: "critical", openedAt: recent(15), resolvedAt: null, summary: "down" })];
    await mockApi(page, w);
    await page.goto("/checks/1");
    const link = page.getByTestId("monitor-incident-link");
    await expect(link).toBeVisible();
    await expect(link).toContainText("Open incident #910");
    await expect(link).toContainText("view root cause");
    await expect(link).toHaveAttribute("href", "/incidents/910");
    // ★ link only — the RCA VERDICT (real-outage / monitor-side) is NOT surfaced on the check page
    await expect(link).not.toContainText(/real outage|monitor-side|service-side|flaky selector/i);
  });

  test("check-detail incident link hides when the check has no open / recent incident", async ({ page }) => {
    const w = defaultWorld();
    w.incidents = []; // none for check 1
    await mockApi(page, w);
    await page.goto("/checks/1");
    await expect(page.getByTestId("monitor-incident-link")).toHaveCount(0);
  });
});
