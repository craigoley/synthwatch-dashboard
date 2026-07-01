import { test, expect } from "@playwright/test";

import { getSloReport } from "@/lib/api-client";

/**
 * Fleet SLO report seam (GET /reports/slo, P5 v1). Anchored AS BUILT — the endpoint is a companion API PR, so
 * this BODY is the contract that PR must satisfy (per-check items + a fleet rollup, camelCase, mirroring /sla).
 * Swap for a live capture once the endpoint ships. Pins: the request shape (?window=&tag=), the map-ALL-rows
 * behaviour, camel→snake, and — critically — that null remaining_pct/burn_rate survive (insufficient_data must
 * never become a fake 0%), plus a 404 → null graceful hide.
 */
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

test.describe("API contract — fleet SLO report (/reports/slo)", () => {
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
