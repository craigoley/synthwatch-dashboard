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
  /** Reports served? false → /reports/* 404 (endpoint not deployed). Default true. */
  reportsServed?: boolean;
  /** Status summary (§A3) served? false → GET /status 404 (the By-property section hides). Default true. */
  statusServed?: boolean;
  /** Chat-to-prefill: set false to make /checks/parse-intent report unconfigured (the input hides). */
  parseIntentConfigured?: boolean;
  /** Fleet SLO report: which check ids have an SLO target (default [1,3]); which are "building baseline". */
  sloCheckIds?: number[];
  sloBuildingIds?: number[];
  /** Which checks have incidents in the MTTR report (§A5). Default [1, 2]. Empty scope → honest-empty. */
  mttrCheckIds?: number[];
  /** Successive GET /checks/{id} bodies for live-run polling tests: each poll advances; the last repeats.
   *  e.g. [runningDetail, passDetail] → the page shows 'running', then 'pass', via polling (no reload). */
  detailSequence?: Record<number, RawObj[]>;
  /** Successive GET /checks/{id}/runs item-arrays for live run-history tests: each poll advances; the last
   *  repeats. e.g. [[runningRun], [doneRunWithTrace]] → the list row + trace appear live (no reload). */
  runsSequence?: Record<number, RawObj[][]>;
  /** POST /api/runs/{id}/ai-insights 200 body — the REAL flat AiInsightsDto shape:
   *  { configured, summary, performance[], network[], errors[], suggestions[], caveats[], note }.
   *  Unset → not-configured default. Set configured:true + categories for the happy path. */
  aiInsights?: RawObj;
  /** Force the ai-insights POST to a non-200 (e.g. 401/403) to exercise the auth interceptor. */
  aiInsightsStatus?: number;
  /** Abort the ai-insights POST (a network/edge TRANSPORT failure → the fetch rejects → transport_error). */
  aiInsightsAbort?: boolean;
  /** Reproduce the prod bug: /reports/availability + /reports/performance return 200 with EMPTY groups
   *  (the rollup-backed reports can be empty even when monitors exist). The per-monitor list must still
   *  render from /checks + /sla. Default false. */
  reportsEmpty?: boolean;
  /** Per-check run metrics (CWV) for the report drill-down web-vitals (raw camelCase). */
  metrics?: RawObj[];
  /** AI narratives (Layer 3). Unset → /reports/narrative 404 → card hides (graceful). */
  narratives?: { fleet?: RawObj; monitor?: Record<string, RawObj> };
  /**
   * Monitors-as-code drift (Phase 6b). Unset → /api/reconcile/drift 404 → the surface hides.
   * Set to { items: [] } for the "in sync" empty state, or with rows to list drift.
   */
  reconcileDrift?: { items: RawObj[]; detectedAt?: string | null };
  /** Force POST /api/reconcile/trigger to fail (the "couldn't start the reconcile" path), e.g. { status: 503 }. */
  reconcileTriggerError?: { status: number };
  /** POST /api/runs/{id}/baseline-diff response (LocationDiffDto shape). Unset → configured:false (inert). */
  baselineDiff?: RawObj;
  /** Check ids whose on-demand run trigger should 500 (the "Run all" partial-failure path). */
  runTriggerFailIds?: number[];
  /**
   * Spec catalog (Phase 13). Unset → /api/specs 404 → the catalog page shows a neutral "not
   * available" notice. Set to { items: [] } for the "no specs yet" empty state, or with rows.
   */
  specCatalog?: { items: RawObj[]; probedAt?: string | null };
  /**
   * Auth (Phase 12 slice 3). Simulates slice 2's gate so the dashboard's token injection + 401/403
   * interceptor + role UI are exercised end-to-end:
   *  - `accounts`: email → role for known editor/admins (an email absent here verifies as invalid).
   *  - `enforceAuth`: when true, mutating non-allowlisted writes require an editor/admin token (gate ON).
   *    Default false → today's open behavior (every existing test passes unchanged).
   *  - `revokedEmails`: a valid-looking token whose email is here resolves to NO session → 401 (mid-action
   *    re-login). Tests mutate the shared world to flip state after sign-in.
   *  - `validCode`: the OTP that verifies (default "123456").
   *  - `editors` / `accessRequests`: admin user-management data (stateful across add/remove).
   */
  accounts?: Record<string, "admin" | "editor">;
  enforceAuth?: boolean;
  revokedEmails?: Set<string>;
  validCode?: string;
  editors?: RawObj[];
  accessRequests?: RawObj[];
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

/**
 * Install the mock on a page. Pass a tweaked World for per-test variants.
 *
 * ★ By default it seeds a signed-in EDITOR session (Phase 12 slice 3): the dashboard is now
 * read-only-by-default, so non-auth tests must be "signed in" to see the write affordances they exercise
 * (this preserves the pre-auth open-write behavior). Auth-specific tests pass { seedSession: false } to
 * start signed out and drive login themselves.
 */
const SEED_EDITOR = "e2e-editor@test";
export async function mockApi(
  page: Page,
  world: World = defaultWorld(),
  opts: { seedSession?: boolean } = {},
): Promise<void> {
  if (opts.seedSession ?? true) {
    // The seeded session's email must be a known account so GET /auth/me (called on mount) validates it
    // (otherwise it resolves to anonymous → read-only). Seed localStorage before the app boots.
    world.accounts = { ...(world.accounts ?? {}), [SEED_EDITOR]: "editor" };
    world.revokedEmails ??= new Set();
    await page.addInitScript((session) => {
      window.localStorage.setItem("synthwatch.session", session);
    }, JSON.stringify({ token: `swt_${SEED_EDITOR}`, email: SEED_EDITOR, role: "editor", expiresAt: "2099-01-01T00:00:00Z" }));
  }

  // Stateful test-send requests: requestId → { channelId, poll cursor }. The POST
  // enqueues (202) and the GET status walks the configured statusSequence.
  const testRequests = new Map<number, { channelId: number; polls: number }>();
  let nextRequestId = 1000;
  // Per-check cursor into world.detailSequence — advances each GET /checks/{id} so a live-run test can
  // serve running → terminal across polls.
  const detailSeqIdx = new Map<number, number>();
  // Per-check cursor into world.runsSequence — advances each GET /checks/{id}/runs (the live run-history list).
  const runsSeqIdx = new Map<number, number>();

  await page.route(`${API_ORIGIN}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    let m: RegExpMatchArray | null;

    if (method === "OPTIONS") return route.fulfill({ status: 204 });

    // ── Auth (Phase 12 slice 3) ──────────────────────────────────────────────────────────────────
    // Token scheme: verify mints `swt_<email>`; the email is parsed back out to resolve the live role.
    const bearerEmail = (): string | null => {
      const h = req.headers()["authorization"];
      const tok = h?.startsWith("Bearer ") ? h.slice(7) : null;
      return tok?.startsWith("swt_") ? tok.slice(4) : null;
    };
    // Live role for the request's token, or null = no valid session (unknown/revoked → 401).
    // A valid token whose email isn't an account resolves to "anonymous" (→ 403 on a write).
    const roleOf = (): "admin" | "editor" | "anonymous" | null => {
      const email = bearerEmail();
      if (!email || world.revokedEmails?.has(email)) return null;
      return world.accounts?.[email] ?? "anonymous";
    };
    const UNAUTH_WRITES = ["/api/auth/request-code", "/api/auth/verify", "/api/auth/request-access"];

    if (path === "/api/auth/request-code" && method === "POST")
      return json(route, { message: "If your email is registered, a sign-in code has been sent." }, 202);
    if (path === "/api/auth/request-access" && method === "POST")
      return json(route, { message: "If your request is valid, an admin will review it." });
    if (path === "/api/auth/verify" && method === "POST") {
      const b = JSON.parse(req.postData() || "{}");
      const role = world.accounts?.[String(b.email)];
      if ((world.validCode ?? "123456") === String(b.code) && role)
        return json(route, { token: `swt_${b.email}`, email: b.email, role, expiresAt: "2099-01-01T00:00:00Z" });
      return json(route, { error: "bad_request", message: "That code is invalid or has expired." }, 400);
    }
    if (path === "/api/auth/me" && method === "GET") {
      const r = roleOf();
      if (r === null) return json(route, { error: "unauthorized", message: "No valid session." }, 401);
      return json(route, { email: bearerEmail(), role: r });
    }
    if (path === "/api/auth/logout" && method === "POST") {
      const email = bearerEmail();
      if (email) (world.revokedEmails ??= new Set()).add(email);
      return json(route, { message: "Signed out." });
    }

    // Editor management — admin-only on EVERY verb (mirrors the handler self-guard, independent of the flag).
    if (path === "/api/editors" || path.startsWith("/api/editors/") || path === "/api/access-requests" || path.startsWith("/api/access-requests/")) {
      const r = roleOf();
      if (r === null) return json(route, { error: "unauthorized", message: "Authentication required." }, 401);
      if (r !== "admin")
        return json(route, { error: "forbidden", message: "You do not have permission to perform this action." }, 403);
      if (path === "/api/editors" && method === "GET") return json(route, world.editors ?? []);
      if (path === "/api/editors" && method === "POST") {
        const email = String(JSON.parse(req.postData() || "{}").email ?? "").toLowerCase();
        if ((world.editors ?? []).some((e) => e.email === email))
          return json(route, { error: "conflict", message: `${email} is already an editor.` }, 409);
        const row = { email, addedBy: bearerEmail(), addedAt: "2026-06-25T00:00:00Z" };
        world.editors = [...(world.editors ?? []), row];
        world.accessRequests = (world.accessRequests ?? []).filter((a) => a.email !== email);
        return json(route, row, 201);
      }
      if (path.startsWith("/api/editors/") && method === "DELETE") {
        const email = decodeURIComponent(path.slice("/api/editors/".length)).toLowerCase();
        if (!(world.editors ?? []).some((e) => e.email === email))
          return json(route, { error: "not_found", message: `${email} is not an editor.` }, 404);
        world.editors = (world.editors ?? []).filter((e) => e.email !== email);
        return route.fulfill({ status: 204 });
      }
      if (path === "/api/access-requests" && method === "GET") {
        const have = new Set((world.editors ?? []).map((e) => e.email));
        return json(route, (world.accessRequests ?? []).filter((a) => !have.has(a.email as string)));
      }
      if (path.startsWith("/api/access-requests/") && method === "DELETE") {
        const email = decodeURIComponent(path.slice("/api/access-requests/".length)).toLowerCase();
        world.accessRequests = (world.accessRequests ?? []).filter((a) => a.email !== email);
        return route.fulfill({ status: 204 });
      }
    }

    // Gate simulation: when enforcement is ON, a mutating non-allowlisted write needs an editor/admin
    // session (401 no/invalid, 403 valid-but-anonymous) — exactly slice 2's verb-based gate. Editor/admin
    // fall through to the real write handler below.
    if (
      world.enforceAuth &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(method) &&
      !UNAUTH_WRITES.includes(path)
    ) {
      const r = roleOf();
      if (r === null) return json(route, { error: "unauthorized", message: "Authentication required." }, 401);
      if (r === "anonymous")
        return json(route, { error: "forbidden", message: "You do not have permission to perform this action." }, 403);
    }

    // Writes first (don't get caught by failAllReads).
    // Chat-to-prefill (#132/#149): NL → a validated non-browser monitor suggestion. Deterministic from the text
    // so tests can assert prefill / redirect / field-errors. Shared by the monitors + status pages (#150).
    if (path === "/api/checks/parse-intent" && method === "POST") {
      if (world.parseIntentConfigured === false) return json(route, { configured: false, note: "AI monitor-prefill isn’t configured." });
      const t = String(JSON.parse(req.postData() || "{}").text ?? "").toLowerCase();
      if (/browser|checkout flow|playwright/.test(t))
        return json(route, { configured: true, redirect: "browser", reason: "Browser monitors are authored as code in the monitors repo, then set up from the Catalog." });
      // Pick the first dotted token as the host (split, not a backtracking regex); strip any scheme.
      const host = (t.split(/\s+/).find((w) => w.includes(".")) ?? "example.com").replace(/^https?:\/\//, "");
      if (/invalid|nonsense/.test(t)) // validate-don't-trust: a parsed-but-invalid suggestion → inline field error
        return json(route, { configured: true, valid: false, fields: { name: "Bad parse", kind: "tcp", targetUrl: "example.com" }, fieldErrors: { "netConfig.port": "TCP requires a port (host:port or net_config.port)." } });
      const kind = /ssl/.test(t) ? "ssl" : /\bdns\b/.test(t) ? "dns" : /\btcp\b/.test(t) ? "tcp" : /ping|reachab/.test(t) ? "ping" : "http";
      const targetUrl = kind === "http" || kind === "ssl" ? `https://${host}` : host;
      return json(route, { configured: true, valid: true, fields: { name: `${kind} ${host}`, kind, targetUrl, intervalSeconds: 300 }, fieldErrors: {} });
    }
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
    if (/^\/api\/checks\/(\d+)\/locations$/.test(path) && method === "PUT") {
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
    // Trace AI insights. aiInsightsStatus forces a 401/403 (the gate); else a 200 flat AiInsightsDto.
    // Default (unset) = configured:false (note-bearing), the inert-until-AOAI-prereq state.
    if (/^\/api\/runs\/(\d+)\/ai-insights$/.test(path) && method === "POST") {
      // aiInsightsAbort = a TRANSPORT failure: the fetch never gets a usable response (edge/network) —
      // route.abort() rejects the fetch, mirroring the transient that was mislabeled "unavailable".
      if (world.aiInsightsAbort) return route.abort("failed");
      if (world.aiInsightsStatus) {
        const err = world.aiInsightsStatus === 403 ? "forbidden" : "unauthorized";
        return json(route, { error: err, message: `${err} (test)` }, world.aiInsightsStatus);
      }
      return json(
        route,
        world.aiInsights ?? { configured: false, note: "AI insights are not configured for this environment yet." },
      );
    }

    // Location comparison ("Why is this failing?"). Default (unset) = configured:false (inert). Set
    // world.baselineDiff to a LocationDiffDto-shaped body (incl. insight.verdict) to drive the verdict badge.
    if (/^\/api\/runs\/(\d+)\/baseline-diff$/.test(path) && method === "POST") {
      return json(
        route,
        world.baselineDiff ?? {
          configured: false,
          note: "AI insights are not configured for this environment yet.",
          failing: { runId: 0, location: null, status: "fail" },
          baseline: { source: "success-baseline", capturedAt: null, location: null },
          diff: { console: { onlyInA: [], onlyInB: [], shared: 0 }, network: {} },
          insight: null,
        },
      );
    }

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
    if (/^\/api\/channels\/(\d+)\/test\/status$/.test(path) && method === "GET") {
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
    // POST /api/reconcile/trigger — fire-and-forget off-cron start. 202 { triggered:true }; reconcileTriggerError
    // forces the failure path (e.g. 503 job-start failed). Tests then mutate world.reconcileDrift (advance
    // detectedAt) to simulate the off-cron job re-syncing the snapshot.
    if (path === "/api/reconcile/trigger" && method === "POST") {
      if (world.reconcileTriggerError)
        return json(route, { error: "unavailable" }, world.reconcileTriggerError.status);
      return json(route, { triggered: true }, 202);
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
      // ★ The prod bug: rollup-backed reports return 200 with empty groups even when monitors exist.
      if (world.reportsEmpty) return json(route, { window: url.searchParams.get("window") ?? "30d", groupBy: url.searchParams.get("groupBy") ?? "none", groups: [] });
      const win = url.searchParams.get("window") ?? "30d";
      const gb = url.searchParams.get("groupBy") ?? "none";
      const days = win === "7d" ? 7 : win === "90d" ? 90 : 30;
      const base = Date.parse("2026-03-01T00:00:00Z");
      const availSeries = (pct: number) =>
        Array.from({ length: days }, (_, i) => ({ day: new Date(base + i * 86400000).toISOString().slice(0, 10), availabilityPct: pct, upCount: 100, downCount: Math.round((100 - pct) / 100 * 100) }));
      const perfSeries = (avgMs: number) =>
        Array.from({ length: days }, (_, i) => ({ day: new Date(base + i * 86400000).toISOString().slice(0, 10), avgMs }));
      // Per-check rows mirror the real checks so they align with useChecks (tags) by
      // id; metrics vary by id so sorting reorders observably.
      // ★ Tag filter (?tag=key:value, repeatable AND): scope the aggregate to checks carrying every tag — the
      // server-side filter the real API does. No matching checks → empty groups (honest, like the real API).
      const tagFilter = url.searchParams.getAll("tag");
      const matchesAllTags = (c: RawObj) =>
        tagFilter.every((t) => {
          const i = t.indexOf(":");
          return ((c.tags as { key: string; value: string }[]) ?? []).some((tg) => tg.key === t.slice(0, i) && tg.value === t.slice(i + 1));
        });
      const checks = (world.checks ?? []).filter(matchesAllTags);
      if (checks.length === 0) return json(route, { window: win, groupBy: gb, groups: [] });
      const availPct = (id: number) => Math.round((100 - ((id * 7) % 28) * 0.9) * 10) / 10;
      const p95Of = (id: number) => 150 + ((id * 37) % 400);
      if (path === "/api/reports/availability") {
        // ★ Field names mirror the REAL API: `checkName` + `incidentsOpened` (NOT `name`/`incidentCount`).
        // incidentsOpened varies by id (id % 5) so an Incidents sort observably reorders.
        const rows = checks.map((c) => {
          const id = Number(c.id);
          const pct = availPct(id);
          return {
            checkId: id, checkName: c.name, availabilityPct: pct,
            upCount: Math.round(pct), downCount: Math.round(100 - pct),
            downtimeMinutes: Math.round(((100 - pct) / 100) * days * 1440), incidentsOpened: id % 5,
          };
        });
        const allGroup = {
          group: "all", availabilityPct: 98, downtimeMinutes: 200, incidentsOpened: rows.reduce((s, r) => s + r.incidentsOpened, 0),
          totalCount: rows.length * 100, series: availSeries(98), checks: rows,
        };
        const groups = gb === "none" ? [allGroup] : gb === "team"
          ? [{ ...allGroup, group: "platform", checks: rows.slice(0, 1) }, { ...allGroup, group: "web", checks: rows.slice(1) }]
          : [{ ...allGroup, group: `${gb}-x` }];
        return json(route, { window: win, groupBy: gb, groups });
      }
      // performance: ★ mirror the REAL API shape — latency NESTED under `latency`, per-check `checkName`,
      // web-vitals under `webVitals` with p75 field names (lcpP75Ms/…). (The flat shape this mock used to
      // serve matched the OLD buggy mapper; the contract test now pins the nested truth.)
      const browserCount = checks.filter((c) => c.kind === "browser").length;
      const rows = checks.map((c) => {
        const id = Number(c.id);
        const p95 = p95Of(id);
        return {
          checkId: id, checkName: c.name,
          latency: { sampleCount: 100, avgMs: Math.round(p95 * 0.5), p50Ms: Math.round(p95 * 0.6), p95Ms: p95, p99Ms: Math.round(p95 * 1.5) },
          webVitals: c.kind === "browser" ? { sampleCount: 50, lcpP75Ms: 1800, fcpP75Ms: 900, ttfbP75Ms: 200, clsP75: 0.05 } : null,
        };
      });
      const allGroup = {
        group: "all",
        latency: { sampleCount: 1000, avgMs: 200, p50Ms: 180, p95Ms: 400, p99Ms: 600 },
        series: perfSeries(400),
        webVitals: browserCount ? { sampleCount: 200, lcpP75Ms: 1800, fcpP75Ms: 900, ttfbP75Ms: 200, clsP75: 0.05 } : null,
        checks: rows,
      };
      const groups = gb === "none" ? [allGroup] : gb === "team"
        ? [{ ...allGroup, group: "platform" }, { ...allGroup, group: "web" }]
        : [{ ...allGroup, group: `${gb}-x` }];
      return json(route, { window: win, groupBy: gb, groups });
    }
    // Verdict breakdown (P6) — tag-responsive + honest-empty. Deterministic from the matching-check count so a
    // ?tag= filter observably shifts total/precision; no matching checks → total 0 / precision null (no fake 0%).
    if (path === "/api/reports/incident-breakdown" && method === "GET") {
      if (world.reportsServed === false) return json(route, { error: "not_found" }, 404);
      const win = url.searchParams.get("window") ?? "30d";
      const tagFilter = url.searchParams.getAll("tag");
      const matches = (c: RawObj) =>
        tagFilter.every((t) => {
          const i = t.indexOf(":");
          return ((c.tags as { key: string; value: string }[]) ?? []).some((tg) => tg.key === t.slice(0, i) && tg.value === t.slice(i + 1));
        });
      const n = (world.checks ?? []).filter(matches).length;
      if (n === 0)
        return json(route, { window: win, total: 0, classified: 0, unclassified: 0, realOutages: 0, precision: null, buckets: [] });
      const round = (x: number) => Math.round(x * 10000) / 10000;
      return json(route, {
        window: win, total: n + 1, classified: n + 1, unclassified: 0, realOutages: n, precision: round(n / (n + 1)),
        buckets: [
          { classification: "real-outage", count: n, share: round(n / (n + 1)) },
          { classification: "flaky-transient", count: 1, share: round(1 / (n + 1)) },
        ],
      });
    }
    // Internal/stakeholder status summary (§A3) — property rollup. A DOWN property, an up one with a real %,
    // and a building-baseline property (state up NOW but null uptime — the state≠uptime honesty).
    if (path === "/api/status" && method === "GET") {
      if (world.statusServed === false) return json(route, { error: "not_found" }, 404);
      return json(route, {
        window: "30d",
        properties: [
          { name: "meals2go", state: "down", checkCount: 2, upCount: 1, degradedCount: 0, downCount: 1, uptimePct: 88.94, buildingBaseline: false },
          { name: "wegmans.com", state: "up", checkCount: 5, upCount: 5, degradedCount: 0, downCount: 0, uptimePct: 97.23, buildingBaseline: false },
          { name: "newprop", state: "up", checkCount: 1, upCount: 1, degradedCount: 0, downCount: 0, uptimePct: null, buildingBaseline: true },
        ],
        recentIncidents: [
          { property: "meals2go", title: "meals2go checkout down", openedAt: "2026-06-30T12:00:00Z", resolvedAt: null, status: "open", severity: "critical" },
        ],
      });
    }

    // Fleet SLO / error-budget (P5 v1) — per-check budget rows + a fleet rollup, tag-responsive. sloCheckIds =
    // which checks have an SLO target; sloBuildingIds = insufficient_data ("building baseline", null remaining).
    if (path === "/api/reports/slo" && method === "GET") {
      if (world.reportsServed === false) return json(route, { error: "not_found" }, 404);
      const win = url.searchParams.get("window") ?? "30d";
      const tagFilter = url.searchParams.getAll("tag");
      const matches = (c: RawObj) =>
        tagFilter.every((t) => {
          const i = t.indexOf(":");
          return ((c.tags as { key: string; value: string }[]) ?? []).some((tg) => tg.key === t.slice(0, i) && tg.value === t.slice(i + 1));
        });
      const sloIds = world.sloCheckIds ?? [1, 3];
      const buildingIds = world.sloBuildingIds ?? [3];
      const items = (world.checks ?? [])
        .filter((c) => sloIds.includes(Number(c.id)) && matches(c))
        .map((c) => {
          const id = Number(c.id);
          const insufficient = buildingIds.includes(id);
          const budget = 100;
          const consumed = insufficient ? 0 : (id * 17) % 95; // deterministic; varies remaining_pct so sort reorders
          const remaining = budget - consumed;
          return {
            checkId: id, checkName: c.name, kind: c.kind, target: 0.99, budget, consumed, remaining,
            remainingPct: insufficient ? null : remaining / budget,
            burnRate: insufficient ? null : 1.2, // informational, fixed
            completedRuns: insufficient ? 3 : 500,
            insufficientData: insufficient,
          };
        });
      const active = items.filter((i) => !i.insufficientData);
      const fbudget = active.reduce((s, i) => s + i.budget, 0);
      const fcons = active.reduce((s, i) => s + i.consumed, 0);
      const fleet = items.length
        ? { budget: fbudget, consumed: fcons, remaining: fbudget - fcons, remainingPct: fbudget > 0 ? (fbudget - fcons) / fbudget : null, insufficientData: active.length === 0 }
        : null;
      return json(route, { window: win, items, fleet });
    }

    // Fleet MTTR / incident analytics (§A5) — mean+median over resolved incidents + classification + trend.
    // mttrCheckIds = which checks have incidents; deterministic durations so worst-mean-first sort is testable.
    if (path === "/api/reports/mttr" && method === "GET") {
      if (world.reportsServed === false) return json(route, { error: "not_found" }, 404);
      const win = url.searchParams.get("window") ?? "30d";
      const tagFilter = url.searchParams.getAll("tag");
      const matches = (c: RawObj) =>
        tagFilter.every((t) => {
          const i = t.indexOf(":");
          return ((c.tags as { key: string; value: string }[]) ?? []).some((tg) => tg.key === t.slice(0, i) && tg.value === t.slice(i + 1));
        });
      const mttrIds = world.mttrCheckIds ?? [1, 2];
      const scoped = (world.checks ?? []).filter((c) => mttrIds.includes(Number(c.id)) && matches(c));
      const items = scoped.map((c) => {
        const id = Number(c.id);
        return {
          checkId: id, checkName: c.name, kind: c.kind, resolvedCount: 3, openCount: 1,
          meanSeconds: id === 1 ? 200 : 900, medianSeconds: id === 1 ? 120 : 600, // check 2 slower → sorts first
          mttdProxySeconds: 600, insufficientData: false,
        };
      });
      if (scoped.length === 0) {
        return json(route, {
          window: win, items: [], classification: [], trend: [],
          fleet: { resolvedCount: 0, openCount: 0, totalIncidents: 0, meanSeconds: null, medianSeconds: null, mttdProxySeconds: null, insufficientData: true },
        });
      }
      const resolved = items.reduce((s, i) => s + i.resolvedCount, 0);
      const open = items.reduce((s, i) => s + i.openCount, 0);
      return json(route, {
        window: win, items,
        fleet: { resolvedCount: resolved, openCount: open, totalIncidents: resolved + open, meanSeconds: 500, medianSeconds: 300, mttdProxySeconds: 600, insufficientData: false },
        classification: [
          { classification: "real-outage", count: 4, pctOfTotal: 0.5 },
          { classification: "selector-drift", count: 2, pctOfTotal: 0.25 },
          { classification: "unclassified", count: 2, pctOfTotal: 0.25 },
        ],
        trend: [
          { bucketStart: "2026-06-01T00:00:00Z", resolvedCount: 3, meanSeconds: 700 },
          { bucketStart: "2026-06-08T00:00:00Z", resolvedCount: 3, meanSeconds: 300 },
        ],
      });
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
    // On-demand run trigger (the "Run now" / "Run all" affordance) — the API enqueues + returns { requestId }.
    // runTriggerFailIds forces specific monitors' triggers to 500 (the "couldn't start" partial-failure path).
    if ((m = path.match(/^\/api\/checks\/(\d+)\/run$/)) && method === "POST") {
      if (world.runTriggerFailIds?.includes(Number(m[1])))
        return json(route, { error: "unavailable" }, 500);
      return json(route, { requestId: (nextRequestId += 1) }, 202);
    }
    if ((m = path.match(/^\/api\/checks\/(\d+)$/))) {
      const cid = Number(m[1]);
      // Live-run sequence: successive polls advance through detailSequence (last entry repeats), so a test
      // can drive running → pass without a reload. Falls back to the static detail.
      const seq = world.detailSequence?.[cid];
      if (seq && seq.length > 0) {
        const i = Math.min(detailSeqIdx.get(cid) ?? 0, seq.length - 1);
        detailSeqIdx.set(cid, i + 1);
        return json(route, seq[i]);
      }
      const d = world.details[cid];
      return d ? json(route, d) : json(route, { error: "not_found" }, 404);
    }
    if ((m = path.match(/^\/api\/checks\/(\d+)\/runs$/))) {
      const cid = Number(m[1]);
      // Live run-history sequence: successive polls advance through runsSequence (last entry repeats), so a
      // test can show a run go running→done (with its trace) in the list without a reload. Falls back static.
      const rseq = world.runsSequence?.[cid];
      let runs: RawObj[];
      if (rseq && rseq.length > 0) {
        const i = Math.min(runsSeqIdx.get(cid) ?? 0, rseq.length - 1);
        runsSeqIdx.set(cid, i + 1);
        runs = (rseq[i] ?? []).slice();
      } else {
        runs = ((world.details[cid]?.recentRuns as RawObj[]) ?? []).slice();
      }
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
    // GET /api/incidents — CURSOR ENVELOPE ({ items, nextCursor, pageSize }), same shape as runs (the
    // #79/#85 pagination arc), NOT a bare array. Mirrors the API: status/checkId filters, an openedAt
    // window EXCEPT for status=open (count-bounded, window-exempt), keyset cursor (DESC openedAt,id).
    if (path === "/api/incidents" && method === "GET") {
      let incs = (world.incidents ?? []).slice();
      const status = url.searchParams.get("status");
      if (status) incs = incs.filter((i) => String(i.status) === status);
      const checkId = url.searchParams.get("checkId");
      if (checkId) incs = incs.filter((i) => String(i.checkId) === checkId);
      // Window on openedAt EXCEPT status=open (mirrors the API's open-exemption).
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      if (status !== "open") {
        if (from) incs = incs.filter((i) => String(i.openedAt) >= from);
        if (to) incs = incs.filter((i) => String(i.openedAt) < to);
      }
      // Keyset order: DESC openedAt, then DESC id (mirrors the API).
      incs.sort(
        (a, b) =>
          String(b.openedAt).localeCompare(String(a.openedAt)) || Number(b.id) - Number(a.id),
      );
      const pageSize = Number(url.searchParams.get("pageSize")) || 50;
      const cursor = url.searchParams.get("cursor");
      let start = 0;
      if (cursor) {
        const afterId = Number(Buffer.from(cursor, "base64url").toString());
        const idx = incs.findIndex((i) => Number(i.id) === afterId);
        start = idx >= 0 ? idx + 1 : incs.length;
      }
      const slice = incs.slice(start, start + pageSize);
      const hasMore = incs.length > start + pageSize;
      const lastId = slice.length ? slice[slice.length - 1]!.id : null;
      const nextCursor =
        hasMore && lastId != null ? Buffer.from(String(lastId)).toString("base64url") : null;
      return json(route, { items: slice, nextCursor, pageSize });
    }
    if (path === "/api/flows") return json(route, world.flows);

    return json(route, []);
  });
}
