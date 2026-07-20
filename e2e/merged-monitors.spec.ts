import { test, expect, type Page } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

// The consolidated /monitors page (Catalog merged in): Reconcile / New monitors / Current monitors, on one
// page. These pin the merge invariants — state-dependent collapse, the pinned-closed SIGNAL, three DIFFERENT
// per-section freshness stamps, the /specs redirect, identity-locked activation, and collapse persistence.

const CATALOG = [
  {
    sourceKey: "unmon-a",
    name: "Unmonitored A",
    specPath: "monitors/u/a.spec.ts",
    kind: "browser",
    target: "https://a.example",
    suggestedIntervalSeconds: 600,
    tags: ["team:web"],
    runnable: true,
    notRunnableReason: null,
    monitored: false,
    checkId: null,
    checkName: null,
    enabled: null,
    health: null,
  },
  {
    sourceKey: "active-b",
    name: "Active B",
    specPath: "monitors/a/b.spec.ts",
    kind: "browser",
    target: "https://b.example",
    suggestedIntervalSeconds: 1800,
    tags: [],
    runnable: true,
    notRunnableReason: null,
    monitored: true,
    checkId: 1,
    checkName: "Active B",
    enabled: true,
    health: { currentStatus: "pass", p95Ms: 3000, openIncidentCount: 0, lastRunAt: "2026-06-25T11:00:00Z" },
  },
];

function worldWithDrift() {
  const w = defaultWorld();
  w.reconcileDrift = {
    items: [
      { sourceKey: "a", driftType: "new", detail: { name: "A", kind: "browser" }, detectedAt: "2026-06-25T12:00:00Z" },
      { sourceKey: "b", driftType: "changed", detail: {}, detectedAt: "2026-06-25T12:00:00Z" },
      { sourceKey: "c", driftType: "missing", detail: { name: "C" }, detectedAt: "2026-06-25T12:00:00Z" },
    ],
    detectedAt: "2026-06-25T12:00:00Z",
  };
  w.specCatalog = { items: CATALOG, probedAt: "2026-06-25T12:00:00Z" };
  return w;
}

const reconcileToggle = (page: Page) => page.getByTestId("reconcile-section-toggle");
const newMonitorsToggle = (page: Page) => page.getByTestId("new-monitors-section-toggle");

test.describe("merged /monitors — reconcile section (state-dependent, pinned-closed signal)", () => {
  test("drift → section EXPANDED with the count in the header; the #299 surface is reachable", async ({ page }) => {
    await mockApi(page, worldWithDrift());
    await page.goto("/monitors");

    await expect(reconcileToggle(page)).toContainText("3 monitors differ from Git");
    await expect(reconcileToggle(page)).toHaveAttribute("aria-expanded", "true");
    // the #299 apply flow is reachable (surface visible in the expanded body)
    await expect(page.getByTestId("reconcile-drift")).toBeVisible();
  });

  test("no drift → section COLLAPSED with a quiet 'In sync with Git' header", async ({ page }) => {
    const w = defaultWorld();
    w.reconcileDrift = { items: [], detectedAt: "2026-06-25T12:00:00Z" };
    w.specCatalog = { items: CATALOG, probedAt: "2026-06-25T12:00:00Z" };
    await mockApi(page, w);
    await page.goto("/monitors");

    await expect(reconcileToggle(page)).toContainText("In sync with Git");
    await expect(reconcileToggle(page)).toHaveAttribute("aria-expanded", "false");
    // body collapsed → the surface is hidden (in the DOM, not visible)
    await expect(page.getByTestId("reconcile-drift")).toBeHidden();
  });

  test("★ pinned CLOSED + drift → the header STILL warns (the body collapses, the signal never does)", async ({ page }) => {
    await mockApi(page, worldWithDrift());
    await page.goto("/monitors");

    // Auto-expanded on drift; pin it CLOSED.
    await expect(reconcileToggle(page)).toHaveAttribute("aria-expanded", "true");
    await reconcileToggle(page).click();
    await expect(reconcileToggle(page)).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("reconcile-drift")).toBeHidden();
    // ★ Even pinned shut, the header announces the drift — a primary alert is never buried by a preference.
    await expect(reconcileToggle(page)).toContainText("3 monitors differ from Git");
  });
});

test.describe("merged /monitors — new monitors section + coverage reveal", () => {
  test("un-activated spec appears in New monitors; it DISAPPEARS after activation", async ({ page }) => {
    await mockApi(page, worldWithDrift());
    await page.goto("/monitors");

    await expect(newMonitorsToggle(page)).toContainText("1 declared spec not yet monitored");
    const nm = page.getByTestId("new-monitors-table");
    const row = nm.getByTestId("spec-row-unmon-a");
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-coverage", "unmonitored");

    // Activate — identity-locked form → POST /checks → the mock flips the catalog row monitored.
    await nm.getByTestId("setup-unmon-a").click();
    await Promise.all([
      page.waitForRequest((r) => r.url().endsWith("/api/checks") && r.method() === "POST"),
      page.getByRole("dialog").getByRole("button", { name: "Set up monitor" }).click(),
    ]);
    // The un-activated row leaves the New monitors list (it's now monitored → not the set-difference).
    await expect(page.getByTestId("new-monitors-table").getByTestId("spec-row-unmon-a")).toHaveCount(0);
  });

  test("activation stays IDENTITY-LOCKED (spec_path + source_key from Git, not free-form)", async ({ page }) => {
    await mockApi(page, worldWithDrift());
    await page.goto("/monitors");

    await page.getByTestId("new-monitors-table").getByTestId("setup-unmon-a").click();
    await expect(page.getByRole("dialog").getByTestId("activation-banner")).toContainText("monitors/u/a.spec.ts");
    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().endsWith("/api/checks") && r.method() === "POST"),
      page.getByRole("dialog").getByRole("button", { name: "Set up monitor" }).click(),
    ]);
    const body = req.postDataJSON();
    expect(body.sourceKey).toBe("unmon-a");
    expect(body.specPath).toBe("monitors/u/a.spec.ts");
  });

  test("the coverage answer is inline: 'Browse the full spec catalog' reveals the All table", async ({ page }) => {
    await mockApi(page, worldWithDrift());
    await page.goto("/monitors");

    // Reveal is collapsed by default; the full-catalog table is in the DOM but hidden.
    await expect(page.getByTestId("full-catalog")).toBeHidden();
    await page.getByTestId("browse-catalog").click();
    await expect(page.getByTestId("full-catalog")).toBeVisible();
    // the ACTIVE spec (hidden from the un-activated list) shows here with its coverage + a link to /checks/1
    const activeRow = page.getByTestId("full-catalog-table").getByTestId("spec-row-active-b");
    await expect(activeRow).toHaveAttribute("data-coverage", "active");
    await expect(activeRow.getByRole("link", { name: "Active B" })).toHaveAttribute("href", "/checks/1");
  });
});

test.describe("merged /monitors — freshness, routing, persistence", () => {
  test("three per-section freshness stamps are present and DIFFERENT", async ({ page }) => {
    await mockApi(page, worldWithDrift());
    await page.goto("/monitors");

    const live = (await page.getByTestId("monitors-live-stamp").textContent())?.trim();
    const recon = (await page.getByTestId("reconcile-stamp").textContent())?.trim();
    const cat = (await page.getByTestId("new-monitors-stamp").textContent())?.trim();
    expect(live).toContain("live");
    expect(recon).toContain("reconciled");
    expect(cat).toContain("as of");
    // three distinct stamps — a stale snapshot next to live data can't read as equally current
    expect(new Set([live, recon, cat]).size).toBe(3);
  });

  test("/specs redirects to the merged page and expands the New monitors section", async ({ page }) => {
    await mockApi(page, worldWithDrift());
    await page.goto("/specs");

    await expect(page).toHaveURL(/\/monitors\?from=catalog/);
    // from=catalog force-expands section 2 regardless of the auto/pinned state
    await expect(newMonitorsToggle(page)).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("new-monitors-table").getByTestId("spec-row-unmon-a")).toBeVisible();
  });

  test("collapse state survives a reload (per-browser localStorage)", async ({ page }) => {
    await mockApi(page, worldWithDrift());
    await page.goto("/monitors");

    // drift → auto-open; pin it closed, then reload — the pin persists.
    await reconcileToggle(page).click();
    await expect(reconcileToggle(page)).toHaveAttribute("aria-expanded", "false");
    await page.reload();
    await expect(reconcileToggle(page)).toHaveAttribute("aria-expanded", "false");
  });
});
