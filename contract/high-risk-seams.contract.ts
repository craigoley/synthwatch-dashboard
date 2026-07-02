import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  getMetrics,
  getIncident,
  getSpecCatalog,
  getAvailabilitySeries,
  listFlows,
} from "@/lib/api-client";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Contract anchors — the 5 HIGHEST-drift-risk unanchored read seams (overnight analysis).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Each runs the REAL mapper against a REAL captured response (contract/real/*.json, captured live on
 * 2026-06-30) — NOT a hand-written mock that could agree with a buggy mapper (the F-01 lesson). A server
 * field rename, an envelope↔bare-array flip, or a broken nested mapping now FAILS here instead of silently
 * nulling/emptying the UI. Client-side complement to the API list-envelope tests (#123).
 */

const REAL = join(__dirname, "real");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const real = (name: string): any => JSON.parse(readFileSync(join(REAL, `${name}.json`), "utf8"));

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

test.describe("API contract — high-risk seam anchors", () => {
  // 1 ── getMetrics (mapMetric) — the scariest: 17-field camel→snake + TWO FABRICATED fields.
  test("★ getMetrics — camel→snake web-vitals AND the 2 fabricated fields are DERIVED, not read", async () => {
    const raw = real("metrics_check80");
    const r0 = raw.items[0];
    // Pin the real shape: envelope `.items`, and the API does NOT send started_at / status (they're fabricated).
    expect(Array.isArray(raw.items)).toBe(true);
    expect(r0).not.toHaveProperty("startedAt");
    expect(r0).not.toHaveProperty("status");
    expect(r0).toHaveProperty("capturedAt");
    expect(r0).toHaveProperty("lcpMs");

    const res = await withRealResponse(raw, () => getMetrics(80));
    expect(res.length).toBe(raw.items.length); // envelope unwrapped
    const m = res[0]!;
    // camel→snake renames (a rename of any of these silently nulls a metrics chart):
    expect(m.run_id).toBe(r0.runId);
    expect(m.captured_at).toBe(r0.capturedAt);
    expect(m.ttfb_ms).toBe(r0.ttfbMs);
    expect(m.lcp_ms).toBe(r0.lcpMs);
    expect(m.cls).toBe(r0.cls);
    expect(m.inp_ms).toBe(r0.inpMs);
    expect(m.transfer_bytes).toBe(r0.transferBytes);
    expect(m.recalc_style_count).toBe(r0.recalcStyleCount);
    // ★ fabricated: started_at is DERIVED from capturedAt; status is HARDCODED "pass".
    expect(m.started_at).toBe(r0.capturedAt);
    expect(m.status).toBe("pass");
  });

  test("★ getMetrics — started_at/status IGNORE any API-sent values (derived, not read)", async () => {
    // If the API ever STARTS sending startedAt/status, the mapper currently IGNORES them (it derives/hardcodes).
    // This pins that intentional behavior + documents the assumption: a future dev who wants to read them must
    // change the mapper here, not assume it already does.
    const raw = real("metrics_check80");
    const injected = {
      ...raw,
      items: [{ ...raw.items[0], startedAt: "2020-01-01T00:00:00Z", status: "fail" }, ...raw.items.slice(1)],
    };
    const res = await withRealResponse(injected, () => getMetrics(80));
    expect(res[0]!.started_at).toBe(raw.items[0].capturedAt); // NOT the injected startedAt
    expect(res[0]!.started_at).not.toBe("2020-01-01T00:00:00Z");
    expect(res[0]!.status).toBe("pass"); // NOT the injected "fail"
  });

  // 2 ── getIncident (singular DETAIL) — richest unanchored read: nested timeline[] + recurrence[].
  test("★ getIncident (detail) — incident + nested timeline[] + recurrence[] camel→snake", async () => {
    const raw = real("incident_detail_34");
    const rt = raw.timeline[0];
    const res = await withRealResponse(raw, () => getIncident(34));

    expect(res.check_name).toBe(raw.checkName);
    expect(res.check_kind).toBe(raw.checkKind);
    expect(res.opened_at).toBe(raw.openedAt);
    expect(res.consecutive_failures).toBe(raw.consecutiveFailures);
    expect(res.per_location).toEqual(raw.perLocation ?? []);

    // ★ nested timeline[] (10 renamed fields) — the multi-field nested DTO drift bugs target:
    expect(res.timeline.length).toBe(raw.timeline.length);
    const t = res.timeline[0]!;
    expect(t.run_id).toBe(rt.runId);
    expect(t.started_at).toBe(rt.startedAt);
    expect(t.duration_ms).toBe(rt.durationMs);
    expect(t.http_status).toBe(rt.httpStatus);
    expect(t.error_message).toBe(rt.errorMessage);
    expect(t.failed_step).toBe(rt.failedStep);
    expect(t.screenshot_url).toBe(rt.screenshotUrl);
    expect(t.trace_url).toBe(rt.traceUrl);

    // ★ nested recurrence[]:
    expect(res.recurrence.length).toBe(raw.recurrence.length);
    if (raw.recurrence.length > 0) {
      expect(res.recurrence[0]!.opened_at).toBe(raw.recurrence[0].openedAt);
      expect(res.recurrence[0]!.resolved_at).toBe(raw.recurrence[0].resolvedAt);
    }

    // ★ nearby_deploys[] (deploy-proximity, api #157) — forward-compatible: the field is optional and this
    // captured fixture predates deploy capture, so it maps to []. Re-capture after #157 deploys picks up the
    // real (empty-for-incident-34) array; the mapper stays tolerant of the field being absent.
    expect(Array.isArray(res.nearby_deploys)).toBe(true);
    expect(res.nearby_deploys).toEqual(
      (raw.nearbyDeploys ?? []).map((d: Record<string, unknown>) => ({
        detected_at: d.detectedAt,
        source: d.source,
        is_sha: d.isSha,
        sha: d.sha ?? "",
        fingerprint: d.fingerprint,
        offset_minutes: d.offsetMinutes,
      })),
    );
  });

  // 3 ── getSpecCatalog — the per-item + nested HEALTH mapping (previously length-anchored only).
  test("★ getSpecCatalog — per-item rename + nested health (the openIncidentCount F-01 family)", async () => {
    const raw = real("specs");
    const idx = raw.items.findIndex((s: { health?: unknown }) => s.health);
    expect(idx, "fixture has an item with a health block").toBeGreaterThanOrEqual(0);
    const ri = raw.items[idx];

    const res = await withRealResponse(raw, () => getSpecCatalog());
    expect(res!.items.length).toBe(raw.items.length);
    const item = res!.items[idx]!;
    // per-item renames (length-only anchoring missed these):
    expect(item.source_key).toBe(ri.sourceKey);
    expect(item.spec_path).toBe(ri.specPath);
    expect(item.suggested_interval_seconds).toBe(ri.suggestedIntervalSeconds ?? null);
    // ★ nested health — currentStatus/p95Ms/openIncidentCount/lastRunAt. openIncidentCount is the exact
    //   field family that caused the F-01 availability drift; pin it.
    expect(item.health).not.toBeNull();
    expect(item.health!.current_status).toBe(ri.health.currentStatus);
    expect(item.health!.p95_ms).toBe(ri.health.p95Ms ?? null);
    expect(item.health!.open_incident_count).toBe(ri.health.openIncidentCount ?? 0);
    expect(item.health!.last_run_at).toBe(ri.health.lastRunAt ?? null);
  });

  // 4 ── getAvailabilitySeries — nested points[] (the upRuns/downRuns family that drifted in /sla).
  test("★ getAvailabilitySeries — points[] availabilityPct/upRuns/downRuns → snake", async () => {
    const raw = real("availability_series_check80");
    expect(raw.points[0]).toHaveProperty("availabilityPct");
    expect(raw.points[0]).toHaveProperty("upRuns");

    const res = await withRealResponse(raw, () => getAvailabilitySeries(80, "7d"));
    expect(res.points.length).toBe(raw.points.length);
    const p = res.points[0]!;
    const rp = raw.points[0];
    expect(p.ts).toBe(rp.ts);
    expect(p.availability_pct).toBe(rp.availabilityPct ?? null);
    expect(p.up_runs).toBe(rp.upRuns);
    expect(p.down_runs).toBe(rp.downRuns);
  });

  // 5 ── listFlows — must stay BARE ARRAY (agrees with the #123 API-side pin; a future wrap breaks BOTH).
  test("★ listFlows — bare array (NOT an envelope) + entryUrlHint/updatedAt → snake", async () => {
    const raw = real("flows");
    // ★ Pin: /flows is a BARE ARRAY. If it ever becomes { items: [...] }, this fails (and so does #123's
    //   API-side bare-array test) — the two break together, loudly, on purpose.
    expect(Array.isArray(raw)).toBe(true);
    expect(raw.length).toBeGreaterThan(0);

    const res = await withRealResponse(raw, () => listFlows());
    expect(res.length).toBe(raw.length);
    const f = res[0]!;
    expect(f.name).toBe(raw[0].name);
    expect(f.entry_url_hint).toBe(raw[0].entryUrlHint ?? null);
    expect(f.updated_at).toBe(raw[0].updatedAt);
    expect(f.description).toBe(raw[0].description ?? null);
  });
});
