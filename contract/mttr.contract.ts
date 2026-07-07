import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getMttrReport } from "@/lib/api-client";

/**
 * Anchor the MTTR report mapper (getMttrReport) to the REAL API response (contract/real/reports_mttr.json,
 * refreshed by `pnpm capture:contracts`). One of the remaining high-drift-risk UNANCHORED rich rollups
 * (recon Q3): nested fleet + items[] + classification[] + trend[]. Runs the real mapper against the captured
 * real response and pins the camelCase field names prod actually serves — the getRegionHealth bug class.
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

test.describe("API contract — MTTR report mapper vs the real response", () => {
  test("GET /reports/mttr: fleet + items[] mapped by the real camelCase field names", async () => {
    const raw = real("reports_mttr");
    expect(Array.isArray(raw.items), "items is an array").toBe(true);
    expect(raw.items.length, "capture has ≥1 item").toBeGreaterThan(0);

    // Pin the real per-item field names (resolvedCount/openCount/meanSeconds/medianSeconds/mttdProxySeconds/
    // insufficientData) — the mapper reads exactly these; a rename diverges the mapped value → fails here.
    const it0 = raw.items[0];
    for (const f of ["checkId", "checkName", "kind", "resolvedCount", "openCount", "meanSeconds", "medianSeconds", "mttdProxySeconds", "insufficientData"]) {
      expect(it0, `item has ${f}`).toHaveProperty(f);
    }

    const report = await withRealResponse(raw, () => getMttrReport("30d"));
    expect(report, "getMttrReport returns a report (not null) for a 200").toBeTruthy();
    expect(report!.items.length).toBe(raw.items.length);

    for (const r of raw.items) {
      const m = report!.items.find((x) => x.check_id === Number(r.checkId));
      expect(m, `item for check ${r.checkId} present`).toBeTruthy();
      expect(m!.check_name).toBe(r.checkName ?? "");
      expect(m!.resolved_count).toBe(Number(r.resolvedCount ?? 0));
      expect(m!.open_count).toBe(Number(r.openCount ?? 0));
      expect(m!.mean_seconds).toBe(r.meanSeconds == null ? null : Number(r.meanSeconds));
      expect(m!.median_seconds).toBe(r.medianSeconds == null ? null : Number(r.medianSeconds));
      expect(m!.mttd_proxy_seconds).toBe(r.mttdProxySeconds == null ? null : Number(r.mttdProxySeconds));
      expect(m!.insufficient_data).toBe(Boolean(r.insufficientData));
    }

    // ★ nested fleet rollup — totalIncidents is fleet-only (not on items)
    if (raw.fleet) {
      expect(raw.fleet).toHaveProperty("totalIncidents");
      expect(report!.fleet).toBeTruthy();
      expect(report!.fleet!.total_incidents).toBe(Number(raw.fleet.totalIncidents ?? 0));
      expect(report!.fleet!.resolved_count).toBe(Number(raw.fleet.resolvedCount ?? 0));
      expect(report!.fleet!.mean_seconds).toBe(raw.fleet.meanSeconds == null ? null : Number(raw.fleet.meanSeconds));
    }
  });

  test("GET /reports/mttr: classification[] + trend[] mapped by real field names (pctOfTotal/bucketStart)", async () => {
    const raw = real("reports_mttr");
    const report = await withRealResponse(raw, () => getMttrReport("30d"));

    expect(report!.classification.length).toBe((raw.classification ?? []).length);
    for (const c of raw.classification ?? []) {
      const m = report!.classification.find((x) => x.classification === String(c.classification ?? "unclassified"));
      expect(m, `classification bucket ${c.classification}`).toBeTruthy();
      expect(m!.count).toBe(Number(c.count ?? 0));
      expect(m!.pct_of_total).toBe(Number(c.pctOfTotal ?? 0)); // ★ pctOfTotal → pct_of_total
    }

    expect(report!.trend.length).toBe((raw.trend ?? []).length);
    const t0raw = (raw.trend ?? [])[0];
    if (t0raw) {
      expect(t0raw).toHaveProperty("bucketStart");
      expect(report!.trend[0]!.bucket_start).toBe(String(t0raw.bucketStart ?? "")); // ★ bucketStart → bucket_start
      expect(report!.trend[0]!.resolved_count).toBe(Number(t0raw.resolvedCount ?? 0));
    }
  });
});
