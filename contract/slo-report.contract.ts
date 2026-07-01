import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getSloReport } from "@/lib/api-client";

/**
 * Fleet SLO report seam (GET /reports/slo, P5 v1). Now LIVE — anchored against a real capture
 * (contract/real/reports_slo_30d.json, refreshed by `pnpm capture:contracts`), so the mapper can't silently
 * assume a shape the API doesn't serve. The endpoint is live but the fleet is currently EMPTY (items: []), so:
 *   • the capture-anchored block pins the REAL envelope + fleet field-names (camel→snake) against reality, and
 *   • the synthetic-row block below exercises the row/null/burn-state LOGIC branches the empty fleet can't.
 * The capture also surfaced that the live fleet carries totalRuns/downRuns the mapper doesn't read — a
 * harmless SUPERSET (the mapper reads only fields the API provides), NOT a divergence; documented in the
 * anchored test.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const real = (name: string): any => JSON.parse(readFileSync(join(__dirname, "real", `${name}.json`), "utf8"));
async function withResponse<T>(body: unknown, status: number, fn: () => Promise<T>): Promise<{ result: T; url: string }> {
  const orig = globalThis.fetch;
  let url = "";
  globalThis.fetch = (async (u: string | URL) => {
    url = String(u);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await fn();
    return { result, url };
  } finally {
    globalThis.fetch = orig;
  }
}

// Synthetic rows — a LOGIC fixture, not a shape claim (the shape is anchored by the live capture below). These
// exercise the row/null/burn-state mapping branches the currently-empty live fleet can't populate.
const BODY = {
  window: "30d",
  items: [
    { checkId: 1, checkName: "API health", kind: "http", target: 0.99, budget: 100, consumed: 90, remaining: 10, remainingPct: 0.1, burnRate: 1.4, burnState: "fast", reportedBurn: 20, completedRuns: 500, insufficientData: false },
    // ★ item WITHOUT burnState/reportedBurn (older API / thin row) → the mapper must null-safe default to none/0.
    { checkId: 3, checkName: "TLS cert", kind: "ssl", target: 0.999, budget: 50, consumed: 0, remaining: 50, remainingPct: null, burnRate: null, completedRuns: 3, insufficientData: true },
  ],
  fleet: { budget: 150, consumed: 90, remaining: 60, remainingPct: 0.4, insufficientData: false },
};
const TAGS = [
  { key: "env", value: "prod" },
  { key: "team", value: "web" },
];

test.describe("API contract — fleet SLO report (/reports/slo) — row/null LOGIC (synthetic rows)", () => {
  test("★ getSloReport sends ?window= + repeated ?tag= (AND); omits tag when empty", async () => {
    const { url } = await withResponse(BODY, 200, () => getSloReport("30d", TAGS));
    const p = new URL(url, "http://local").searchParams;
    expect(p.get("window")).toBe("30d");
    expect(p.getAll("tag")).toEqual(["env:prod", "team:web"]);

    const { url: none } = await withResponse(BODY, 200, () => getSloReport("30d", []));
    expect(new URL(none, "http://local").searchParams.has("tag")).toBe(false);
  });

  test("★ maps ALL rows camel→snake; null remaining_pct/burn_rate survive; fleet mapped", async () => {
    const { result } = await withResponse(BODY, 200, () => getSloReport("30d", []));
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.items.length).toBe(2); // map-ALL, not groups[0]
    expect(r.items[0]!.check_id).toBe(1);
    expect(r.items[0]!.remaining_pct).toBe(0.1);
    expect(r.items[0]!.burn_rate).toBe(1.4);
    // ★ insufficient row: null preserved (never coerced to 0 → no fake %/burn)
    expect(r.items[1]!.insufficient_data).toBe(true);
    expect(r.items[1]!.remaining_pct).toBeNull();
    expect(r.items[1]!.burn_rate).toBeNull();
    expect(r.fleet!.remaining_pct).toBe(0.4);
    expect(r.fleet!.consumed).toBe(90);
    // ★ P5 PR2 — the location-aware burn STATE maps through; a row missing the fields null-safe-defaults.
    expect(r.items[0]!.burn_state).toBe("fast");
    expect(r.items[0]!.reported_burn).toBe(20);
    expect(r.items[1]!.burn_state).toBe("none"); // absent burnState → 'none', never undefined/crash
    expect(r.items[1]!.reported_burn).toBe(0);
  });

  test("★ 404 (endpoint not deployed yet) → null, never throws — the section hides gracefully", async () => {
    const { result } = await withResponse({ error: "not_found" }, 404, () => getSloReport("30d", []));
    expect(result).toBeNull();
  });

  test("absent fleet → null", async () => {
    const { result } = await withResponse({ window: "30d", items: [], fleet: null }, 200, () => getSloReport("30d", []));
    expect(result!.fleet).toBeNull();
  });
});

test.describe("API contract — fleet SLO report (/reports/slo) — LIVE capture anchor", () => {
  test("★ maps the REAL /reports/slo shape; fleet camel→snake anchored to reality; extra fields tolerated", async () => {
    const raw = real("reports_slo_30d");
    // Envelope contract against the live shape (not a hand-copy): window + items array + a fleet object.
    expect(raw.window).toBeTruthy();
    expect(Array.isArray(raw.items), "/reports/slo items is an array").toBe(true);
    expect(raw.fleet, "live fleet is present (even when empty)").toBeTruthy();
    // ★ SUPERSET, not a divergence: the live fleet carries totalRuns/downRuns the mapper deliberately ignores.
    // This documents that the API returns MORE than the client reads — harmless; NOT the "client assumes a
    // field the API omits" anti-pattern (which would fail below).
    expect(raw.fleet).toHaveProperty("totalRuns");
    expect(raw.fleet).toHaveProperty("downRuns");

    const { result } = await withResponse(raw, 200, () => getSloReport("30d", []));
    expect(result).not.toBeNull();
    const r = result!;
    // items maps 1:1 with the real payload (currently empty — the live fleet has no SLO rows yet).
    expect(r.items.length).toBe(raw.items.length);
    // fleet field-name contract anchored to the REAL camelCase keys → the mapper's snake_case output.
    expect(r.fleet!.budget).toBe(raw.fleet.budget);
    expect(r.fleet!.consumed).toBe(raw.fleet.consumed);
    expect(r.fleet!.remaining).toBe(raw.fleet.remaining);
    expect(r.fleet!.remaining_pct).toBe(raw.fleet.remainingPct); // null preserved (never a fake 0%)
    expect(r.fleet!.insufficient_data).toBe(raw.fleet.insufficientData);
  });
});
