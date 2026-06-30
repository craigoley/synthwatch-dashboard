import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

// Monitors-as-code drift surface (Phase 6b), DEMOTED below the active monitors on /monitors (the manage page
// leads with current monitors; what differs from Git is secondary). Read-only (reconcile runs in report mode).
// Two classes rendered apart: resolvable config drift (new/changed/missing) vs the KNOWN-GAP orphans
// (Git defines a monitor the runner can't run yet) — orphans must read neutrally, never as an alarm.

function worldWithDrift() {
  const w = defaultWorld();
  w.reconcileDrift = {
    items: [
      {
        sourceKey: "checkout-flow",
        driftType: "orphan",
        detail: { flow_name: "checkout", reason: "no compiled runner flow module for this monitor" },
        detectedAt: "2026-06-25T12:00:00Z",
      },
      {
        sourceKey: "new-api",
        driftType: "new",
        detail: { name: "New API", kind: "http", target_url: "https://new.example", flow_name: "new-api" },
        detectedAt: "2026-06-25T12:00:00Z",
      },
      {
        sourceKey: "home",
        driftType: "changed",
        detail: { fields: { name: { git: "Home", live: "Homepage" } } },
        detectedAt: "2026-06-25T12:00:00Z",
      },
      {
        sourceKey: "legacy",
        driftType: "missing",
        detail: { name: "Legacy", action: "would soft-disable (enabled=false); never hard-delete" },
        detectedAt: "2026-06-25T12:00:00Z",
      },
    ],
  };
  return w;
}

test.describe("phase 6b — reconcile drift surface", () => {
  test("★ active monitors render ABOVE the demoted monitors-as-code (drift) section", async ({ page }) => {
    await mockApi(page, worldWithDrift());
    await page.goto("/monitors");

    const firstMonitor = page.locator('a[href^="/checks/"]').first();
    const driftSection = page.getByTestId("drift-section");
    await expect(firstMonitor).toBeVisible();
    await expect(driftSection).toBeVisible();
    await expect(driftSection).toContainText("Monitors as code"); // the labeled section break
    // ★ the active set leads; drift is demoted below it.
    const mBox = await firstMonitor.boundingBox();
    const dBox = await driftSection.boundingBox();
    expect(mBox!.y).toBeLessThan(dBox!.y);
  });

  test("renders all 4 drift types, splitting config drift from the orphan known-gap", async ({ page }) => {
    await mockApi(page, worldWithDrift());
    await page.goto("/monitors");

    const surface = page.getByTestId("reconcile-drift");
    await expect(surface).toBeVisible();

    // ── Config drift section: new / changed / missing live here; the orphan does NOT. ──
    const config = page.getByTestId("drift-config");
    await expect(config).toBeVisible();
    await expect(config).toContainText("differ from Git");
    // headline counts the 3 distinct config-drift monitors (new-api, home, legacy).
    await expect(config).toContainText("3 monitors differ from Git");
    await expect(config.locator('[data-drift-type="new"]')).toHaveCount(1);
    await expect(config.locator('[data-drift-type="changed"]')).toHaveCount(1);
    await expect(config.locator('[data-drift-type="missing"]')).toHaveCount(1);
    // a 'changed' row surfaces the per-field git→live diff verbatim.
    await expect(config).toContainText("git «Home»");
    await expect(config).toContainText("live «Homepage»");
    // report-mode posture is explicit (no apply).
    await expect(config).toContainText("report mode");
    // the orphan must NOT appear in the config-drift section.
    await expect(config.locator('[data-source-key="checkout-flow"]')).toHaveCount(0);
  });

  test("★ orphan renders as a neutral KNOWN GAP, visually distinct from config drift (not an alarm)", async ({ page }) => {
    await mockApi(page, worldWithDrift());
    await page.goto("/monitors");

    const orphans = page.getByTestId("drift-orphans");
    await expect(orphans).toBeVisible();
    // labelled as a known/expected gap, not a failure.
    await expect(orphans).toContainText("Known gap");
    await expect(orphans).toContainText("can't run yet");
    await expect(orphans).toContainText("deferred to a later phase");
    // the orphan row lives ONLY here (separate from the config-drift box) and carries its flow.
    await expect(orphans.locator('[data-drift-type="orphan"][data-source-key="checkout-flow"]')).toHaveCount(1);
    await expect(orphans).toContainText("checkout");
    // neutral tone: the orphan section uses the idle (neutral) status dot, NOT the warn/fail dot.
    await expect(orphans.locator(".sw-dot-idle")).toHaveCount(1);
    await expect(orphans.locator(".sw-dot-warn, .sw-dot-fail")).toHaveCount(0);
  });

  test("orphan-only snapshot (the KNOWN CURRENT STATE) reads as in-sync config + known gap", async ({ page }) => {
    const w = defaultWorld();
    w.reconcileDrift = {
      items: [
        { sourceKey: "a", driftType: "orphan", detail: { flow_name: "a" }, detectedAt: "2026-06-25T12:00:00Z" },
        { sourceKey: "b", driftType: "orphan", detail: { flow_name: "b" }, detectedAt: "2026-06-25T12:00:00Z" },
        { sourceKey: "c", driftType: "orphan", detail: { flow_name: "c" }, detectedAt: "2026-06-25T12:00:00Z" },
      ],
    };
    await mockApi(page, w);
    await page.goto("/monitors");

    // No config drift box; instead a positive "config in sync" line + the 3-orphan known gap.
    await expect(page.getByTestId("drift-config")).toHaveCount(0);
    await expect(page.getByTestId("drift-insync")).toContainText("Config in sync with Git");
    const orphans = page.getByTestId("drift-orphans");
    await expect(orphans).toContainText("3 monitors");
    await expect(orphans).toContainText("Known gap");
    // crucially, the 3 orphans never present as "3 monitors differ from Git".
    await expect(page.getByTestId("reconcile-drift")).not.toContainText("differ from Git");
  });

  test("empty snapshot → positive 'in sync with Git' state (not an error)", async ({ page }) => {
    const w = defaultWorld();
    w.reconcileDrift = { items: [] };
    await mockApi(page, w);
    await page.goto("/monitors");

    await expect(page.getByTestId("drift-insync")).toContainText("In sync with Git");
    await expect(page.getByTestId("drift-config")).toHaveCount(0);
    await expect(page.getByTestId("drift-orphans")).toHaveCount(0);
  });

  test("graceful: endpoint not deployed (404) → surface hidden, monitors page still fine", async ({ page }) => {
    await mockApi(page, defaultWorld()); // reconcileDrift unset → /api/reconcile/drift 404s
    await page.goto("/monitors");

    await expect(page.getByRole("heading", { name: "Monitors" })).toBeVisible();
    await expect(page.getByTestId("reconcile-drift")).toHaveCount(0);
  });

  // ── "Reconcile now": event-driven off-cron trigger with runCheckNow-style live progress. ──
  test("★ Reconcile now triggers an off-cron reconcile and re-syncs the snapshot live (no reload)", async ({ page }) => {
    const w = worldWithDrift(); // 4 drift rows, detectedAt 2026-06-25T12:00:00Z
    await mockApi(page, w);
    await page.goto("/monitors");

    const btn = page.getByTestId("reconcile-now");
    await expect(btn).toBeEnabled();
    await expect(page.getByTestId("drift-config")).toBeVisible(); // drift present before reconcile

    // trigger → live progress: the POST is accepted (202) and the button shows it's running
    await btn.click();
    await expect(btn).toHaveText(/Reconciling/);
    await expect(btn).toBeDisabled();

    // the off-cron job completes: it re-runs and rewrites the snapshot (now in sync, detected_at advanced)
    w.reconcileDrift = { items: [], detectedAt: new Date().toISOString() };

    // the scoped fast-poll catches the re-synced snapshot → button re-enables + the surface shows in-sync,
    // WITHOUT a reload (the runCheckNow live-progress pattern, keyed on detected_at advancing)
    await expect(btn).toHaveText("Reconcile now", { timeout: 8000 });
    await expect(page.getByTestId("drift-insync")).toContainText("In sync with Git");
    await expect(page.getByTestId("drift-config")).toHaveCount(0);
  });

  test("a failed reconcile trigger surfaces a clear error and re-enables (no silent failure)", async ({ page }) => {
    const w = worldWithDrift();
    w.reconcileTriggerError = { status: 503 }; // the API couldn't ARM-start the job
    await mockApi(page, w);
    await page.goto("/monitors");

    await page.getByTestId("reconcile-now").click();
    await expect(page.getByTestId("reconcile-error")).toBeVisible();
    await expect(page.getByTestId("reconcile-now")).toBeEnabled(); // recovered, not stuck "Reconciling…"
  });

  test("Reconcile now is editor-gated — hidden for a signed-out viewer (surface still shows read-only)", async ({ page }) => {
    await mockApi(page, worldWithDrift(), { seedSession: false });
    await page.goto("/monitors");

    await expect(page.getByTestId("reconcile-drift")).toBeVisible(); // read-only surface still renders
    await expect(page.getByTestId("reconcile-now")).toHaveCount(0); // but no compute-spending trigger
  });
});
