import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getEgressReport } from "@/lib/api-client";

/**
 * Anchor the egress-stability mapper (getEgressReport) to the REAL API response
 * (contract/real/reports_egress.json, refreshed by `pnpm capture:contracts`). Remaining high-drift-risk
 * UNANCHORED seam (recon Q3). This one caught the getRegionHealth bug class again:
 *   the API sends first/last-seen + run counts PER IP, NOT at the region level (region rows carry only
 *   location/currentIps/distinctCount/ips). The mapper read r.firstSeen / r.lastSeen / r.runCount → ""/""/0
 *   in prod, so the "N runs · stable since …" region summary was blank. Fixed to DERIVE the region rollup
 *   from ips[] (sum of runs, earliest first_seen, latest last_seen). These tests pin both the sent fields and
 *   the derivation, and prove the region-level fields are genuinely absent from the real response (teeth).
 */

const REAL = join(__dirname, "real");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const real = (name: string): any => JSON.parse(readFileSync(join(REAL, `${name}.json`), "utf8"));

async function withRealResponse<T>(body: unknown, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

test.describe("API contract — egress mapper vs the real response", () => {
  test("GET /reports/egress: region rows send location/currentIps/distinctCount/ips (per-IP first/last-seen)", async () => {
    const raw = real("reports_egress");
    expect(Array.isArray(raw.regions), "regions is an array").toBe(true);
    expect(raw.regions.length, "capture has ≥1 region").toBeGreaterThan(0);

    const r0 = raw.regions[0];
    for (const f of ["location", "currentIps", "distinctCount", "ips"]) expect(r0, `region has ${f}`).toHaveProperty(f);
    // ★ TEETH: the API does NOT send region-level firstSeen/lastSeen/runCount — the mapper must DERIVE them
    //   from ips[]. If someone reverts to reading r.firstSeen/r.lastSeen/r.runCount, the derivation below
    //   (against this real shape) is ""/""/0 and the assertions fail.
    for (const f of ["firstSeen", "lastSeen", "runCount"]) {
      expect(r0, `region row does NOT carry region-level ${f} (it is per-IP)`).not.toHaveProperty(f);
    }
    // the per-IP fields that ARE sent
    for (const f of ["ip", "firstSeen", "lastSeen", "runCount"]) expect(r0.ips[0], `ip has ${f}`).toHaveProperty(f);

    const report = await withRealResponse(raw, () => getEgressReport("all"));
    expect(report, "getEgressReport returns a report (not null) for a 200").toBeTruthy();
    expect(report!.regions.length).toBe(raw.regions.length);

    for (const rr of raw.regions) {
      const m = report!.regions.find((x) => x.location === rr.location);
      expect(m, `region ${rr.location} present`).toBeTruthy();
      expect(m!.current_ips).toEqual((rr.currentIps ?? []).map(String));
      expect(m!.distinct_count).toBe(Number(rr.distinctCount ?? 0));
      // per-IP fields mapped by the real names (firstSeen/lastSeen/runCount)
      expect(m!.ips.length).toBe(rr.ips.length);
      expect(m!.ips[0]!.ip).toBe(String(rr.ips[0].ip));
      expect(m!.ips[0]!.first_seen).toBe(String(rr.ips[0].firstSeen));
      expect(m!.ips[0]!.run_count).toBe(Number(rr.ips[0].runCount ?? 0));

      // ★ the DERIVED region rollup (from ips[]) — not blank/0 in prod
      const ips = rr.ips as Record<string, unknown>[];
      const expectedRun = ips.reduce((s, x) => s + Number(x.runCount ?? 0), 0);
      const expectedFirst = ips.map((x) => String(x.firstSeen)).filter(Boolean).sort()[0] ?? "";
      const expectedLast = ips.map((x) => String(x.lastSeen)).filter(Boolean).sort().slice(-1)[0] ?? "";
      expect(m!.run_count, "region run_count = sum of its IPs' runs").toBe(expectedRun);
      expect(m!.run_count).toBeGreaterThan(0); // never a fabricated 0 in prod
      expect(m!.first_seen, "region first_seen = earliest IP first_seen").toBe(expectedFirst);
      expect(m!.first_seen).not.toBe(""); // never blank → "stable since …" renders
      expect(m!.last_seen, "region last_seen = latest IP last_seen").toBe(expectedLast);
    }
  });

  // ★ TEETH: against the REAL shape, deriving from ips[] yields a positive run count, whereas reading the
  // absent region-level runCount is a constant 0 — so the run_count assertion above is a real tripwire.
  test("teeth: region run count derived from ips[] > 0, but the absent region-level runCount is 0", () => {
    const regions = real("reports_egress").regions as Record<string, unknown>[];
    for (const r of regions) {
      const ips = (r.ips as Record<string, unknown>[]) ?? [];
      const derived = ips.reduce((s, x) => s + Number(x.runCount ?? 0), 0);
      const fromAbsentRegionField = Number((r as Record<string, unknown>).runCount ?? 0);
      expect(derived).toBeGreaterThan(0); // ips[] carries the real run counts
      expect(fromAbsentRegionField).toBe(0); // the region-level field the old mapper read isn't sent
    }
  });
});
