import { test, expect, type Page } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

// Responsive measure for the consolidated /monitors page. The merge's real layout risk is NOT card reflow —
// it's TABLE COLUMNS (the full spec catalog: Coverage / Runnable / Linked monitor / Health) plus TWO new
// section headers stacked above the current-monitors table. This pins "no horizontal overflow" at 1440 / 1024
// / 768 with a realistic ~37-spec catalog AND the full-catalog reveal open (the widest state the page reaches).

// A realistic catalog: 37 specs, a spread of coverage/runnable/health so every column renders its widest cell.
const BIG_CATALOG = Array.from({ length: 37 }, (_, i) => {
  const monitored = i % 3 !== 0; // ~2/3 monitored
  const runnable = i % 7 !== 0; // a few orphans
  return {
    sourceKey: `team-web/journey-${String(i).padStart(2, "0")}-a-fairly-long-source-key`,
    name: `Wegmans — checkout journey step ${i} (a realistically long monitor name)`,
    specPath: `monitors/team-web/journeys/checkout/step-${i}-a-longish-spec-path.spec.ts`,
    kind: "browser",
    target: `https://www.wegmans.com/shop/checkout/step-${i}`,
    suggestedIntervalSeconds: 600,
    tags: ["team:web", "journey:checkout", `shard:${i % 4}`],
    runnable,
    notRunnableReason: runnable ? null : "won't compile: SyntaxError in a deeply/nested/spec/module.ts",
    monitored,
    checkId: monitored ? 1000 + i : null,
    checkName: monitored ? `Wegmans — checkout journey step ${i}` : null,
    enabled: monitored ? i % 5 !== 0 : null, // some paused
    health: monitored
      ? { currentStatus: i % 4 === 0 ? "fail" : "pass", p95Ms: 4200 + i, openIncidentCount: i % 6 === 0 ? 2 : 0, lastRunAt: "2026-06-25T11:59:00Z" }
      : null,
  };
});

function bigWorld() {
  const w = defaultWorld();
  w.specCatalog = { items: BIG_CATALOG, probedAt: "2026-06-25T12:00:00Z" };
  w.reconcileDrift = {
    items: [
      { sourceKey: "a-drifted-monitor-with-a-long-key", driftType: "changed", detail: { fields: { name: { git: "Home", live: "Homepage — the long live value" } } }, detectedAt: "2026-06-25T12:00:00Z" },
      { sourceKey: "another-new-spec-key", driftType: "new", detail: { name: "New API monitor", kind: "http" }, detectedAt: "2026-06-25T12:00:00Z" },
    ],
    detectedAt: "2026-06-25T12:00:00Z",
  };
  return w;
}

// The whole document must never scroll horizontally (a table wider than the viewport scrolls INSIDE its own
// overflow-x container, not the body).
async function noBodyOverflow(page: Page) {
  return page.evaluate(() => {
    const el = document.documentElement;
    return { scrollW: el.scrollWidth, clientW: el.clientWidth };
  });
}

const VIEWPORTS = [
  { w: 1440, h: 900, label: "desktop" },
  { w: 1024, h: 768, label: "laptop/tablet-landscape" },
  { w: 768, h: 1024, label: "tablet-portrait" },
];

for (const vp of VIEWPORTS) {
  test(`no horizontal overflow at ${vp.w}px (${vp.label}) — reconcile + new-monitors + full catalog + current monitors`, async ({ page }) => {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await mockApi(page, bigWorld());
    await page.goto("/monitors");

    // Open the widest state: reconcile is auto-expanded (drift), new-monitors auto-expanded (37 - monitored
    // unmonitored specs), and reveal the full 37-spec catalog table.
    await expect(page.getByTestId("reconcile-section-toggle")).toHaveAttribute("aria-expanded", "true");
    await page.getByTestId("browse-catalog").click();
    await expect(page.getByTestId("full-catalog")).toBeVisible();
    // 37 rows all mounted (the reveal is permanently in the DOM — confirm it renders at scale).
    await expect(page.getByTestId("full-catalog-table").getByTestId(/^spec-row-/)).toHaveCount(37);

    const { scrollW, clientW } = await noBodyOverflow(page);
    // Allow a 1px rounding slack; anything more is a real horizontal-scroll regression.
    expect(scrollW, `body scrollWidth ${scrollW} must not exceed viewport ${clientW} at ${vp.w}px`).toBeLessThanOrEqual(clientW + 1);
  });
}
