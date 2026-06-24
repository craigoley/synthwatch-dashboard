import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

// Phase 9b — tag filtering on the Monitors + Incidents lists. Semantics: AND across
// selected tags (a row must carry every selected tag). Filter is URL-persisted.
test.describe("tag filtering — monitors", () => {
  function world() {
    const w = defaultWorld();
    // check 1 → env:prod ; check 2 → team:web ; rest untagged
    w.checks = w.checks.map((c) => {
      if (c.id === 1) return { ...c, tags: [{ key: "env", value: "prod" }] };
      if (c.id === 2) return { ...c, tags: [{ key: "team", value: "web" }] };
      return { ...c, tags: [] };
    });
    w.tags = [
      { key: "env", value: "prod", count: 1 },
      { key: "team", value: "web", count: 1 },
    ];
    return w;
  }

  test("filtering by a tag shows only matching monitors", async ({ page }) => {
    await mockApi(page, world());
    await page.goto("/monitors");
    await expect(page.getByTestId("tag-filter")).toBeVisible();

    // before: both check 1 and check 2 rows present
    await expect(page.locator('a[href="/checks/1"]')).toBeVisible();
    await expect(page.locator('a[href="/checks/2"]')).toBeVisible();

    await page.getByRole("checkbox", { name: "filter env:prod" }).click();

    await expect(page.locator('a[href="/checks/1"]')).toBeVisible(); // env:prod → stays
    await expect(page.locator('a[href="/checks/2"]')).toHaveCount(0); // team:web → filtered out
    await expect(page.getByTestId("filter-result")).toContainText(/1 of \d+ monitors match/);
  });

  test("AND semantics — two tags show only rows carrying BOTH", async ({ page }) => {
    const w = world();
    // check 1 carries BOTH env:prod and team:web; check 2 only team:web
    w.checks = w.checks.map((c) =>
      c.id === 1 ? { ...c, tags: [{ key: "env", value: "prod" }, { key: "team", value: "web" }] } : c,
    );
    w.tags = [
      { key: "env", value: "prod", count: 1 },
      { key: "team", value: "web", count: 2 },
    ];
    await mockApi(page, w);
    await page.goto("/monitors");
    await page.getByRole("checkbox", { name: "filter env:prod" }).click();
    await page.getByRole("checkbox", { name: "filter team:web" }).click();

    await expect(page.locator('a[href="/checks/1"]')).toBeVisible(); // has both
    await expect(page.locator('a[href="/checks/2"]')).toHaveCount(0); // only team:web → excluded
  });

  test("clear restores the full list", async ({ page }) => {
    await mockApi(page, world());
    await page.goto("/monitors");
    await page.getByRole("checkbox", { name: "filter env:prod" }).click();
    await expect(page.locator('a[href="/checks/2"]')).toHaveCount(0);

    await page.getByTestId("clear-tag-filter").click();
    await expect(page.locator('a[href="/checks/2"]')).toBeVisible(); // back
  });

  test("the filter is URL-persisted (shareable)", async ({ page }) => {
    await mockApi(page, world());
    // deep-link straight to a filtered view
    await page.goto("/monitors?tags=env:prod");
    await expect(page.getByRole("checkbox", { name: "filter env:prod" })).toHaveAttribute("aria-checked", "true");
    await expect(page.locator('a[href="/checks/2"]')).toHaveCount(0);
    // toggling updates the URL
    await page.getByTestId("clear-tag-filter").click();
    await expect(page).toHaveURL(/\/monitors$/);
  });
});

test.describe("tag filtering — incidents", () => {
  test("filters incidents by their check's tags (no per-incident fetch)", async ({ page }) => {
    const w = defaultWorld();
    // two open incidents on different checks; tag those checks distinctly
    w.checks = w.checks.map((c) => {
      if (c.id === 1) return { ...c, tags: [{ key: "env", value: "prod" }] };
      if (c.id === 2) return { ...c, tags: [{ key: "team", value: "web" }] };
      return { ...c, tags: [] };
    });
    w.incidents = [
      { id: 91, checkId: 1, status: "open", severity: "critical", openedAt: "2026-06-23T10:00:00Z", resolvedAt: null, consecutiveFailures: 3, summary: "prod down", checkName: "API health", checkKind: "http", rca: null },
      { id: 92, checkId: 2, status: "open", severity: "warning", openedAt: "2026-06-23T10:00:00Z", resolvedAt: null, consecutiveFailures: 2, summary: "web flaky", checkName: "Homepage flow", checkKind: "browser", rca: null },
    ];
    w.tags = [
      { key: "env", value: "prod", count: 1 },
      { key: "team", value: "web", count: 1 },
    ];
    await mockApi(page, w);
    await page.goto("/incidents");
    await expect(page.getByTestId("tag-filter")).toBeVisible();
    await expect(page.locator('a[href="/incidents/91"]')).toBeVisible();
    await expect(page.locator('a[href="/incidents/92"]')).toBeVisible();

    await page.getByRole("checkbox", { name: "filter env:prod" }).click();
    await expect(page.locator('a[href="/incidents/91"]')).toBeVisible(); // check 1 = env:prod
    await expect(page.locator('a[href="/incidents/92"]')).toHaveCount(0); // check 2 = team:web → out
    await expect(page.getByTestId("filter-result")).toContainText(/1 of 2 incidents match/);
  });
});

test.describe("notifications routing matrix alignment", () => {
  test("each channel header sits centered over its checkbox column", async ({ page }) => {
    const w = defaultWorld();
    w.channels = [
      { id: 1, name: "default email list", type: "email", config: { to: ["a@b.com"] }, enabled: true },
    ];
    await mockApi(page, w);
    await page.goto("/notifications");
    await expect(page.getByTestId("routing-matrix")).toBeVisible();

    // structural assertion: the channel header <th> and the checkbox <td> below it
    // share a centered horizontal midpoint (header no longer left-drifts off its column).
    const aligned = await page.evaluate(() => {
      const table = document.querySelector('[data-testid="routing-matrix"]');
      if (!table) return null;
      const th = table.querySelectorAll("thead th")[1]; // first channel column header
      const cell = table.querySelector('[aria-label="route critical to default email list"]');
      if (!th || !cell) return null;
      const thRect = th.getBoundingClientRect();
      const cellRect = cell.getBoundingClientRect();
      const thMid = thRect.left + thRect.width / 2;
      const cellMid = cellRect.left + cellRect.width / 2;
      return Math.abs(thMid - cellMid); // px offset between header center and checkbox center
    });
    expect(aligned).not.toBeNull();
    expect(aligned as number).toBeLessThanOrEqual(2); // centers line up (≤2px)
  });
});
