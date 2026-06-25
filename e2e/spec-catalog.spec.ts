import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

// Spec catalog (Phase 13) — the read-only inventory at /specs. Two orthogonal dimensions per row:
// Coverage (Unmonitored/Active/Paused) and Runnable? (✓ / ⚠ orphan). A spec can be Active+Orphan or
// Unmonitored+Orphan — the dimensions are independent. Plus the cross-link from the /monitors drift surface.

function worldWithCatalog() {
  const w = defaultWorld();
  w.specCatalog = {
    items: [
      {
        sourceKey: "active-spec",
        name: "Active Mon",
        specPath: "monitors/a/active.spec.ts",
        kind: "browser",
        target: "https://a.example",
        suggestedIntervalSeconds: 1800,
        tags: ["a", "journey"],
        runnable: true,
        notRunnableReason: null,
        monitored: true,
        checkId: 1,
        checkName: "Active Mon",
        enabled: true,
        health: { currentStatus: "pass", p95Ms: 4200, openIncidentCount: 0, lastRunAt: "2026-06-25T11:59:00Z" },
      },
      {
        sourceKey: "paused-spec",
        name: "Paused Mon",
        specPath: "monitors/p/paused.spec.ts",
        kind: "browser",
        target: "https://p.example",
        suggestedIntervalSeconds: 600,
        tags: [],
        runnable: true,
        notRunnableReason: null,
        monitored: true,
        checkId: 2,
        checkName: "Paused Mon",
        enabled: false,
        health: { currentStatus: "pass", p95Ms: 900, openIncidentCount: 0, lastRunAt: "2026-06-24T10:00:00Z" },
      },
      {
        sourceKey: "unmon-spec",
        name: "Unmonitored Mon",
        specPath: "monitors/u/unmon.spec.ts",
        kind: "browser",
        target: "https://u.example",
        suggestedIntervalSeconds: 1800,
        tags: [],
        runnable: true,
        notRunnableReason: null,
        monitored: false,
        checkId: null,
        checkName: null,
        enabled: null,
        health: null,
      },
      {
        sourceKey: "orphan-spec",
        name: "Orphan Mon",
        specPath: "monitors/o/orphan.spec.ts",
        kind: "browser",
        target: null,
        suggestedIntervalSeconds: null,
        tags: [],
        runnable: false,
        notRunnableReason: "not fetchable: 404",
        monitored: false,
        checkId: null,
        checkName: null,
        enabled: null,
        health: null,
      },
      {
        // ★ orthogonal dimensions: an ACTIVE spec whose spec broke (Active + Orphan).
        sourceKey: "active-orphan-spec",
        name: "Active Orphan Mon",
        specPath: "monitors/ao/active-orphan.spec.ts",
        kind: "browser",
        target: "https://ao.example",
        suggestedIntervalSeconds: 1800,
        tags: [],
        runnable: false,
        notRunnableReason: "won't compile: SyntaxError",
        monitored: true,
        checkId: 3,
        checkName: "Active Orphan Mon",
        enabled: true,
        health: { currentStatus: "infra_error", p95Ms: null, openIncidentCount: 0, lastRunAt: "2026-06-25T11:00:00Z" },
      },
    ],
  };
  return w;
}

test.describe("phase 13 — spec catalog (read-only)", () => {
  test("renders BOTH status dimensions: coverage and runnable, independently", async ({ page }) => {
    await mockApi(page, worldWithCatalog());
    await page.goto("/specs");

    const catalog = page.getByTestId("spec-catalog");
    await expect(catalog).toBeVisible();

    // Coverage dimension.
    await expect(page.getByTestId("spec-row-active-spec")).toHaveAttribute("data-coverage", "active");
    await expect(page.getByTestId("spec-row-paused-spec")).toHaveAttribute("data-coverage", "paused");
    await expect(page.getByTestId("spec-row-unmon-spec")).toHaveAttribute("data-coverage", "unmonitored");

    // Runnable dimension (independent of coverage).
    await expect(page.getByTestId("spec-row-unmon-spec")).toHaveAttribute("data-runnable", "true");
    await expect(page.getByTestId("spec-row-orphan-spec")).toHaveAttribute("data-runnable", "false");

    // ★ orthogonality: Active + Orphan in the same row (coverage active, runnable false).
    const activeOrphan = page.getByTestId("spec-row-active-orphan-spec");
    await expect(activeOrphan).toHaveAttribute("data-coverage", "active");
    await expect(activeOrphan).toHaveAttribute("data-runnable", "false");
  });

  test("Unmonitored + Orphan row reads as a neutral known-gap with its reason", async ({ page }) => {
    await mockApi(page, worldWithCatalog());
    await page.goto("/specs");

    const orphan = page.getByTestId("spec-row-orphan-spec");
    await expect(orphan).toHaveAttribute("data-coverage", "unmonitored");
    await expect(orphan.getByTestId("spec-runnable")).toContainText("Orphan");
    await expect(orphan.getByTestId("spec-runnable")).toContainText("not fetchable: 404"); // the probe reason
    await expect(orphan).toContainText("monitors/o/orphan.spec.ts"); // spec path shown
    await expect(orphan).toContainText("—"); // no linked monitor / no health
  });

  test("Active row: health (status dot + p95) and a link to the live monitor", async ({ page }) => {
    await mockApi(page, worldWithCatalog());
    await page.goto("/specs");

    const active = page.getByTestId("spec-row-active-spec");
    await expect(active).toContainText("4.20s"); // p95 health
    await expect(active.locator(".sw-dot-pass")).toBeVisible(); // current_status dot
    const link = active.getByRole("link", { name: "Active Mon" });
    await expect(link).toHaveAttribute("href", "/checks/1");
    // Unmonitored rows carry no health.
    await expect(page.getByTestId("spec-row-unmon-spec")).not.toContainText("4.20s");
  });

  test("empty catalog → 'no specs yet' (reconcile hasn't populated it)", async ({ page }) => {
    const w = defaultWorld();
    w.specCatalog = { items: [] };
    await mockApi(page, w);
    await page.goto("/specs");

    await expect(page.getByText("No specs in the catalog yet.")).toBeVisible();
    await expect(page.getByTestId("spec-catalog")).toHaveCount(0);
  });

  test("graceful: /api/specs 404 → neutral 'not available' notice, no crash", async ({ page }) => {
    await mockApi(page, defaultWorld()); // specCatalog unset → /api/specs 404s
    await page.goto("/specs");

    await expect(page.getByRole("heading", { name: "Catalog" })).toBeVisible();
    await expect(page.getByTestId("spec-unavailable")).toBeVisible();
    await expect(page.getByTestId("spec-catalog")).toHaveCount(0);
  });

  test("cross-link: the /monitors drift surface links to the catalog with the unmonitored count", async ({ page }) => {
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
    await expect(link).toHaveAttribute("href", "/specs");
  });
});
