import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  listChecks,
  getSla,
  getIncidents,
  getAvailabilityReport,
  getReconcileDrift,
  getSpecCatalog,
} from "@/lib/api-client";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Contract checks — anchor the CLIENT to the REAL API, not to a hand-written copy.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The systemic bug: the e2e mock serves the shape the CLIENT expects, so mock + client agree and tests
 * pass — but the client's expected shape differs from what the API actually SERVES, so it breaks in prod.
 * Root cause: mock and client are two copies of an ASSUMPTION; nothing checks either against reality.
 *
 * These tests run the REAL api-client mapper functions against CAPTURED REAL API responses
 * (contract/real/*.json, refreshed by `pnpm capture:contracts`). Each assertion compares the mapped
 * domain object to the raw capture's ACTUAL field names — so if the client reads a field the API doesn't
 * serve (incidentCount vs incidentsOpened), or assumes a bare array where the API sends an envelope, the
 * mapped output diverges from the real data and the test FAILS. No hand-declared "shared type" (that
 * would only keep mock + client in sync with each other); the anchor is the captured real response.
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

test.describe("API contract — real-response shape vs client mappers", () => {
  test("GET /checks is a BARE ARRAY; client maps open_incident_count + p95 by the real field names", async () => {
    const raw = real("checks");
    expect(Array.isArray(raw), "/checks must be a bare array, not an envelope").toBe(true);

    const mapped = await withRealResponse(raw, () => listChecks());
    expect(mapped.length).toBe(raw.length);
    for (const r of raw) {
      const m = mapped.find((x) => x.id === r.id);
      expect(m, `check ${r.id} present after mapping`).toBeTruthy();
      // field-name contracts: the API serves openIncidentCount / p95Ms / currentStatus.
      expect(m!.open_incident_count).toBe(r.openIncidentCount);
      expect(m!.p95_ms).toBe(r.p95Ms);
      expect(m!.current_status).toBe(r.currentStatus);
    }
  });

  test("GET /incidents is a CURSOR ENVELOPE ({items,nextCursor}); client reads .items, not the top level", async () => {
    const raw = real("incidents_open");
    expect(Array.isArray(raw), "/incidents must NOT be a bare array").toBe(false);
    expect(Array.isArray(raw.items), "the incidents array lives under .items").toBe(true);

    const page = await withRealResponse(raw, () => getIncidents({ status: "open" }));
    expect(page.incidents.length).toBe(raw.items.length);
    expect(page.next_cursor).toBe(raw.nextCursor);
    const firstRaw = raw.items[0];
    const firstMapped = page.incidents[0];
    if (firstRaw && firstMapped) {
      expect(firstMapped.id).toBe(firstRaw.id);
      expect(firstMapped.check_id).toBe(firstRaw.checkId);
    }
  });

  test("GET /sla — client maps up_runs/down_runs from the real upRuns/downRuns", async () => {
    const raw = real("sla_7d");
    expect(Array.isArray(raw.items)).toBe(true);

    const resp = await withRealResponse(raw, () => getSla("7d"));
    for (const r of raw.items) {
      const m = resp.items.find((x) => x.check_id === r.checkId);
      expect(m, `sla row for check ${r.checkId}`).toBeTruthy();
      expect(m!.up_runs).toBe(r.upRuns);
      expect(m!.down_runs).toBe(r.downRuns);
    }
  });

  test("★ GET /reports/availability — incident_count is read from incidentsOpened (the incidents-sort bug)", async () => {
    const raw = real("reports_availability_7d");
    const rawChecks = raw.groups[0].checks;

    // Pin the real field name to the LIVE capture: the API serves `incidentsOpened`, and there is NO
    // `incidentCount`. If the API ever renames it, this fails on the next `pnpm capture:contracts`.
    for (const c of rawChecks) {
      expect(typeof c.incidentsOpened, `check ${c.checkId} has incidentsOpened`).toBe("number");
      expect(c, `check ${c.checkId} must NOT have an incidentCount field`).not.toHaveProperty("incidentCount");
    }

    const report = await withRealResponse(raw, () => getAvailabilityReport("7d", "none"));
    const group = report?.groups[0];
    expect(group, "availability report has a group").toBeTruthy();
    const mapped = group!.checks;
    // The client's incident_count MUST equal the real incidentsOpened. Reading the wrong field
    // (incidentCount) made every value 0 → the reports "Incidents" sort had a constant key → no-op.
    for (const rc of rawChecks) {
      const m = mapped.find((x) => x.check_id === rc.checkId);
      expect(m, `mapped check ${rc.checkId}`).toBeTruthy();
      expect(m!.incident_count).toBe(rc.incidentsOpened);
    }
  });

  test("★ GET /reports/availability — series uses `day`+`availabilityPct` (not `date`+`value`); no `kind` on checks; check_count fallback", async () => {
    const raw = real("reports_availability_7d");
    const g = raw.groups[0];

    // Pin the real series shape: `day` (NOT `date`), `availabilityPct` (NOT `value`).
    expect(g.series.length).toBeGreaterThan(0);
    expect(g.series[0]).toHaveProperty("day");
    expect(g.series[0]).not.toHaveProperty("date");
    expect(g.series[0]).toHaveProperty("availabilityPct");
    expect(g.series[0]).not.toHaveProperty("value");

    // Pin: per-check rows have NO `kind` field.
    expect(g.checks[0]).not.toHaveProperty("kind");

    // Pin: group has NO `checkCount` — the API sends `totalCount` (run count).
    expect(g).not.toHaveProperty("checkCount");
    expect(g).toHaveProperty("totalCount");

    const report = await withRealResponse(raw, () => getAvailabilityReport("7d", "none"));
    const group = report!.groups[0]!;

    // ★ Series: mapper must read `day` → `date`, `availabilityPct` → `value`.
    expect(group.series.length).toBe(g.series.length);
    expect(group.series[0]!.date).toBe(g.series[0].day);
    expect(group.series[0]!.value).toBe(g.series[0].availabilityPct);

    // ★ check_count falls back to checks.length (no checkCount in capture).
    expect(group.check_count).toBe(g.checks.length);
  });

  test("GET /reconcile/drift + /specs are envelopes ({items,…}); client reads .items", async () => {
    const drift = real("reconcile_drift");
    const driftRes = await withRealResponse(drift, () => getReconcileDrift());
    expect(driftRes!.items.length).toBe(drift.items.length);

    const specs = real("specs");
    const specsRes = await withRealResponse(specs, () => getSpecCatalog());
    expect(specsRes!.items.length).toBe(specs.items.length);
  });

  // ★ TEETH: prove the contract above actually catches the bug class. Against the REAL capture, the OLD
  // wrong-field mapping (incidentCount) collapses to a constant 0 (the sort no-op), while the correct
  // field (incidentsOpened) varies. So the `incident_count === incidentsOpened` assertion above is a real
  // tripwire, not a tautology — a client that reverts to `incidentCount` fails it.
  test("teeth: against the real shape, the wrong field is all-zero and the right field varies", () => {
    const rawChecks = real("reports_availability_7d").groups[0].checks;
    const fromWrongField = rawChecks.map((c: Record<string, unknown>) => (c.incidentCount as number) ?? 0);
    const fromRightField = rawChecks.map((c: Record<string, unknown>) => c.incidentsOpened as number);
    expect(fromWrongField.every((n: number) => n === 0)).toBe(true); // wrong field → constant → sort no-op
    expect(new Set(fromRightField).size).toBeGreaterThan(1); // right field → varies → sort works
  });
});
