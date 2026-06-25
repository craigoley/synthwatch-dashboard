/**
 * Hermetic API mock. The app is built with NEXT_PUBLIC_API_BASE_URL pointing at
 * API_BASE below, so EVERY api-client fetch (and every artifact <img>/download,
 * which apiUrl() resolves against the same origin) is a request to API_ORIGIN.
 * page.route intercepts the whole host and serves fixtures — no real network,
 * fully deterministic, per-PR.
 */
import type { Page, Route } from "@playwright/test";
import {
  availabilitySeries,
  defaultChecks,
  defaultDetails,
  defaultIncidents,
  defaultIncidentDetails,
  defaultSteps,
  emptySla,
  type RawObj,
} from "./fixtures";

// MUST match playwright.config's webServer NEXT_PUBLIC_API_BASE_URL.
export const API_ORIGIN = "https://mock.synthwatch.test";
export const API_BASE = `${API_ORIGIN}/api`;

// 1×1 transparent PNG — a real, decodable image so <img> fires `load`, not `error`.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

export interface World {
  checks: RawObj[];
  details: Record<number, RawObj>;
  steps: Record<number, RawObj[]>;
  sla: RawObj;
  /** Per-window SLA responses (window → response); falls back to `sla` when absent. */
  slaByWindow?: Record<string, RawObj>;
  incidents: RawObj[];
  incidentDetails: Record<number, RawObj>;
  /** Availability-over-time series (any window); null = chart shows empty state. */
  availability: RawObj | null;
  flows: RawObj[];
  /** Make the screenshot proxy return 404 (blob expired/retention). */
  screenshot404?: boolean;
  /** Override the POST /checks response (e.g. a validation 400). */
  createResponse?: { status: number; body: unknown };
  /** Make every GET fail (API-down → error-state test). */
  failAllReads?: boolean;
  /** Available run locations (selector options); undefined → endpoint 404s. */
  locations?: { name: string; enabled: boolean }[];
  /** Per-check location assignment (GET /checks/{id}/locations). */
  checkLocations?: Record<number, string[]>;
  /** Alerting channels (stateful across CRUD); undefined → endpoint 404s. */
  channels?: RawObj[];
  /** Alerting routing ({ severity, perCheck }); undefined → endpoint 404s. */
  routing?: RawObj;
  /** Force PUT /routing to fail (proves the save-FAILURE feedback path). */
  routingPutError?: { status: number; body: unknown };
  /**
   * Async test-send (runs on the runner). The POST enqueues and returns 202
   * { requestId }; the dashboard then polls GET .../test/status. Drive the
   * outcome per channel with `channelTest`:
   *   undefined          → POST 404 (endpoint not deployed)
   *   enqueueError       → POST returns this status/body instead of 202 (network/5xx path)
   *   statusSequence     → the status objects returned on successive polls; the LAST
   *                        one repeats. Default: one immediate `delivered`.
   * The mock assigns requestIds and tracks each request's poll cursor statefully.
   */
  channelTest?: {
    enqueueError?: { status: number; body?: unknown };
    statusSequence?: {
      status: "pending" | "sending" | "delivered" | "failed";
      detail?: string | null;
    }[];
  };
  /** GET /notifications/health response; undefined → 404 (readiness unknown). */
  notificationsHealth?: RawObj;
  /** Suggested tag keys; undefined → /tags/suggested 404s (editor hidden). */
  suggestedKeys?: string[];
  /** Per-check tag sets (stateful across PUT). */
  checkTags?: Record<number, RawObj[]>;
  /** Distinct in-use tags (GET /tags, for the 9b filter bar). */
  tags?: RawObj[];
  /** Reports served? false → /reports/* 404 (pre-API "reports pending"). Default true. */
  reportsServed?: boolean;
  /** Per-check run metrics (CWV) for the report drill-down web-vitals (raw camelCase). */
  metrics?: RawObj[];
  /** AI narratives (Layer 3). Unset → /reports/narrative 404 → card hides (graceful). */
  narratives?: { fleet?: RawObj; monitor?: Record<string, RawObj> };
  /**
   * Monitors-as-code drift (Phase 6b). Unset → /api/reconcile/drift 404 → the surface hides.
   * Set to { items: [] } for the "in sync" empty state, or with rows to list drift.
   */
  reconcileDrift?: { items: RawObj[]; detectedAt?: string | null };
  /**
   * Spec catalog (Phase 13). Unset → /api/specs 404 → the catalog page shows a neutral "not
   * available" notice. Set to { items: [] } for the "no specs yet" empty state, or with rows.
   */
  specCatalog?: { items: RawObj[]; probedAt?: string | null };
}

export function defaultWorld(): World {
  return {
    checks: defaultChecks(),
    details: defaultDetails(),
    steps: defaultSteps(),
    sla: emptySla(),
    incidents: defaultIncidents(),
    incidentDetails: defaultIncidentDetails(),
    availability: availabilitySeries(),
    flows: [],
    locations: [
      { name: "eastus2", enabled: true },
      { name: "centralus", enabled: true },
      { name: "westeurope", enabled: true },
      { name: "decommissioned", enabled: false }, // disabled → must NOT appear in the selector
    ],
    checkLocations: {},
    channels: [],
    routing: { severity: {}, perCheck: {} },
    suggestedKeys: ["env", "service", "team", "criticality"],
    checkTags: {},
    tags: [],
  };
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** Install the mock on a page. Pass a tweaked World for per-test variants. */
export async function mockApi(page: Page, world: World = defaultWorld()): Promise<void> {
  // Stateful test-send requests: requestId → { channelId, poll cursor }. The POST
  // enqueues (202) and the GET status walks the configured statusSequence.
  const testRequests = new Map<number, { channelId: number; polls: number }>();
  let nextRequestId = 1000;

  await page.route(`${API_ORIGIN}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    let m: RegExpMatchArray | null;

    if (method === "OPTIONS") return route.fulfill({ status: 204 });

    // Writes first (don't get caught by failAllReads).
    if (path === "/api/checks" && method === "POST") {
      if (world.createResponse) return json(route, world.createResponse.body, world.createResponse.status);
      const body = JSON.parse(req.postData() || "{}");
      // Activation: a create carrying sourceKey flips its catalog row Unmonitored→Active (stateful), so
      // a re-read of /api/specs after the activation shows the row now monitored — proving the loop.
      if (body.sourceKey && world.specCatalog) {
        world.specCatalog.items = world.specCatalog.items.map((it) =>
          it.sourceKey === body.sourceKey
            ? {
                ...it,
                monitored: true,
                checkId: 999,
                checkName: body.name,
                enabled: body.enabled !== false,
                health: { currentStatus: "running", p95Ms: null, openIncidentCount: 0, lastRunAt: null },
              }
            : it,
        );
      }
      return json(route, { ...body, id: 999 });
    }
    if (/^\/api\/checks\/\d+$/.test(path) && method === "PATCH") {
      return json(route, { id: Number(path.split("/").pop()) });
    }
    if (/^\/api\/checks\/\d+$/.test(path) && method === "DELETE") {
      return route.fulfill({ status: 204 });
    }
    // PUT a check's tag set (stateful) — body { tags:[…] }.
    if ((m = path.match(/^\/api\/checks\/(\d+)\/tags$/)) && method === "PUT") {
      const id = Number(m[1]);
      const body = JSON.parse(req.postData() || "{}");
      const tags = Array.isArray(body.tags) ? (body.tags as RawObj[]) : [];
      world.checkTags = { ...(world.checkTags ?? {}), [id]: tags };
      return json(route, tags);
    }
    // PUT location assignment — mirrors the API's ≥1-location rule (empty → 400).
    if ((m = path.match(/^\/api\/checks\/(\d+)\/locations$/)) && method === "PUT") {
      const body = JSON.parse(req.postData() || "{}");
      const locs = Array.isArray(body.locations) ? (body.locations as string[]) : [];
      if (locs.length === 0) {
        return json(route, { error: "validation_error", message: "At least one location is required." }, 400);
      }
      return json(route, { locations: locs });
    }
    // Channels CRUD — stateful so create/delete reflect on the next GET.
    if (path === "/api/channels" && method === "POST") {
      const body = JSON.parse(req.postData() || "{}") as RawObj;
      const id = (world.channels ?? []).reduce((mx, c) => Math.max(mx, Number(c.id) || 0), 0) + 1;
      const created = { ...body, id };
      world.channels = [...(world.channels ?? []), created];
      return json(route, created);
    }
    if ((m = path.match(/^\/api\/channels\/(\d+)$/)) && method === "PUT") {
      const id = Number(m[1]);
      const body = JSON.parse(req.postData() || "{}") as RawObj;
      world.channels = (world.channels ?? []).map((c) => (Number(c.id) === id ? { ...body, id } : c));
      return json(route, { ...body, id });
    }
    if ((m = path.match(/^\/api\/channels\/(\d+)$/)) && method === "DELETE") {
      const id = Number(m[1]);
      // Mirror the API's 409 delete-guard: refuse if routing references the channel.
      const r = (world.routing ?? {}) as { severity?: Record<string, RawObj>; perCheck?: Record<string, RawObj> };
      const refs = (rule: RawObj | undefined) => ((rule?.channelIds as number[]) ?? []).includes(id);
      const referenced =
        Object.values(r.severity ?? {}).some(refs) || Object.values(r.perCheck ?? {}).some(refs);
      if (referenced) {
        return json(
          route,
          { error: "conflict", message: `channel ${id} is referenced by routing rule(s); remove it from routing before deleting.` },
          409,
        );
      }
      world.channels = (world.channels ?? []).filter((c) => Number(c.id) !== id);
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/routing" && method === "PUT") {
      if (world.routingPutError) return json(route, world.routingPutError.body, world.routingPutError.status);
      world.routing = JSON.parse(req.postData() || "{}") as RawObj;
      return json(route, world.routing);
    }
    // Async test-send: POST enqueues (202 { requestId }); undefined → 404 (not deployed).
    if ((m = path.match(/^\/api\/channels\/(\d+)\/test$/)) && method === "POST") {
      if (!world.channelTest) return json(route, { error: "not_found" }, 404);
      if (world.channelTest.enqueueError) {
        return json(route, world.channelTest.enqueueError.body ?? { error: "enqueue_failed" }, world.channelTest.enqueueError.status);
      }
      const requestId = (nextRequestId += 1);
      testRequests.set(requestId, { channelId: Number(m[1]), polls: 0 });
      return json(route, { requestId }, 202);
    }
    // Poll the queued test send. Walks statusSequence (last entry repeats); the
    // default is an immediate `delivered`. Unknown requestId → 404.
    if ((m = path.match(/^\/api\/channels\/(\d+)\/test\/status$/)) && method === "GET") {
      const requestId = Number(url.searchParams.get("requestId"));
      const reqState = testRequests.get(requestId);
      if (!reqState) return json(route, { error: "not_found", message: "unknown requestId" }, 404);
      const seq = world.channelTest?.statusSequence ?? [{ status: "delivered" as const, detail: "sent via email" }];
      const step = seq[Math.min(reqState.polls, seq.length - 1)] ?? seq[seq.length - 1]!;
      reqState.polls += 1;
      const terminal = step.status === "delivered" || step.status === "failed";
      return json(route, {
        status: step.status,
        detail: step.detail ?? null,
        requestedAt: new Date(Date.now() - reqState.polls * 2000).toISOString(),
        completedAt: terminal ? new Date().toISOString() : null,
      });
    }

    if (world.failAllReads) return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"down"}' });

    if (path === "/api/checks" && method === "GET") return json(route, world.checks);
    // Monitors-as-code drift (Phase 6b). Unset → 404 (endpoint not deployed → surface hides);
    // { items: [] } → "in sync"; items present → drift listed. detectedAt defaults to a fixed time.
    if (path === "/api/reconcile/drift" && method === "GET") {
      if (!world.reconcileDrift) return json(route, { error: "not_found" }, 404);
      const { items } = world.reconcileDrift;
      const detectedAt =
        world.reconcileDrift.detectedAt ?? (items.length ? "2026-06-25T12:00:00Z" : null);
      return json(route, { items, detectedAt });
    }
    // Spec catalog (Phase 13). Unset → 404 (endpoint not deployed → "not available" notice);
    // { items: [] } → "no specs yet"; items present → catalog listed. probedAt defaults to a fixed time.
    if (path === "/api/specs" && method === "GET") {
      if (!world.specCatalog) return json(route, { error: "not_found" }, 404);
      const { items } = world.specCatalog;
      const probedAt = world.specCatalog.probedAt ?? (items.length ? "2026-06-25T12:00:00Z" : null);
      return json(route, { items, probedAt });
    }
    // Locations: available options + a check's current assignment (undefined → 404).
    if (path === "/api/locations" && method === "GET") {
      return world.locations ? json(route, { locations: world.locations }) : json(route, { error: "not_found" }, 404);
    }
    if ((m = path.match(/^\/api\/checks\/(\d+)\/locations$/)) && method === "GET") {
      return json(route, { locations: world.checkLocations?.[Number(m[1])] ?? [] });
    }
    // Tags (Phase 9a): suggested keys (undefined → 404), per-check set, distinct in-use.
    if (path === "/api/tags/suggested" && method === "GET") {
      return world.suggestedKeys ? json(route, world.suggestedKeys) : json(route, { error: "not_found" }, 404);
    }
    if ((m = path.match(/^\/api\/checks\/(\d+)\/tags$/)) && method === "GET") {
      return json(route, world.checkTags?.[Number(m[1])] ?? []);
    }
    if (path === "/api/tags" && method === "GET") return json(route, { tags: world.tags ?? [] });
    // Narrative (Layer 3). Unset narratives → 404 → the card hides (graceful default).
    if (path === "/api/reports/narrative" && method === "GET") {
      const scope = url.searchParams.get("scope") ?? "fleet";
      const key = url.searchParams.get("key");
      const n =
        scope === "monitor" ? world.narratives?.monitor?.[String(key)] : world.narratives?.fleet;
      if (!n) return json(route, { error: "not_found" }, 404);
      return json(route, n);
    }
    // Reports (Layer 2) — deterministic from the query so window/groupBy switches are observable.
    if ((path === "/api/reports/availability" || path === "/api/reports/performance") && method === "GET") {
      if (world.reportsServed === false) return json(route, { error: "not_found" }, 404);
      const win = url.searchParams.get("window") ?? "30d";
      const gb = url.searchParams.get("groupBy") ?? "none";
      const days = win === "7d" ? 7 : win === "90d" ? 90 : 30;
      const base = Date.parse("2026-03-01T00:00:00Z");
      const series = (v: number) =>
        Array.from({ length: days }, (_, i) => ({ date: new Date(base + i * 86400000).toISOString().slice(0, 10), value: v }));
      // Per-check rows mirror the real checks so they align with useChecks (tags) by
      // id; metrics vary by id so sorting reorders observably.
      const checks = world.checks ?? [];
      const availPct = (id: number) => Math.round((100 - ((id * 7) % 28) * 0.9) * 10) / 10;
      const p95Of = (id: number) => 150 + ((id * 37) % 400);
      if (path === "/api/reports/availability") {
        const rows = checks.map((c) => {
          const id = Number(c.id);
          const pct = availPct(id);
          return {
            checkId: id, name: c.name, kind: c.kind, availabilityPct: pct,
            downtimeMinutes: Math.round(((100 - pct) / 100) * days * 1440), incidentCount: id % 3,
          };
        });
        const allGroup = {
          group: "all", availabilityPct: 98, downtimeMinutes: 200, incidentCount: rows.reduce((s, r) => s + r.incidentCount, 0),
          checkCount: rows.length, series: series(98), checks: rows,
        };
        const groups = gb === "none" ? [allGroup] : gb === "team"
          ? [{ ...allGroup, group: "platform", checks: rows.slice(0, 1) }, { ...allGroup, group: "web", checks: rows.slice(1) }]
          : [{ ...allGroup, group: `${gb}-x` }];
        return json(route, { window: win, groupBy: gb, groups });
      }
      // performance: per-check rows; web-vitals at group level present iff any browser check.
      const browserCount = checks.filter((c) => c.kind === "browser").length;
      const rows = checks.map((c) => {
        const id = Number(c.id);
        const p95 = p95Of(id);
        return {
          checkId: id, name: c.name, kind: c.kind,
          avgMs: Math.round(p95 * 0.5), p50Ms: Math.round(p95 * 0.6), p95Ms: p95, p99Ms: Math.round(p95 * 1.5),
        };
      });
      const allGroup = {
        group: "all", avgMs: 200, p50Ms: 180, p95Ms: 400, p99Ms: 600, series: series(400),
        webVitals: browserCount ? { lcpMs: 1800, fcpMs: 900, ttfbMs: 200, cls: 0.05 } : null,
        browserCheckCount: browserCount, checkCount: rows.length, checks: rows,
      };
      const groups = gb === "none" ? [allGroup] : gb === "team"
        ? [{ ...allGroup, group: "platform" }, { ...allGroup, group: "web" }]
        : [{ ...allGroup, group: `${gb}-x` }];
      return json(route, { window: win, groupBy: gb, groups });
    }
    // Alerting reads (undefined → 404, exercising the "setup pending" path).
    if (path === "/api/channels" && method === "GET") {
      return world.channels ? json(route, world.channels) : json(route, { error: "not_found" }, 404);
    }
    if (path === "/api/routing" && method === "GET") {
      return world.routing ? json(route, world.routing) : json(route, { error: "not_found" }, 404);
    }
    if (path === "/api/notifications/health" && method === "GET") {
      return world.notificationsHealth
        ? json(route, world.notificationsHealth)
        : json(route, { error: "not_found" }, 404); // readiness endpoint not deployed (flagged dep)
    }
    if ((m = path.match(/^\/api\/checks\/(\d+)$/))) {
      const d = world.details[Number(m[1])];
      return d ? json(route, d) : json(route, { error: "not_found" }, 404);
    }
    if ((m = path.match(/^\/api\/checks\/(\d+)\/runs$/))) {
      const d = world.details[Number(m[1])];
      let runs = ((d?.recentRuns as RawObj[]) ?? []).slice();
      // Date-range filter (ISO strings sort lexicographically): [from, to).
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      if (from) runs = runs.filter((r) => String(r.startedAt) >= from);
      if (to) runs = runs.filter((r) => String(r.startedAt) < to);
      // Keyset order: DESC started_at, then DESC id (mirrors the API).
      runs.sort(
        (a, b) =>
          String(b.startedAt).localeCompare(String(a.startedAt)) || Number(b.id) - Number(a.id),
      );
      // Cursor = base64url of the LAST id served; continue strictly after it.
      const pageSize = Number(url.searchParams.get("pageSize")) || 50;
      const cursor = url.searchParams.get("cursor");
      let start = 0;
      if (cursor) {
        const afterId = Number(Buffer.from(cursor, "base64url").toString());
        const idx = runs.findIndex((r) => Number(r.id) === afterId);
        start = idx >= 0 ? idx + 1 : runs.length;
      }
      const slice = runs.slice(start, start + pageSize);
      const hasMore = runs.length > start + pageSize;
      const lastId = slice.length ? slice[slice.length - 1]!.id : null;
      const nextCursor =
        hasMore && lastId != null ? Buffer.from(String(lastId)).toString("base64url") : null;
      return json(route, { items: slice, nextCursor, pageSize });
    }
    if (/^\/api\/checks\/\d+\/availability-series$/.test(path)) {
      const win = url.searchParams.get("window") ?? "24h";
      return json(route, world.availability ? { ...world.availability, window: win } : { window: win, bucket: "hour", points: [] });
    }
    if (/^\/api\/checks\/\d+\/metrics$/.test(path)) return json(route, { items: world.metrics ?? [] });
    if ((m = path.match(/^\/api\/runs\/(\d+)\/steps$/))) return json(route, world.steps[Number(m[1])] ?? []);
    if (/^\/api\/runs\/\d+\/screenshot$/.test(path)) {
      if (world.screenshot404) return route.fulfill({ status: 404 });
      return route.fulfill({ status: 200, contentType: "image/png", body: PNG_1X1 });
    }
    if (/^\/api\/runs\/\d+\/trace$/.test(path)) {
      return route.fulfill({
        status: 200,
        contentType: "application/zip",
        headers: { "content-disposition": 'attachment; filename="trace.zip"' },
        body: Buffer.from("PK\x05\x06" + "\x00".repeat(18)),
      });
    }
    if (path === "/api/sla") {
      const win = url.searchParams.get("window") ?? "24h";
      const resp = world.slaByWindow?.[win] ?? world.sla;
      return json(route, { ...resp, window: win });
    }
    if ((m = path.match(/^\/api\/incidents\/(\d+)$/))) {
      const d = world.incidentDetails[Number(m[1])];
      return d ? json(route, d) : json(route, { error: "not_found" }, 404);
    }
    // GET /api/incidents is a CURSOR ENVELOPE ({ items, nextCursor, pageSize }), same shape as runs —
    // NOT a bare array (the #79/#85 pagination arc). The dashboard fetches status=open and status=resolved
    // separately; filter `world.incidents` by the requested status so the envelope mirrors the real API.
    if (path === "/api/incidents" && method === "GET") {
      const status = url.searchParams.get("status");
      const isOpen = (i: RawObj) => i.resolvedAt == null && i.resolved_at == null;
      const items =
        status === "open" ? world.incidents.filter(isOpen)
        : status === "resolved" ? world.incidents.filter((i) => !isOpen(i))
        : world.incidents;
      return json(route, { items, nextCursor: null, pageSize: 50 });
    }
    if (path === "/api/flows") return json(route, world.flows);

    return json(route, []);
  });
}
