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
    for (const f of ["generatedAt", "rateUsed", "rateSource", "rateSetDate", "azure", "estimatedMonthlyTotal", "totalProjectedMonthly", "totalMeasuredMonthly", "topCostDrivers", "checks"]) {
      expect(raw, `report has ${f}`).toHaveProperty(f);
    }
    expect(((await withRealResponse(raw, () => getCostReport())))!.estimated_monthly_total).toBe(Number(raw.estimatedMonthlyTotal)); // 0091 fleet estimate
    const rep = await withRealResponse(raw, () => getCostReport());
    expect(rep, "getCostReport returns a report (not null) for a 200").toBeTruthy();
    expect(rep!.rate_used).toBe(Number(raw.rateUsed)); // ★ echoed rate — the UI reads it, never hardcodes
    expect(rep!.rate_source).toBe(raw.rateSource);
    expect(rep!.rate_set_date).toBe(raw.rateSetDate);
    expect(rep!.total_projected_monthly).toBe(Number(raw.totalProjectedMonthly));
    expect(rep!.total_measured_monthly).toBe(Number(raw.totalMeasuredMonthly));
    expect(rep!.checks.length).toBe(raw.checks.length);
    expect(rep!.top_cost_drivers.length).toBe(raw.topCostDrivers.length);

    // ★ The Azure headline block (0090) — the honest dollar figure the panel DISPLAYS. Pin its field names so
    // the mapper can't silently drift; a null block (absent pull) maps to null (proven in the mapper unit).
    const az = raw.azure as Record<string, unknown>;
    for (const f of ["scope", "currency", "billingMonth", "mtdActual", "mtdDays", "forecastMonth", "portalUrl", "fetchedAt"]) {
      expect(az, `azure block has ${f}`).toHaveProperty(f);
    }
    expect(rep!.azure).not.toBeNull();
    expect(rep!.azure!.mtd_actual).toBe(Number(az.mtdActual));
    expect(rep!.azure!.forecast_month).toBe(az.forecastMonth == null ? null : Number(az.forecastMonth));
    expect(rep!.azure!.mtd_days).toBe(Number(az.mtdDays));
    expect(rep!.azure!.portal_url).toBe(az.portalUrl); // the fallback deep-link target
    expect(rep!.azure!.fetched_at).toBe(az.fetchedAt); // the "as of" + staleness source
  });

  test("per-check row mapped by the real field names (avgDurationS null-safe, divergence flag)", async () => {
    const raw = real("reports_cost");
    const rows = (raw.checks as Record<string, unknown>[]);
    expect(rows.length, "capture has ≥1 check").toBeGreaterThan(0);
    for (const f of ["checkId", "sourceKey", "name", "kind", "intervalSeconds", "regionCount", "avgDurationS", "estimatedMonthly", "activeSeconds", "activeSecondsPct", "projectedMonthly", "measuredMonthly7d", "divergenceRatio", "divergenceFlag", "runCount7d", "confirmationCount7d", "sandboxCount7d", "runCountRecent", "runCountPrior"]) {
      expect(rows[0], `check row has ${f}`).toHaveProperty(f);
    }
    const rep = await withRealResponse(raw, () => getCostReport());
    for (const rr of rows) {
      const m = rep!.checks.find((x) => x.check_id === Number(rr.checkId));
      expect(m, `check ${rr.checkId} present`).toBeTruthy();
      expect(m!.interval_seconds).toBe(Number(rr.intervalSeconds));
      expect(m!.region_count).toBe(Number(rr.regionCount)); // the literal region multiplier
      expect(m!.avg_duration_s).toBe(rr.avgDurationS == null ? null : Number(rr.avgDurationS)); // null preserved (no runs) — never a fake 0
      expect(m!.estimated_monthly).toBe(rr.estimatedMonthly == null ? null : Number(rr.estimatedMonthly)); // 0091 — primary $, null-safe
      expect(m!.active_seconds).toBe(Number(rr.activeSeconds)); // 0089 — attributable compute
      expect(m!.active_seconds_pct).toBe(rr.activeSecondsPct == null ? null : Number(rr.activeSecondsPct)); // 0089 — share, null-safe
      expect(m!.projected_monthly).toBe(Number(rr.projectedMonthly));
      expect(m!.divergence_flag).toBe(Boolean(rr.divergenceFlag));
      expect(m!.run_count_7d).toBe(Number(rr.runCount7d)); // 0078 attribution counts mapped
      expect(m!.confirmation_count_7d).toBe(Number(rr.confirmationCount7d));
      expect(m!.sandbox_count_7d).toBe(Number(rr.sandboxCount7d));
    }
  });
});
