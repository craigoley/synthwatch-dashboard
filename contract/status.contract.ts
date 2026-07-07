import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getStatus } from "@/lib/api-client";

/**
 * Anchor the /status board mapper (getStatus) to the REAL API response (contract/real/status.json,
 * refreshed by `pnpm capture:contracts`). /status is the flagship stakeholder board and the prior
 * false-green class — its nested shape (StatusProperty[] + StatusIncident[]) was the highest-drift-risk
 * UNANCHORED seam (recon Q3). This runs the real mapper against the captured real response and pins the
 * camelCase field names the API actually serves, so a rename/shape drift fails here on the next capture
 * instead of silently blanking the board in prod.
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

test.describe("API contract — /status board mapper vs the real response", () => {
  test("GET /status: window + nested properties[] mapped by the real camelCase field names", async () => {
    const raw = real("status");

    // Pin the real envelope: window + properties[] + recentIncidents[] (NOT a bare array).
    expect(typeof raw.window, "window is a string").toBe("string");
    expect(Array.isArray(raw.properties), "properties is an array").toBe(true);
    expect(raw.properties.length, "the capture has ≥1 property").toBeGreaterThan(0);

    // Pin the real per-property field names: the API serves checkCount/upCount/degradedCount/downCount/
    // uptimePct/buildingBaseline (camelCase). If any is renamed, the mapped value diverges → this fails.
    const rp = raw.properties[0];
    for (const f of ["name", "state", "checkCount", "upCount", "degradedCount", "downCount", "uptimePct", "buildingBaseline"]) {
      expect(rp, `property has ${f}`).toHaveProperty(f);
    }

    const page = await withRealResponse(raw, () => getStatus());
    expect(page, "getStatus returns a page (not null) for a 200").toBeTruthy();
    expect(page!.window).toBe(raw.window);
    expect(page!.properties.length).toBe(raw.properties.length);

    for (const r of raw.properties) {
      const m = page!.properties.find((x) => x.name === r.name);
      expect(m, `property "${r.name}" present after mapping`).toBeTruthy();
      // ★ the nested StatusProperty contract — snake_case domain fields ← camelCase API fields
      expect(m!.check_count).toBe(r.checkCount);
      expect(m!.up_count).toBe(r.upCount);
      expect(m!.degraded_count).toBe(r.degradedCount);
      expect(m!.down_count).toBe(r.downCount);
      expect(m!.uptime_pct).toBe(r.uptimePct == null ? null : Number(r.uptimePct));
      expect(m!.building_baseline).toBe(Boolean(r.buildingBaseline));
      // state stays within the taxonomy (or coerces to "unknown")
      expect(["up", "degraded", "down", "unknown"]).toContain(m!.state);
    }
  });

  test("GET /status: nested recentIncidents[] mapped by the real field names (openedAt/resolvedAt)", async () => {
    const raw = real("status");
    expect(Array.isArray(raw.recentIncidents), "recentIncidents is an array").toBe(true);

    const page = await withRealResponse(raw, () => getStatus());
    expect(page!.recent_incidents.length).toBe(raw.recentIncidents.length);

    const ri = raw.recentIncidents[0];
    if (ri) {
      // Pin the real incident field names: property/title/openedAt/resolvedAt/status/severity.
      for (const f of ["property", "title", "openedAt", "status", "severity"]) {
        expect(ri, `incident has ${f}`).toHaveProperty(f);
      }
      const m = page!.recent_incidents[0]!;
      expect(m.property).toBe(ri.property);
      expect(m.title).toBe(ri.title);
      expect(m.opened_at).toBe(String(ri.openedAt)); // ★ openedAt → opened_at
      expect(m.resolved_at).toBe(ri.resolvedAt ? String(ri.resolvedAt) : null);
      expect(m.status).toBe(String(ri.status));
      expect(m.severity).toBe(String(ri.severity));
    }
  });

  // ★ MUST-GO-RED: an off-taxonomy property `state` must coerce to "unknown" (never leak through as a
  // fabricated healthy value). A mapper that drops the coercion passes the bogus state through → fails here.
  test("teeth: an off-taxonomy property state coerces to 'unknown'", async () => {
    const raw = real("status");
    const poisoned = { ...raw, properties: [{ ...raw.properties[0], name: "poison", state: "totally-bogus" }] };
    const page = await withRealResponse(poisoned, () => getStatus());
    const p = page!.properties.find((x) => x.name === "poison");
    expect(p!.state).toBe("unknown");
  });
});
