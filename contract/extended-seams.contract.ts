import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getPerformanceReport, getNarrative, getRuns, getCheck } from "@/lib/api-client";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Contract checks — extending the harness to the highest-risk unanchored seams.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Runs the REAL api-client mappers against CAPTURED REAL responses (contract/real/*.json), so a mapper that
 * drifts from the API shape FAILS here. Priority order: prior-bug + complexity first. ★ Anchoring
 * getPerformanceReport (the "free win" — fixture existed, no test) immediately surfaced a LIVE drift: the
 * mapper read flat `g.p50Ms`/`wv.lcpMs`/`c.name` but the API NESTS latency under `latency`, vitals (p75)
 * under `webVitals`, and per-check uses `checkName` → the reports page's windowed latency silently never
 * populated. Fixed in this PR; this test guards it.
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

test.describe("API contract — extended seams", () => {
  test("★ /reports/performance — latency NESTED under `latency`, vitals under `webVitals` (p75), per-check `checkName`", async () => {
    const raw = real("reports_performance_7d");
    const g = raw.groups[0];
    // Pin the real nested shape (what the flat mapper missed).
    expect(g.latency, "group latency is nested under `latency`").toBeTruthy();
    expect(g.checks[0]).toHaveProperty("checkName");
    expect(g.checks[0].latency, "per-check latency is nested").toBeTruthy();

    const res = await withRealResponse(raw, () => getPerformanceReport("7d", "none"));
    expect(res).not.toBeNull();
    const grp = res!.groups[0]!;
    // group latency — was null when read flat (g.p50Ms).
    expect(grp.p50_ms).toBe(g.latency.p50Ms);
    expect(grp.p95_ms).toBe(g.latency.p95Ms);
    expect(grp.avg_ms).toBe(g.latency.avgMs);
    // web vitals from the p75 field names — was null when read as wv.lcpMs/cls.
    if (g.webVitals) {
      expect(grp.web_vitals?.lcp_ms).toBe(g.webVitals.lcpP75Ms);
      expect(grp.web_vitals?.cls).toBe(g.webVitals.clsP75);
    }
    // ★ per-check name + latency — what the reports page reads for windowed p50/p95 (was "" + null).
    const c0 = grp.checks[0]!;
    const rc0 = g.checks[0];
    expect(c0.check_id).toBe(rc0.checkId);
    expect(c0.name).toBe(rc0.checkName);
    expect(c0.p95_ms).toBe(rc0.latency.p95Ms);
  });

  test("/reports/narrative — factPack OBJECT → derived cited chips (guards the #82 blank-chips bug)", async () => {
    const raw = real("narrative_fleet_7d");
    expect(raw.headline, "fixture has a real narrative").toBeTruthy();
    const cur = raw.factPack.current as Record<string, number>;

    const res = await withRealResponse(raw, () => getNarrative("fleet", "7d"));
    expect(res).not.toBeNull();
    expect(res!.headline).toBe(raw.headline);
    // ★ chips DERIVED from factPack.current — non-empty (the #82 bug rendered blank chips from this object).
    expect(res!.factPack.length).toBeGreaterThan(0);
    if (cur.availabilityPct != null) {
      expect(res!.factPack.find((f) => f.label === "Availability")?.value).toBe(`${cur.availabilityPct}%`);
    }
    if (cur.p95 != null) {
      expect(res!.factPack.find((f) => f.label === "p95")?.value).toBe(`${cur.p95}ms`);
    }
  });

  test("/checks/{id}/runs — cursor ENVELOPE {items,nextCursor} → {runs,next_cursor}; camel→snake run fields", async () => {
    const raw = real("runs_check4");
    expect(Array.isArray(raw.items), "the runs live under .items (envelope, not bare array)").toBe(true);
    expect(raw).toHaveProperty("nextCursor");

    const res = await withRealResponse(raw, () => getRuns(4, { pageSize: 10 }));
    expect(res.runs.length).toBe(raw.items.length); // unwrapped from .items
    expect(res.next_cursor).toBe(raw.nextCursor ?? null);
    const r0 = res.runs[0]!;
    const rr0 = raw.items[0];
    expect(r0.id).toBe(rr0.id);
    expect(r0.check_id).toBe(rr0.checkId);
    expect(r0.started_at).toBe(rr0.startedAt);
    expect(r0.duration_ms).toBe(rr0.durationMs);
    expect(r0.failed_step).toBe(rr0.failedStep);
    expect(r0.trace_url).toBe(rr0.traceUrl ?? null);
  });

  test("/checks/{id} — rich CheckDetail: camel→snake check + nested recentRuns → recent_runs", async () => {
    const raw = real("check_detail_10");

    const res = await withRealResponse(raw, () => getCheck(10));
    expect(res.check.id).toBe(raw.id);
    expect(res.check.target_url).toBe(raw.targetUrl); // camel→snake
    expect(res.check.interval_seconds).toBe(raw.intervalSeconds);
    expect(res.check.cert_expiry_warn_days).toBe(raw.certExpiryWarnDays ?? null); // ssl cert config field
    // nested recentRuns array → recent_runs, mapped per-run (incl. the ssl per-run cert value)
    expect(res.recent_runs.length).toBe(raw.recentRuns.length);
    const r0 = res.recent_runs[0]!;
    const rr0 = raw.recentRuns[0];
    expect(r0.cert_days_remaining).toBe(rr0.certDaysRemaining ?? null);
    expect(r0.started_at).toBe(rr0.startedAt);
  });
});
