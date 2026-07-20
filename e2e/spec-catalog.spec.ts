import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

// Spec catalog (Phase 13) — now merged INTO /monitors. The un-activated specs (the set-difference) render in
// the "New monitors" section; the full catalog (every spec, both dimensions) is the inline "Browse the full
// spec catalog" reveal. Two orthogonal dimensions per row: Coverage (Unmonitored/Active/Paused) and Runnable?
// (✓ / ⚠ orphan) — independent (a spec can be Active+Orphan or Unmonitored+Orphan).

function worldWithCatalog() {
  const w = defaultWorld();
  w.specCatalog = {
    probedAt: "2026-06-25T12:00:00Z",
    items: [
      {
        sourceKey: "active-spec", name: "Active Mon", specPath: "monitors/a/active.spec.ts", kind: "browser",
        target: "https://a.example", suggestedIntervalSeconds: 1800, tags: ["a", "journey"], runnable: true,
        notRunnableReason: null, monitored: true, checkId: 1, checkName: "Active Mon", enabled: true,
        health: { currentStatus: "pass", p95Ms: 4200, openIncidentCount: 0, lastRunAt: "2026-06-25T11:59:00Z" },
      },
      {
        sourceKey: "paused-spec", name: "Paused Mon", specPath: "monitors/p/paused.spec.ts", kind: "browser",
        target: "https://p.example", suggestedIntervalSeconds: 600, tags: [], runnable: true,
        notRunnableReason: null, monitored: true, checkId: 2, checkName: "Paused Mon", enabled: false,
        health: { currentStatus: "pass", p95Ms: 900, openIncidentCount: 0, lastRunAt: "2026-06-24T10:00:00Z" },
      },
      {
        sourceKey: "unmon-spec", name: "Unmonitored Mon", specPath: "monitors/u/unmon.spec.ts", kind: "browser",
        target: "https://u.example", suggestedIntervalSeconds: 1800, tags: [], runnable: true,
        notRunnableReason: null, monitored: false, checkId: null, checkName: null, enabled: null, health: null,
      },
      {
        sourceKey: "orphan-spec", name: "Orphan Mon", specPath: "monitors/o/orphan.spec.ts", kind: "browser",
        target: null, suggestedIntervalSeconds: null, tags: [], runnable: false,
        notRunnableReason: "not fetchable: 404", monitored: false, checkId: null, checkName: null, enabled: null, health: null,
      },
      {
        // ★ orthogonal dimensions: an ACTIVE spec whose spec broke (Active + Orphan).
        sourceKey: "active-orphan-spec", name: "Active Orphan Mon", specPath: "monitors/ao/active-orphan.spec.ts",
        kind: "browser", target: "https://ao.example", suggestedIntervalSeconds: 1800, tags: [], runnable: false,
        notRunnableReason: "won't compile: SyntaxError", monitored: true, checkId: 3, checkName: "Active Orphan Mon",
        enabled: true, health: { currentStatus: "infra_error", p95Ms: null, openIncidentCount: 0, lastRunAt: "2026-06-25T11:00:00Z" },
      },
    ],
  };
  return w;
}

test.describe("phase 13 — spec catalog (in the merged /monitors)", () => {
  test("the full-catalog reveal renders BOTH dimensions independently: coverage and runnable", async ({ page }) => {
    await mockApi(page, worldWithCatalog());
    await page.goto("/monitors");
    await page.getByTestId("browse-catalog").click();

    const cat = page.getByTestId("full-catalog-table");
    await expect(cat.getByTestId("spec-row-active-spec")).toHaveAttribute("data-coverage", "active");
    await expect(cat.getByTestId("spec-row-paused-spec")).toHaveAttribute("data-coverage", "paused");
    await expect(cat.getByTestId("spec-row-unmon-spec")).toHaveAttribute("data-coverage", "unmonitored");
    await expect(cat.getByTestId("spec-row-unmon-spec")).toHaveAttribute("data-runnable", "true");
    await expect(cat.getByTestId("spec-row-orphan-spec")).toHaveAttribute("data-runnable", "false");
    // ★ orthogonality: Active + Orphan in the same row.
    const activeOrphan = cat.getByTestId("spec-row-active-orphan-spec");
    await expect(activeOrphan).toHaveAttribute("data-coverage", "active");
    await expect(activeOrphan).toHaveAttribute("data-runnable", "false");
  });

  test("Unmonitored + Orphan reads as a neutral known-gap with its reason (in New monitors)", async ({ page }) => {
    await mockApi(page, worldWithCatalog());
    await page.goto("/monitors");

    const orphan = page.getByTestId("new-monitors-table").getByTestId("spec-row-orphan-spec");
    await expect(orphan).toHaveAttribute("data-coverage", "unmonitored");
    await expect(orphan.getByTestId("spec-runnable")).toContainText("Orphan");
    await expect(orphan.getByTestId("spec-runnable")).toContainText("not fetchable: 404");
    await expect(orphan).toContainText("monitors/o/orphan.spec.ts");
  });

  test("Active row: health (status dot + p95) and a link to the live monitor (full-catalog)", async ({ page }) => {
    await mockApi(page, worldWithCatalog());
    await page.goto("/monitors");
    await page.getByTestId("browse-catalog").click();

    const active = page.getByTestId("full-catalog-table").getByTestId("spec-row-active-spec");
    await expect(active).toContainText("4.20s");
    await expect(active.locator(".sw-dot-pass")).toBeVisible();
    await expect(active.getByRole("link", { name: "Active Mon" })).toHaveAttribute("href", "/checks/1");
  });

  test("New monitors defaults to ONLY the un-activated specs, with the count in the header", async ({ page }) => {
    await mockApi(page, worldWithCatalog());
    await page.goto("/monitors");

    // 5 specs, 2 unmonitored (unmon-spec, orphan-spec).
    await expect(page.getByTestId("new-monitors-section-toggle")).toContainText("2 declared specs not yet monitored");
    const nm = page.getByTestId("new-monitors-table");
    await expect(nm.getByTestId("spec-row-unmon-spec")).toBeVisible();
    await expect(nm.getByTestId("spec-row-orphan-spec")).toBeVisible();
    await expect(nm.getByTestId("spec-row-active-spec")).toHaveCount(0);
    await expect(nm.getByTestId("spec-row-paused-spec")).toHaveCount(0);
  });

  test("Browse the full catalog reveals every spec; the tag filter (bare-string AND) narrows it", async ({ page }) => {
    await mockApi(page, worldWithCatalog());
    await page.goto("/monitors");
    await page.getByTestId("browse-catalog").click();

    const cat = page.getByTestId("full-catalog-table");
    await expect(cat.getByTestId("spec-row-active-spec")).toBeVisible();
    await expect(cat.getByTestId("spec-row-paused-spec")).toBeVisible();
    // active-spec carries tags ["a","journey"]; the others carry none → filtering "journey" leaves only it
    await page.getByTestId("spec-tag-journey").click();
    await expect(cat.getByTestId("spec-row-active-spec")).toBeVisible();
    await expect(cat.getByTestId("spec-row-paused-spec")).toHaveCount(0);
    await expect(cat.getByTestId("spec-row-unmon-spec")).toHaveCount(0);
  });

  test("empty not-set-up → the New monitors header reads 'All declared specs are monitored'", async ({ page }) => {
    const w = worldWithCatalog();
    w.specCatalog!.items = w.specCatalog!.items.map((it) => ({ ...it, monitored: true, checkId: 9, enabled: true }));
    await mockApi(page, w);
    await page.goto("/monitors");

    await expect(page.getByTestId("new-monitors-section-toggle")).toContainText("All declared specs are monitored");
    await expect(page.getByTestId("new-monitors-table")).toHaveCount(0);
  });

  test("graceful: /api/specs 404 → the New monitors section is simply absent (no crash)", async ({ page }) => {
    await mockApi(page, defaultWorld()); // specCatalog unset → /api/specs 404s
    await page.goto("/monitors");

    await expect(page.getByRole("heading", { name: "Monitors" })).toBeVisible();
    await expect(page.getByTestId("new-monitors-section")).toHaveCount(0);
  });

  test("cross-link: the reconcile surface links DOWN to the in-page new-monitors anchor", async ({ page }) => {
    const w = defaultWorld();
    w.reconcileDrift = {
      items: [
        { sourceKey: "a", driftType: "new", detail: { name: "A", kind: "browser" }, detectedAt: "2026-06-25T12:00:00Z" },
        { sourceKey: "b", driftType: "new", detail: { name: "B", kind: "browser" }, detectedAt: "2026-06-25T12:00:00Z" },
      ],
    };
    await mockApi(page, w);
    await page.goto("/monitors");

    const link = page.getByTestId("drift-catalog-link");
    await expect(link).toBeVisible();
    await expect(link).toContainText("2 specs unmonitored");
    await expect(link).toHaveAttribute("href", "#new-monitors");
  });
});
