import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getCostReport } from "@/lib/api-client";

/**
 * Anchor GET /reports/cost (synthwatch-api #198) — the estimated monthly ACA cost report. Runs the real
 * mapper against the captured real response so the cost UI's field names can't silently drift from prod (the
 * mock-vs-real divergence class this repo has been burned by). Pins the aggregate + per-check camelCase names.
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

test.describe("API contract — /reports/cost mapper vs the real response", () => {
  test("aggregate + rate provenance mapped by the real field names", async () => {
    const raw = real("reports_cost");
    for (const f of ["generatedAt", "rateUsed", "rateSource", "rateSetDate", "totalProjectedMonthly", "totalMeasuredMonthly", "topCostDrivers", "checks"]) {
      expect(raw, `report has ${f}`).toHaveProperty(f);
    }
    const rep = await withRealResponse(raw, () => getCostReport());
    expect(rep, "getCostReport returns a report (not null) for a 200").toBeTruthy();
    expect(rep!.rate_used).toBe(Number(raw.rateUsed)); // ★ echoed rate — the UI reads it, never hardcodes
    expect(rep!.rate_source).toBe(raw.rateSource);
    expect(rep!.rate_set_date).toBe(raw.rateSetDate);
    expect(rep!.total_projected_monthly).toBe(Number(raw.totalProjectedMonthly));
    expect(rep!.total_measured_monthly).toBe(Number(raw.totalMeasuredMonthly));
    expect(rep!.checks.length).toBe(raw.checks.length);
    expect(rep!.top_cost_drivers.length).toBe(raw.topCostDrivers.length);
  });

  test("per-check row mapped by the real field names (avgDurationS null-safe, divergence flag)", async () => {
    const raw = real("reports_cost");
    const rows = (raw.checks as Record<string, unknown>[]);
    expect(rows.length, "capture has ≥1 check").toBeGreaterThan(0);
    for (const f of ["checkId", "sourceKey", "name", "kind", "intervalSeconds", "regionCount", "avgDurationS", "projectedMonthly", "measuredMonthly7d", "divergenceRatio", "divergenceFlag"]) {
      expect(rows[0], `check row has ${f}`).toHaveProperty(f);
    }
    const rep = await withRealResponse(raw, () => getCostReport());
    for (const rr of rows) {
      const m = rep!.checks.find((x) => x.check_id === Number(rr.checkId));
      expect(m, `check ${rr.checkId} present`).toBeTruthy();
      expect(m!.interval_seconds).toBe(Number(rr.intervalSeconds));
      expect(m!.region_count).toBe(Number(rr.regionCount)); // the literal region multiplier
      expect(m!.avg_duration_s).toBe(rr.avgDurationS == null ? null : Number(rr.avgDurationS)); // null preserved (no runs) — never a fake 0
      expect(m!.projected_monthly).toBe(Number(rr.projectedMonthly));
      expect(m!.divergence_flag).toBe(Boolean(rr.divergenceFlag));
    }
  });
});
