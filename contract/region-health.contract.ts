import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getRegionHealth } from "@/lib/api-client";

/**
 * Anchor the region-health mapper (getRegionHealth) to the REAL API response
 * (contract/real/reports_region_health.json, refreshed by `pnpm capture:contracts`). This is the #168/#192
 * F-4 alarm panel — it was UNANCHORED and its fixture wasn't even captured (recon Q3). Two contracts pinned:
 *  1. FIELD NAME: the API serves the region name as `location` (NOT `region`). The mapper read only `r.region`,
 *     so every row's name was "" in prod (blank labels, empty testids, duplicate keys) while the e2e mock —
 *     which serves `region` — stayed green. The classic mock-vs-real divergence a contract anchor exists to
 *     catch. Fixed to read `location` (fallback `region`); this test is the tripwire.
 *  2. FAIL-SAFE-LOUD coercion (#192): an off-taxonomy/absent `status` must render as "stale" (alarm), never a
 *     silent healthy — this panel IS the alarm. The must-go-red below.
 */

const REAL = join(__dirname, "real");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const real = (name: string): any => JSON.parse(readFileSync(join(REAL, `${name}.json`), "utf8"));

/** Run `fn` with global fetch stubbed to return `body` as a 200 JSON response; restore fetch after. */
async function withRealResponse<T>(body: unknown, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

test.describe("API contract — region-health mapper vs the real response", () => {
  test("GET /reports/region-health: per-region rollup mapped by the real field names", async () => {
    const raw = real("reports_region_health");
    expect(Array.isArray(raw.regions), "regions is an array").toBe(true);
    expect(raw.regions.length, "the capture has ≥1 region").toBeGreaterThan(0);

    // ★ Pin the real row shape: the API serves `location` (NOT `region`), plus lastRunAt/ageSeconds/status.
    const r0 = raw.regions[0];
    expect(r0, "row has `location` (the region name field the API actually serves)").toHaveProperty("location");
    expect(r0, "row does NOT have `region` (the field the mapper wrongly read before)").not.toHaveProperty("region");
    for (const f of ["status", "lastRunAt", "ageSeconds"]) expect(r0, `row has ${f}`).toHaveProperty(f);

    const report = await withRealResponse(raw, () => getRegionHealth());
    expect(report, "getRegionHealth returns a report (not null) for a 200").toBeTruthy();
    expect(report!.regions.length).toBe(raw.regions.length);

    for (const rr of raw.regions) {
      const m = report!.regions.find((x) => x.region === rr.location);
      // ★ region ← location. If the mapper reverts to reading `r.region`, this is "" and the find fails.
      expect(m, `region "${rr.location}" mapped by its real location field`).toBeTruthy();
      expect(m!.region).toBe(rr.location);
      expect(m!.region).not.toBe(""); // never a blank label in prod
      expect(m!.last_run_at).toBe(rr.lastRunAt == null ? null : String(rr.lastRunAt));
      expect(m!.age_seconds).toBe(rr.ageSeconds == null ? null : Number(rr.ageSeconds));
      expect(["fresh", "stale", "never_reported"]).toContain(m!.status);
    }
  });

  // ★ TEETH for the field-name contract: against the REAL shape, reading `region` is all-empty while reading
  // `location` varies. So the `region === location` assertion above is a real tripwire, not a tautology.
  test("teeth: against the real shape, `region` is all-empty and `location` varies", () => {
    const rows = real("reports_region_health").regions as Record<string, unknown>[];
    const fromWrongField = rows.map((r) => String(r.region ?? ""));
    const fromRightField = rows.map((r) => String(r.location ?? ""));
    expect(fromWrongField.every((s) => s === "")).toBe(true); // wrong field → blank everywhere
    expect(new Set(fromRightField).size).toBeGreaterThan(1); // right field → distinct region names
  });

  // ★ MUST-GO-RED (#192 fail-safe-loud): an off-taxonomy status coerces to "stale", never a silent healthy.
  test("teeth: an off-taxonomy status coerces to 'stale' (the alarm never renders as fresh/absent)", async () => {
    const raw = real("reports_region_health");
    const poisoned = {
      ...raw,
      regions: [{ ...raw.regions[0], location: "poison-region", status: "totally-bogus" }],
    };
    const report = await withRealResponse(poisoned, () => getRegionHealth());
    const p = report!.regions.find((x) => x.region === "poison-region");
    expect(p, "the poisoned region is present").toBeTruthy();
    expect(p!.status).toBe("stale"); // off-taxonomy → stale (alarm), NOT passed through
  });
});
