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

  test("no drift → NO reconcile panel; 'In sync with Git' folds into the thin status line", async ({ page }) => {
    const w = defaultWorld();
    w.reconcileDrift = { items: [], detectedAt: "2026-06-25T12:00:00Z" };
    w.specCatalog = { items: CATALOG, probedAt: "2026-06-25T12:00:00Z" };
    await mockApi(page, w);
    await page.goto("/monitors");

    // ★ Healthy = a thin status row, NOT a collapsed-but-chromed panel. No reconcile panel renders at all.
    await expect(page.getByTestId("reconcile-section")).toHaveCount(0);
    await expect(page.getByTestId("reconcile-drift")).toHaveCount(0);
    await expect(page.getByTestId("monitors-status-line")).toContainText("In sync with Git");
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

// The HEALTHY state (no drift, every declared spec monitored) must be a single thin status row above the
// Monitors table — NOT two stacked panels of "nothing to do". This is the #304 follow-up: collapsed-with-
// panel-chrome was still ~290px+ of weight; the healthy state must be nearly invisible.
function healthyWorld() {
  const w = defaultWorld();
  w.reconcileDrift = { items: [], detectedAt: "2026-07-20T12:00:00Z" };
  w.specCatalog = {
    probedAt: "2026-07-20T12:00:00Z",
    items: Array.from({ length: 20 }, (_, i) => ({
      sourceKey: `spec-${i}`, name: `Monitor ${i}`, specPath: `monitors/x/spec-${i}.spec.ts`, kind: "browser",
      target: "https://x.example", suggestedIntervalSeconds: 600, tags: [], runnable: true, notRunnableReason: null,
      monitored: true, checkId: 100 + i, checkName: `Monitor ${i}`, enabled: true,
      health: { currentStatus: "pass", p95Ms: 1000, openIncidentCount: 0, lastRunAt: "2026-07-20T11:00:00Z" },
    })),
  };
  return w;
}

test.describe("merged /monitors — healthy state is ONE thin status line, not two panels", () => {
  test("no drift + all monitored → a single status row, ZERO section panels", async ({ page }) => {
    await mockApi(page, healthyWorld());
    await page.goto("/monitors");

    // ★ Neither section renders as a panel — no CollapsibleSection chrome at all.
    await expect(page.getByTestId("reconcile-section")).toHaveCount(0);
    await expect(page.getByTestId("new-monitors-section")).toHaveCount(0);
    await expect(page.getByTestId("reconcile-drift")).toHaveCount(0);

    // ★ One thin line carries every clean signal + the coverage entry + [Reconcile now].
    const line = page.getByTestId("monitors-status-line");
    await expect(line).toContainText("In sync with Git");
    await expect(line).toContainText("20 declared specs, all monitored");
    await expect(line).toContainText("as of");
    await expect(line.getByTestId("reconcile-now")).toBeVisible();
    await expect(line.getByTestId("browse-catalog")).toBeVisible();
  });

  test("★ the healthy line's footprint is ~one row, not a stack of panels (< 80px)", async ({ page }) => {
    await mockApi(page, healthyWorld());
    await page.goto("/monitors");
    await expect(page.getByTestId("monitors-status-line")).toBeVisible();

    // Space from the top of the reconcile/catalog region (the status line) to the Monitors header — the
    // #304 acceptance number. Two collapsed panels were ~150px; two expanded were ~450px. Target: one row.
    const footprint = await page.evaluate(() => {
      const line = document.querySelector('[data-testid="monitors-status-line"]')!.getBoundingClientRect();
      const hdr = document.querySelector(".sw-eyebrow")!.getBoundingClientRect();
      return Math.round(hdr.top - line.top);
    });
    expect(footprint, `reconcile/catalog region footprint ${footprint}px must be ~one row`).toBeLessThan(80);
  });

  test("★ a STALE 'open' pin does NOT resurrect a panel in the healthy state", async ({ page }) => {
    // A pin set while there WAS work (user opened a section during review) must not make the healthy state loud:
    // healthy renders no panel to honor the pin against.
    await page.addInitScript(() => {
      localStorage.setItem("synthwatch:monitors-reconcile", "open");
      localStorage.setItem("synthwatch:monitors-new-monitors", "open");
    });
    await mockApi(page, healthyWorld());
    await page.goto("/monitors");

    await expect(page.getByTestId("reconcile-section")).toHaveCount(0);
    await expect(page.getByTestId("new-monitors-section")).toHaveCount(0);
    await expect(page.getByTestId("monitors-status-line")).toContainText("In sync with Git");
  });

  test("work returns → the panels come back (drift → reconcile panel expanded with the count)", async ({ page }) => {
    await mockApi(page, worldWithDrift());
    await page.goto("/monitors");

    // With drift, the loud panel is present + expanded (the healthy thin line does not apply).
    await expect(page.getByTestId("reconcile-section-toggle")).toContainText("3 monitors differ from Git");
    await expect(page.getByTestId("reconcile-section-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("reconcile-drift")).toBeVisible();
  });
});

test.describe("nav — Catalog tab removed (its /specs redirect kept for bookmarks)", () => {
  test("no 'Catalog' nav item; the coverage entry is on the Monitors page", async ({ page }) => {
    await mockApi(page, healthyWorld());
    await page.goto("/monitors");

    await expect(page.getByRole("navigation").getByRole("link", { name: "Catalog" })).toHaveCount(0);
    // /specs still redirects (bookmarks), and the on-page coverage entry is the browse reveal.
    await expect(page.getByTestId("monitors-status-line").getByTestId("browse-catalog")).toBeVisible();
  });
});
