import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getTrustReport, getTrustDetail } from "@/lib/api-client";

/**
 * Anchor the trust scorecard mappers (getTrustReport + getTrustDetail, both via mapTrustRow) to the REAL API
 * responses (contract/real/reports_trust.json + reports_trust_detail.json, refreshed by
 * `pnpm capture:contracts`). Remaining high-drift-risk UNANCHORED seams (recon Q3) — a deeply nested row
 * (incidents{} + redTest{} + specProvenance{} + the trust chip). Pins the real camelCase field names + the
 * off-taxonomy chip coercion, so a rename/shape drift fails here instead of silently mis-scoring in prod.
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

test.describe("API contract — trust scorecard mappers vs the real responses", () => {
  test("GET /reports/trust: monitors[] mapped by real field names incl. nested incidents/redTest/specProvenance", async () => {
    const raw = real("reports_trust");
    expect(Array.isArray(raw.monitors), "monitors is an array").toBe(true);
    expect(raw.monitors.length, "capture has ≥1 monitor").toBeGreaterThan(0);

    const r0 = raw.monitors[0];
    for (const f of ["checkId", "checkName", "lastGreenAt", "runCount", "retryCount", "retryRate", "incidents", "redTest", "specProvenance", "trust"]) {
      expect(r0, `monitor has ${f}`).toHaveProperty(f);
    }
    // nested field names the mapper reads
    for (const f of ["total", "realOutage", "flakyTransient", "selectorDrift", "environmentRegional", "perfRegression", "unclassified"]) {
      expect(r0.incidents, `incidents has ${f}`).toHaveProperty(f);
    }
    for (const f of ["captured", "testedAt", "method"]) expect(r0.redTest, `redTest has ${f}`).toHaveProperty(f);
    for (const f of ["executedSha256", "specPath"]) expect(r0.specProvenance, `specProvenance has ${f}`).toHaveProperty(f);
    // ★ STALENESS FIX: the B3-2/B3-3 seams the OLD (2026-07-07) capture never carried, so the gate never
    // checked them. Now pinned — a rename of any of these drifts loudly here instead of silently mis-scoring.
    for (const f of ["flakeBudget", "dimensions", "transients", "flapCount", "flapRate", "scheduledCount"]) {
      expect(r0, `monitor has ${f} (B3 fields the stale capture lacked)`).toHaveProperty(f);
    }
    for (const f of ["state", "consumed", "budget", "burnRate", "directedTask", "targetIsDefault"]) {
      expect(r0.flakeBudget, `flakeBudget has ${f}`).toHaveProperty(f);
    }
    for (const f of ["flap", "retry", "monitorNoise", "spuriousRed"]) {
      expect(r0.dimensions[f], `dimensions.${f} has state`).toHaveProperty("state");
    }
    for (const f of ["monitorSide", "serviceSide", "indeterminate", "spuriousRedRate"]) {
      expect(r0.transients, `transients has ${f}`).toHaveProperty(f);
    }

    const report = await withRealResponse(raw, () => getTrustReport("30d"));
    expect(report, "getTrustReport returns a report (not null) for a 200").toBeTruthy();
    expect(report!.monitors.length).toBe(raw.monitors.length);

    for (const rm of raw.monitors) {
      const m = report!.monitors.find((x) => x.check_id === Number(rm.checkId));
      expect(m, `monitor for check ${rm.checkId}`).toBeTruthy();
      expect(m!.check_name).toBe(rm.checkName ?? "");
      expect(m!.last_green_at).toBe(rm.lastGreenAt == null ? null : String(rm.lastGreenAt)); // ★ null-safe: never-green preserved
      expect(m!.retry_rate).toBe(rm.retryRate == null ? null : Number(rm.retryRate)); // ★ null preserved → "—"
      expect(m!.retried_passes).toBe(Number(rm.retriedPasses ?? 0));
      // nested incidents mapped (camelCase → snake_case), NOT folded
      expect(m!.incidents.real_outage).toBe(Number(rm.incidents.realOutage ?? 0));
      expect(m!.incidents.perf_regression).toBe(Number(rm.incidents.perfRegression ?? 0));
      expect(m!.incidents.unclassified).toBe(Number(rm.incidents.unclassified ?? 0));
      // the API's trust chip renders verbatim (it's a valid taxonomy value in the capture)
      expect(m!.trust).toBe(rm.trust);
    }
  });

  test("GET /reports/trust/{id}: monitor + retrySeries[] mapped by real field names (retryRate null-safe)", async () => {
    const raw = real("reports_trust_detail");
    expect(raw.monitor, "detail has a monitor").toBeTruthy();
    expect(Array.isArray(raw.retrySeries), "retrySeries is an array").toBe(true);

    const detail = await withRealResponse(raw, () => getTrustDetail(Number(raw.monitor.checkId), "30d"));
    expect(detail, "getTrustDetail returns a detail (not null)").toBeTruthy();
    expect(detail!.monitor.check_id).toBe(Number(raw.monitor.checkId));
    expect(detail!.retry_series.length).toBe(raw.retrySeries.length);

    const p0 = raw.retrySeries[0];
    if (p0) {
      for (const f of ["day", "runCount", "retryCount", "retryRate"]) expect(p0, `retry point has ${f}`).toHaveProperty(f);
      const m = detail!.retry_series[0]!;
      expect(m.day).toBe(String(p0.day ?? ""));
      expect(m.run_count).toBe(Number(p0.runCount ?? 0));
      expect(m.retry_count).toBe(Number(p0.retryCount ?? 0));
      expect(m.retry_rate).toBe(p0.retryRate == null ? null : Number(p0.retryRate)); // null → gap, never 0
    }
  });

  // ★ MUST-GO-RED: an off-taxonomy trust chip coerces to "unverified" (null-safe, never crashes the table /
  // never renders a fabricated chip). A mapper that drops the coercion passes the bogus value through → fails.
  test("teeth: an off-taxonomy trust chip coerces to 'unverified'", async () => {
    const raw = real("reports_trust");
    const poisoned = { ...raw, monitors: [{ ...raw.monitors[0], checkId: 999999, trust: "totally-bogus" }] };
    const report = await withRealResponse(poisoned, () => getTrustReport("30d"));
    const m = report!.monitors.find((x) => x.check_id === 999999);
    expect(m!.trust).toBe("unverified");
  });

  // ★ MUST-GO-RED (the #177 fake-quiet fix): an ABSENT/null flakeBudget maps to `null` — ABSENCE — never a
  // synthetic state:"ok" object. A monitor with no trust-budget data must NOT read as a healthy budget. A
  // mapper that re-adds `v ?? {}` (→ a coalesced state:"ok") passes this bogus "healthy" value through → fails.
  test("teeth: a null/absent flakeBudget maps to null (absence), never a synthetic 'ok' budget", async () => {
    const raw = real("reports_trust");
    // Sanity — the REFRESHED capture now CARRIES flakeBudget (post-B3-3), so the happy path is non-null.
    // (Pre-refresh this test read the capture's ACCIDENTAL absence as the null case — a staleness artifact,
    // not a real API state. It now tests the null path against DELIBERATE nulls below.)
    const base = await withRealResponse(raw, () => getTrustReport("30d"));
    expect(base!.monitors[0]!.flake_budget, "present flakeBudget → non-null").not.toBeNull();
    // (a) an explicit null on the wire → null.
    const withNull = { ...raw, monitors: [{ ...raw.monitors[0], checkId: 888888, flakeBudget: null }] };
    const nulled = await withRealResponse(withNull, () => getTrustReport("30d"));
    expect(nulled!.monitors.find((x) => x.check_id === 888888)!.flake_budget, "explicit null → null").toBeNull();
    // (b) the field OMITTED entirely (the API dropping it) → null, NOT a synthetic "ok". This is the exact
    //     scenario the concern names: "if the API stops sending flakeBudget tomorrow, do we notice?" — YES.
    const stripped: Record<string, unknown> = { ...raw.monitors[0], checkId: 777001 };
    delete stripped.flakeBudget;
    const omitted = await withRealResponse({ ...raw, monitors: [stripped] }, () => getTrustReport("30d"));
    expect(omitted!.monitors.find((x) => x.check_id === 777001)!.flake_budget, "omitted → null").toBeNull();
  });

  // A DEGRADED flakeBudget maps its fields by the real camelCase names — pins state/consumed/directedTask so a
  // rename drifts loudly here. (Synthetic degraded row: the live capture's monitors are all healthy state:"ok".)
  test("a degraded flakeBudget maps its fields (state/consumed/directedTask) by camelCase name", async () => {
    const raw = real("reports_trust");
    const withBudget = {
      ...raw,
      monitors: [{ ...raw.monitors[0], checkId: 777777, flakeBudget: {
        state: "degraded-as-a-monitor", target: 0.02, targetIsDefault: true, scheduledRuns: 100,
        monitorSide: 5, serviceSide: 0, indeterminate: 0, budget: 2, consumed: 5, remaining: -3,
        remainingPct: null, burnRate: 2.5, directedTask: "stabilise the selector",
      } }],
    };
    const report = await withRealResponse(withBudget, () => getTrustReport("30d"));
    const fb = report!.monitors.find((x) => x.check_id === 777777)!.flake_budget;
    expect(fb, "present budget → non-null").not.toBeNull();
    expect(fb!.state).toBe("degraded-as-a-monitor");
    expect(fb!.consumed).toBe(5);
    expect(fb!.directed_task).toBe("stabilise the selector");
  });

  // ★ PART 2 MUST-GO-RED (same fake-quiet class): an ABSENT dimensions payload maps every axis to null
  // (UNKNOWN), never "ok"; and an off-taxonomy state fail-safes to null, never "ok". A mapper that coalesces
  // to "ok" paints four fake-clean axes — the chip does NOT mitigate (it only downgrades on no-green/no-runs).
  test("teeth: absent/off-taxonomy dimension state maps to null (unknown), never 'ok'", async () => {
    const raw = real("reports_trust");
    // (a) the whole dimensions object OMITTED → every axis null.
    const stripped: Record<string, unknown> = { ...raw.monitors[0], checkId: 777002 };
    delete stripped.dimensions;
    const rep = await withRealResponse({ ...raw, monitors: [stripped] }, () => getTrustReport("30d"));
    const m = rep!.monitors.find((x) => x.check_id === 777002)!;
    expect(m.dimensions.flap, "absent flap → null").toBeNull();
    expect(m.dimensions.retry).toBeNull();
    expect(m.dimensions.monitor_noise).toBeNull();
    expect(m.dimensions.spurious_red).toBeNull();
    // (b) an off-taxonomy state fail-safes to null; a VALID sibling still passes through.
    const poisoned: Record<string, unknown> = { ...raw.monitors[0], checkId: 777003,
      dimensions: { flap: { state: "totally-bogus" }, retry: { state: "flaky" }, monitorNoise: { state: "ok" }, spuriousRed: { state: "ok" } } };
    const rep2 = await withRealResponse({ ...raw, monitors: [poisoned] }, () => getTrustReport("30d"));
    const m2 = rep2!.monitors.find((x) => x.check_id === 777003)!;
    expect(m2.dimensions.flap, "off-taxonomy → null, never 'ok'").toBeNull();
    expect(m2.dimensions.retry, "valid state still passes through").toBe("flaky");
  });
});
