/**
 * ─────────────────────────────────────────────────────────────────────────────
 * SynthWatch API client — the single seam between the UI and the backend.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every read/write the dashboard performs goes through the typed functions here.
 * Nothing else in the app builds an API URL or calls `fetch`. As of this change
 * the dashboard's own Next.js route handlers + pooled pg client are GONE; this
 * module talks to the standalone C# API on Azure
 * (NEXT_PUBLIC_API_BASE_URL = https://synthwatch-api.azurewebsites.net/api).
 *
 * The C# API speaks camelCase and wraps some collections; this module is the
 * adapter that maps its responses to the snake_case shapes the components read
 * (and maps outgoing write bodies snake→camel). Keep it framework-agnostic
 * (no "use client", no React/SWR) so it can also back a status page / exporter.
 *
 * If the API base ever needs to move again, change NEXT_PUBLIC_API_BASE_URL —
 * components never change.
 */

import type {
  Assertion,
  AvailabilitySeries,
  ChainStep,
  Channel,
  Routing,
  RoutingRule,
  TagRule,
  Tag,
  TagInUse,
  ReportWindow,
  IncidentBreakdown,
  ReportSeriesPoint,
  AvailabilityReport,
  PerformanceReport,
  Narrative,
  NarrativeFact,
  DriftType,
  DriftRow,
  ReconcileDrift,
  ReconcileApplyPlan,
  ReconcileApplyPlanItem,
  PlanStatus,
  SpecCatalog,
  SpecCatalogEntry,
  AiInsight,
  AiInsightConfidence,
  AiInsightSeverity,
  AiInsights,
  AiInsightsResult,
  BaselineDiff,
  BaselineDiffCause,
  BaselineDiffVerdict,
  BaselineDiffInsight,
  BaselineDiffResult,
  DiffConsoleLine,
  Check,
  RedactionHealth,
  CheckAuth,
  CheckDetail,
  CheckKind,
  SloReport,
  CostReport,
  CostCheck,
  DeploysReport,
  EgressReport,
  EgressWindow,
  EgressIp,
  RegionHealthReport,
  RegionHealthRow,
  RegionHealthStatus,
  TrustReport,
  TrustDetail,
  TrustRow,
  TrustChip,
  TrustDimensions,
  StatusPage,
  StatusProperty,
  MttrReport,
  DnsRecordType,
  ParseIntentResult,
  Flow,
  NetConfig,
  CheckWithStatus,
  IncidentDetail,
  IncidentRca,
  IncidentSeverity,
  IncidentsPage,
  IncidentsResponse,
  IncidentWithCheck,
  LocationStatus,
  TraceSas,
  MetricPoint,
  Run,
  RunStatus,
  RunStep,
  RunStepStatus,
  RunOutcome,
  RunsPage,
  Slo,
  SlaFleet,
  SlaResponse,
  SlaRow,
  SlaWindow,
  SparkPoint,
} from "@/lib/types";
import type { CreateCheckInput, UpdateCheckInput } from "@/lib/schemas";
import { getToken, clearSession, emitAuthEvent, type Role } from "@/lib/auth";
import { isDebugOn, runsDebug } from "@/lib/debug";

// Monotonic counter of REAL request() fetch invocations (gated debug only). Lets the [runs-debug] funnel prove
// whether N "fetches" are N genuine network calls vs SWR replaying one cached result.
let runsFetchSeq = 0;

/**
 * Gated raw-response telemetry for the run-history page-0 fetch (the #128 funnel only saw the PARSED newestId,
 * so "newestId X forty times" was ambiguous: stale cache vs nothing newer). Logs the ground truth at the HTTP
 * layer — status, the cache/freshness headers, AND whether the browser served it from its HTTP cache (Resource
 * Timing transferSize/deliveryType) — so a cache HIT or a frozen `date` is self-evident. Off unless the "runs"
 * debug channel is on; scoped to /checks/{id}/runs to avoid noise.
 */
function logRunsFetch(path: string, url: string, res: Response, startedAt: number): void {
  if (!/^\/checks\/\d+\/runs(\?|$)/.test(path) || !isDebugOn("runs")) return;
  const seq = (runsFetchSeq += 1);
  let elapsedMs: number | null = null;
  let deliveryType: string | null = null;
  let transferSize: number | null = null;
  try {
    elapsedMs = Math.round(performance.now() - startedAt);
    // Resource Timing: a browser HTTP-cache hit reports transferSize 0 (or deliveryType "cache"); a real
    // network call reports bytes + a non-trivial duration. This is the decisive browser-cache signal here —
    // Age/x-cache only appear for SHARED caches, of which there are none in front of the direct Kestrel API.
    const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]!.name === url) {
        const e = entries[i]!;
        transferSize = e.transferSize;
        deliveryType =
          (e as PerformanceResourceTiming & { deliveryType?: string }).deliveryType ||
          (e.transferSize === 0 ? "(transferSize=0 → likely cache)" : "network");
        break;
      }
    }
  } catch {
    /* performance API unavailable — skip the timing fields */
  }
  runsDebug(`request ← #${seq} ${path} status=${res.status} elapsed=${elapsedMs ?? "?"}ms`, {
    seq,
    status: res.status,
    elapsedMs,
    // ★ Frozen `date` across ticks = a cached response replaying its original headers; advancing `date` with a
    //   stale newestId = real network calls returning stale data → a SERVER-SIDE problem, not a client cache.
    date: res.headers.get("date"),
    age: res.headers.get("age"), // shared-cache age; expected null here (no proxy/edge in front of the API)
    xCache:
      res.headers.get("x-cache") ??
      res.headers.get("cf-cache-status") ??
      res.headers.get("x-vercel-cache") ??
      null,
    cacheControl: res.headers.get("cache-control"),
    deliveryType, // ★ "cache"/transferSize=0 → browser HTTP cache HIT (the bug #129 was meant to kill)
    transferSize,
  });
}

/**
 * Base URL for the API. Set via NEXT_PUBLIC_API_BASE_URL (Vercel env + .env.local
 * for local dev). Empty default = same-origin, which no longer has a backend, so
 * this MUST be set in every deployed/local environment post-migration.
 */
const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");

/** Error thrown for any non-2xx API response. Carries the HTTP status + details. */
export class ApiRequestError extends Error {
  status: number;
  details: unknown;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.details = details;
  }
}

type QueryValue = string | number | boolean | null | undefined | string[];

/**
 * Resolve an origin-relative proxy path to an absolute URL — for direct browser
 * loads like <img src> and download links that bypass the typed request() helper.
 * These paths already include the "/api" segment, so they resolve against the API
 * ORIGIN (not API_BASE, which itself ends in "/api" — concatenating would double
 * it). Already-absolute URLs pass through; empty base = same-origin.
 *
 * ★ NEVER use this for the bearer-gated artifact endpoints (/runs/{id}/trace,
 * /runs/{id}/screenshot, /checks/{id}/success-trace, trace-signals): a bare
 * <a href>/<img src> to the cross-origin API carries neither the bearer header
 * nor the proxy cookie, so it 401s even for logged-in users (synthwatch-api #154).
 * The screenshot goes through the same-origin /screenshot-proxy/{runId}; traces are fetched directly from
 * Blob via a short-TTL SAS (getRunTraceSas / getCheckSuccessTraceSas), so they need no proxy.
 */
export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  if (!API_BASE) return path;
  try {
    return `${new URL(API_BASE).origin}${path}`;
  } catch {
    return path;
  }
}

function buildUrl(path: string, params?: Record<string, QueryValue>): string {
  let url = `${API_BASE}${path}`;
  if (params) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === null || value === undefined) continue;
      // Arrays → repeated params (?tag=a&tag=b), for the multi-select tag filter; scalars → single value.
      if (Array.isArray(value)) for (const v of value) qs.append(key, String(v));
      else qs.set(key, String(value));
    }
    const query = qs.toString();
    if (query) url += `?${query}`;
  }
  return url;
}

/**
 * The one place that performs `fetch`, checks status, and parses JSON. Tolerates
 * empty bodies (e.g. a 204 from DELETE). Non-2xx → ApiRequestError.
 */
async function request<T>(
  path: string,
  params?: Record<string, QueryValue>,
  init?: RequestInit,
  opts?: { timeoutMs?: number },
): Promise<T> {
  // Attach the bearer session (Phase 12 slice 3). Sent on EVERY request — harmless on GETs (the API's
  // gate only checks writes), simpler than per-call opt-in. The token is a credential: header only,
  // never a URL/query param, never logged.
  const token = getToken();
  // Opt-in timeout (AbortController) — only when a caller passes timeoutMs, so every existing call is
  // unchanged. On expiry the fetch rejects with an AbortError (name "AbortError"), which callers can
  // distinguish from a structured API failure. There was no prior fetch-timeout convention in this client.
  const controller = opts?.timeoutMs != null ? new AbortController() : undefined;
  const timer =
    controller && opts?.timeoutMs != null ? setTimeout(() => controller.abort(), opts.timeoutMs) : undefined;
  try {
    const url = buildUrl(path, params);
    // Gated [runs-debug] timing: capture before the network call so logRunsFetch can report elapsed ms (a
    // sub-millisecond fetch is a tell-tale cache hit). No-op cost when debug is off (just a perf.now read).
    const startedAt = typeof performance !== "undefined" ? performance.now() : 0;
    const res = await fetch(url, {
      ...init,
      // ★ Live-monitoring data must never come from the browser HTTP cache. The fetch default (cache:
      // "default") let the browser reuse a cached GET on every poll tick — the run-history list polled 40+
      // times yet kept returning the SAME page 0 (same newestId + identical nextCursor) until a hard refresh
      // (which sends no-cache and bypassed it). The API doesn't help: /checks/{id}/runs sends NO Cache-Control
      // (heuristically cacheable) and /checks even sends `public, max-age=10`. SWR is our ONLY cache layer;
      // the HTTP layer must always hit the network so a freshly-written run/incident shows within a poll.
      // Overridable per-call (init.cache) for any future genuinely-static GET.
      cache: init?.cache ?? "no-store",
      signal: controller?.signal ?? init?.signal,
      headers: {
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init?.headers,
      },
    });

    logRunsFetch(path, url, res, startedAt); // gated [runs-debug] raw-HTTP ground truth (cache headers + timing)

    if (!res.ok) {
      let body: { error?: string; message?: string; details?: unknown } = {};
      try {
        body = await res.json();
      } catch {
        /* non-JSON error body */
      }

      // 401/403 interceptor (slice 2's gate shapes). EXEMPT /auth/* — a 401 from /auth/me is the normal
      // "not signed in" probe and /verify's 400s are the login modal's to show; intercepting them would
      // loop the modal. Everywhere else:
      //   401 WITH a session (we sent a bearer) → expired/revoked: drop it + signal a re-login prompt.
      //   401 WITHOUT a session → a read-gated GET hit anonymously (api read-gate sweep): nothing to
      //     clear, no modal to pop — the caller's panel renders "sign in to view" (SignInToView).
      //   403 (valid session, wrong role) → signal a permission message; do NOT clear (they ARE logged in).
      if (!path.startsWith("/auth/")) {
        if (res.status === 401) {
          if (token) {
            clearSession();
            emitAuthEvent({ type: "unauthorized" });
          }
        } else if (res.status === 403) {
          emitAuthEvent({
            type: "forbidden",
            message: body.message ?? "You do not have permission to perform this action.",
          });
        }
      }

      throw new ApiRequestError(
        body.message ?? body.error ?? `Request failed (${res.status})`,
        res.status,
        body.details,
      );
    }

    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Shallow snake_case → camelCase for outgoing write bodies. */
function toCamelBody(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out;
}

// ─── raw (C# API, camelCase) shapes ──────────────────────────────────────────

interface RawCheck {
  id: number;
  name: string;
  kind: CheckKind;
  targetUrl: string;
  flowName: string | null;
  method: string;
  expectedStatus: number;
  bodyMustContain?: string | null;
  intervalSeconds: number;
  timeoutMs: number;
  failureThreshold: number;
  severity: string;
  enabled: boolean;
  environment?: string | null; // authoritative checks.environment column (api #205); absent → default "prod"
  environmentOverride?: string | null; // env PR-3: dashboard-owned manual override; wins over environment
  effectiveEnvironment?: string | null; // env PR-3: override ?? environment (the effective env)
  environmentSource?: "override" | "derived" | null; // env PR-3: why the effective env is what it is
  lighthouseEnabled: boolean;
  lighthouseIntervalSeconds?: number | null;
  lighthouseFormFactor?: string | null;
  perfBudgetLcpMs?: number | null;
  perfBudgetTransferBytes?: number | null;
  certExpiryWarnDays?: number | null;
  netConfig?: NetConfig | null;
  steps?: ChainStep[] | null;
  slo?: Slo | null;
  assertions?: Assertion[] | null;
  requestHeaders?: Record<string, string> | null;
  secretHeaders?: Record<string, string> | null; // model B: masked { headerName -> "set" }; session-gated (null for anon)
  loginCredentials?: Record<string, string> | null; // model B: masked { role -> "set" }; session-gated (null for anon)
  requestBody?: string | null;
  auth?: CheckAuth | null;
  tags?: Tag[] | null;
  sourceKey?: string | null;
  specPath?: string | null;
  successTraceAt?: string | null;
  sensitive?: boolean;
  hasRedactPatterns?: boolean;
  redactionHealth?: string;
  lastRunAt: string | null;
  createdAt: string;
  archivedAt?: string | null;
  removedAt?: string | null;
}

const REDACTION_HEALTHS: readonly string[] = ["ok", "misconfigured", "n/a"];

interface RawCheckListItem extends RawCheck {
  currentStatus: RunStatus | null;
  p50Ms: number | null;
  p95Ms: number | null;
  runs24h: number;
  spark: SparkPoint[];
  openIncidentCount: number;
  maxOpenSeverity: IncidentSeverity | null;
  lastCertDaysRemaining: number | null;
  locations: LocationStatus[] | null;
}

interface RawRun {
  id: number;
  checkId: number;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  httpStatus: number | null;
  errorMessage: string | null;
  failedStep: string | null;
  location: string | null;
  screenshotUrl: string | null;
  traceUrl: string | null;
  certDaysRemaining: number | null;
  retryCount?: number | null; // runner 0048; optional → tolerant of pre-deploy API responses without it
  sandbox?: boolean; // runner 0065; optional → tolerant of pre-deploy API responses without it
  hasTraceSignals?: boolean; // persisted trace_signals present, independent of traceUrl; optional → tolerant of pre-deploy API
  confirmationOfRunId?: number | null; // runner 0077: set on a CONFIRMATION run → the original failed run it confirms
  supersededByRunId?: number | null; // runner 0077: set on a TRANSIENT original → its confirmation (which passed → excluded from health)
}

interface RawCheckDetail extends RawCheck {
  recentRuns: RawRun[];
}

interface RawRunsPage {
  items: RawRun[];
  nextCursor: string | null;
  pageSize: number;
}

// GET /api/incidents is a cursor ENVELOPE — same { items, nextCursor, pageSize } shape as runs (the
// #79/#85 cursor-pagination arc), NOT the bare array it used to be. The array lives in `items`.
interface RawIncidentsPage {
  items: RawIncident[];
  nextCursor: string | null;
  pageSize: number;
}

interface RawMetric {
  runId: number;
  capturedAt: string;
  ttfbMs: number | null;
  domContentLoadedMs: number | null;
  loadEventMs: number | null;
  fcpMs: number | null;
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
  transferBytes: number | null;
  resourceCount: number | null;
  domNodeCount: number | null;
  jsHeapBytes: number | null;
  cpuTimeMs: number | null;
  layoutCount: number | null;
  recalcStyleCount: number | null;
}

interface RawMetricsPage {
  items: RawMetric[];
}

interface RawStep {
  id: number;
  runId: number;
  stepIndex: number;
  name: string;
  status: RunStepStatus;
  durationMs: number;
  errorMessage: string | null;
  startedAt: string;
}

interface RawIncident {
  id: number;
  checkId: number;
  status: string;
  severity: IncidentSeverity;
  openedAt: string;
  resolvedAt: string | null;
  openedRunId: number | null;
  resolvedRunId: number | null;
  consecutiveFailures: number;
  summary: string | null;
  checkName: string;
  checkKind: CheckKind;
  rca: IncidentRca | null;
}

interface RawSlaItem {
  checkId: number;
  checkName: string;
  kind: CheckKind;
  windowFrom: string;
  windowTo: string;
  completedRuns: number;
  upRuns: number;
  downRuns: number;
  availabilityPct: number | null;
  insufficientData: boolean;
}

interface RawSlaFleet {
  completedRuns: number;
  upRuns: number;
  downRuns: number;
  availabilityPct: number | null;
  insufficientData: boolean;
}

interface RawSlaResponse {
  window: string;
  items: RawSlaItem[];
  fleet: RawSlaFleet | null;
}

// ─── mappers (camelCase → the snake_case shapes components read) ──────────────

function mapCheck(raw: RawCheck): Check {
  return {
    id: raw.id,
    name: raw.name,
    kind: raw.kind,
    target_url: raw.targetUrl,
    flow_name: raw.flowName,
    method: raw.method,
    expected_status: raw.expectedStatus,
    body_must_contain: raw.bodyMustContain ?? null,
    interval_seconds: raw.intervalSeconds,
    last_run_at: raw.lastRunAt,
    timeout_ms: raw.timeoutMs,
    failure_threshold: raw.failureThreshold,
    severity: raw.severity,
    enabled: raw.enabled,
    environment: raw.environment ?? "prod", // authoritative column (api #205); default prod when absent
    environment_override: raw.environmentOverride ?? null, // env PR-3 manual override (wins); null = none
    effective_environment: raw.effectiveEnvironment ?? raw.environment ?? "prod", // override ?? environment
    environment_source: raw.environmentSource ?? "derived", // "override" | "derived"
    created_at: raw.createdAt,
    archived_at: raw.archivedAt ?? null, // reversible archive (0071); null = active
    removed_at: raw.removedAt ?? null, // git-removal purge clock (0072); null = present in git

    lighthouse_enabled: raw.lighthouseEnabled,
    lighthouse_interval_seconds: raw.lighthouseIntervalSeconds ?? null,
    lighthouse_form_factor: raw.lighthouseFormFactor ?? "desktop",
    perf_budget_lcp_ms: raw.perfBudgetLcpMs ?? null,
    perf_budget_transfer_bytes: raw.perfBudgetTransferBytes ?? null,
    cert_expiry_warn_days: raw.certExpiryWarnDays ?? null,
    net_config: raw.netConfig ?? null,
    steps: raw.steps ?? null,
    slo: raw.slo ?? null,
    // JSONB columns: the API returns these verbatim (nested keys already in the
    // UI's shape — assertion {source,comparison,target,expected}, auth.token_env,
    // header dict), so pass them through unchanged.
    assertions: raw.assertions ?? [],
    request_headers: raw.requestHeaders ?? null,
    secret_headers: raw.secretHeaders ?? null, // model B: masked {name->"set"}; API sends to editors, null to anon/viewer
    login_credentials: raw.loginCredentials ?? null, // model B: masked {role->"set"}; editor-gated like secret_headers
    request_body: raw.requestBody ?? null,
    auth: raw.auth ?? null,
    tags: raw.tags ?? [],
    source_key: raw.sourceKey ?? null,
    spec_path: raw.specPath ?? null,
    success_trace_at: raw.successTraceAt ?? null,
    // B10 redaction (#121): null when the API predates it (no field) OR off-taxonomy → renders no badge.
    sensitive: raw.sensitive === true,
    has_redact_patterns: raw.hasRedactPatterns === true,
    redaction_health: REDACTION_HEALTHS.includes(raw.redactionHealth ?? "")
      ? (raw.redactionHealth as RedactionHealth)
      : null,
  };
}

function mapCheckWithStatus(raw: RawCheckListItem): CheckWithStatus {
  return {
    ...mapCheck(raw),
    current_status: raw.currentStatus,
    last_started_at: raw.lastRunAt, // C# exposes last run time as lastRunAt
    last_finished_at: null, // not provided by the list endpoint (unused by the card)
    last_error_message: null, // not provided by the list endpoint (unused by the card)
    p50_ms: raw.p50Ms,
    p95_ms: raw.p95Ms,
    runs_24h: raw.runs24h,
    open_incident_count: raw.openIncidentCount,
    max_open_severity: raw.maxOpenSeverity,
    spark: raw.spark ?? [],
    last_cert_days_remaining: raw.lastCertDaysRemaining ?? null,
    locations: raw.locations ?? [],
  };
}

function mapRun(raw: RawRun): Run {
  return {
    id: raw.id,
    check_id: raw.checkId,
    status: raw.status,
    started_at: raw.startedAt,
    finished_at: raw.finishedAt,
    duration_ms: raw.durationMs,
    http_status: raw.httpStatus,
    error_message: raw.errorMessage,
    failed_step: raw.failedStep,
    location: raw.location ?? null,
    screenshot_url: raw.screenshotUrl,
    trace_url: raw.traceUrl ?? null,
    cert_days_remaining: raw.certDaysRemaining ?? null,
    retry_count: raw.retryCount ?? null, // null when the API predates 0048 → row shows nothing
    sandbox: raw.sandbox ?? false, // false when the API predates 0065 → no badge
    has_trace_signals: raw.hasTraceSignals ?? false, // false when the API predates the flag → no summary offered
    confirmation_of_run_id: raw.confirmationOfRunId ?? null, // null (pre-0077 API) → no confirmation badge
    superseded_by_run_id: raw.supersededByRunId ?? null, // null → not a transient → no transient badge
  };
}

function mapMetric(raw: RawMetric): MetricPoint {
  return {
    run_id: raw.runId,
    captured_at: raw.capturedAt,
    started_at: raw.capturedAt, // C# metrics omit started_at; captured_at drives the chart X-axis
    status: "pass", // not provided and not read by the charts
    ttfb_ms: raw.ttfbMs,
    dom_content_loaded_ms: raw.domContentLoadedMs,
    load_event_ms: raw.loadEventMs,
    fcp_ms: raw.fcpMs,
    lcp_ms: raw.lcpMs,
    cls: raw.cls,
    inp_ms: raw.inpMs,
    transfer_bytes: raw.transferBytes,
    resource_count: raw.resourceCount,
    dom_node_count: raw.domNodeCount,
    js_heap_bytes: raw.jsHeapBytes,
    cpu_time_ms: raw.cpuTimeMs,
    layout_count: raw.layoutCount,
    recalc_style_count: raw.recalcStyleCount,
  };
}

function mapStep(raw: RawStep): RunStep {
  return {
    id: raw.id,
    run_id: raw.runId,
    step_index: raw.stepIndex,
    name: raw.name,
    status: raw.status,
    duration_ms: raw.durationMs,
    error_message: raw.errorMessage,
    started_at: raw.startedAt,
  };
}

function mapIncident(raw: RawIncident): IncidentWithCheck {
  return {
    id: raw.id,
    check_id: raw.checkId,
    status: raw.status,
    severity: raw.severity,
    opened_at: raw.openedAt,
    resolved_at: raw.resolvedAt,
    opened_run_id: raw.openedRunId,
    resolved_run_id: raw.resolvedRunId,
    consecutive_failures: raw.consecutiveFailures,
    summary: raw.summary,
    check_name: raw.checkName,
    check_kind: raw.checkKind,
    rca: raw.rca ?? null,
  };
}

function mapSla(raw: RawSlaItem): SlaRow {
  return {
    check_id: raw.checkId,
    check_name: raw.checkName,
    kind: raw.kind,
    window_from: raw.windowFrom,
    window_to: raw.windowTo,
    completed_runs: raw.completedRuns,
    up_runs: raw.upRuns,
    down_runs: raw.downRuns,
    availability_pct: raw.availabilityPct,
    insufficient_data: raw.insufficientData ?? false,
  };
}

function mapFleet(raw: RawSlaFleet | null | undefined): SlaFleet | null {
  if (!raw) return null;
  return {
    completed_runs: raw.completedRuns,
    up_runs: raw.upRuns,
    down_runs: raw.downRuns,
    availability_pct: raw.availabilityPct,
    insufficient_data: raw.insufficientData ?? false,
  };
}

export interface RunsQuery {
  /** ISO-8601 window start; the API defaults to the last 7d when omitted (bounded). */
  from?: string;
  /** ISO-8601 window end; the API defaults to now when omitted. */
  to?: string;
  /** Opaque next-cursor from the prior page (omit for the first page). */
  cursor?: string;
  pageSize?: number;
  /** Server-side outcome filter (api #153). "all"/undefined omits the param; passed/failed/errored filter. */
  outcome?: RunOutcome;
}

export interface DeleteCheckResult {
  id: number;
  deleted: "soft" | "hard";
}

// ─── reads ───────────────────────────────────────────────────────────────────

/** GET /api/checks — all checks with derived status for the grid. */
export async function listChecks(): Promise<CheckWithStatus[]> {
  const raw = await request<RawCheckListItem[]>("/checks");
  return raw.map(mapCheckWithStatus);
}

/** GET /api/checks/:id — one check + its recent runs. */
export async function getCheck(id: number): Promise<CheckDetail> {
  const raw = await request<RawCheckDetail>(`/checks/${id}`);
  return { check: mapCheck(raw), recent_runs: (raw.recentRuns ?? []).map(mapRun) };
}

/** The runner's cached runtime-spec identity for a Git-managed check (read-only observability). */
export interface SpecCache {
  git_managed: boolean;
  spec_path: string | null;
  /** The monitors-repo commit SHA the cached compile was fetched at (null: never fetched / not Git-managed). */
  cached_sha: string | null;
  fetched_at: string | null;
}

/**
 * GET /checks/{id}/spec-cache — which monitors-repo commit is cached + when it was last fetched, so a merge's
 * propagation is observable. Read-only (the runner owns eviction — the API can't write spec_cache). 404 (the
 * endpoint isn't deployed yet) → null so the caller self-hides.
 */
export async function getSpecCache(id: number): Promise<SpecCache | null> {
  try {
    const raw = await request<Record<string, unknown>>(`/checks/${id}/spec-cache`);
    return {
      git_managed: Boolean(raw?.gitManaged),
      spec_path: (raw?.specPath as string | null) ?? null,
      cached_sha: (raw?.cachedSha as string | null) ?? null,
      fetched_at: (raw?.fetchedAt as string | null) ?? null,
    };
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null;
    throw err;
  }
}

/** One diffed error (P1 fingerprint + P2 severity). `origin` = "first-party" | "third-party"; `status` is the
 *  network status (e.g. 400, -1 abort), null for console/page errors. `message` is the canonical (normalized) text. */
export interface ErrorItem {
  fingerprint: string;
  kind: string;
  origin: string;
  level: string | null;
  status: number | null;
  source_host: string;
  message: string;
  count: number;
  severity: number;
  severity_label: string;
  first_seen_run_id: number | null;
  /** P4: the deploy this NEW error first appeared after (in the window between the previous run and this one),
   *  or null. Correlation, never causation — set only on NEW items. */
  first_seen_after_deploy: FirstSeenAfterDeploy | null;
}

/** P4: the deploy a NEW error first appeared after. `sha` is "" for a non-commit marker (etag/sentry-release). */
export interface FirstSeenAfterDeploy {
  sha: string;
  deployed_at: string;
  target_host: string;
}

/** First-party vs third-party counts per bucket (so the UI can label the third-party toggle without re-counting). */
export interface ErrorDiffCounts {
  new_first_party: number;
  new_third_party: number;
  persistent_first_party: number;
  persistent_third_party: number;
  resolved_first_party: number;
  resolved_third_party: number;
  /** P4: errors muted for this check that would otherwise be NEW (surfaced in `muted`, not `new_errors`). */
  muted: number;
}

/** GET /checks/{id}/error-diff — this run's errors vs the union of the last N settled runs. NEW = the regression. */
export interface ErrorDiff {
  check_id: number;
  run_id: number;
  run_started_at: string | null;
  location: string | null;
  baseline_run_ids: number[];
  new_errors: ErrorItem[];
  persistent: ErrorItem[];
  resolved: ErrorItem[];
  /** P4: errors the operator muted for this check that would otherwise be NEW — surfaced (never dropped) so the
   *  UI can show a "N muted" disclosure with an unmute action. */
  muted: ErrorItem[];
  counts: ErrorDiffCounts;
  /** true when this run or any baseline run hit the console cap — the diff is INCOMPLETE above the cap. */
  truncated: boolean;
  /** true when the cap dropped a FIRST-PARTY message (not just tracker noise) — the LOUD case. When `truncated`
   *  but NOT this, only third-party was dropped and first-party capture is complete (calm copy). */
  first_party_truncated: boolean;
  /** the target run's count of third-party messages dropped by the cap — the "N" in the calm copy. */
  dropped_third_party: number;
  baseline_run_count: number;
}

function mapErrorItem(r: Record<string, unknown>): ErrorItem {
  return {
    fingerprint: String(r.fingerprint ?? ""),
    kind: String(r.kind ?? ""),
    origin: String(r.origin ?? "third-party"),
    level: (r.level as string | null) ?? null,
    status: (r.status as number | null) ?? null,
    source_host: String(r.sourceHost ?? ""),
    message: String(r.message ?? ""),
    count: Number(r.count ?? 0),
    severity: Number(r.severity ?? 0),
    severity_label: String(r.severityLabel ?? ""),
    first_seen_run_id: (r.firstSeenRunId as number | null) ?? null,
    first_seen_after_deploy: mapDeploy(r.firstSeenAfterDeploy),
  };
}

function mapDeploy(v: unknown): FirstSeenAfterDeploy | null {
  if (!v || typeof v !== "object") return null;
  const d = v as Record<string, unknown>;
  return {
    sha: String(d.sha ?? ""),
    deployed_at: String(d.deployedAt ?? ""),
    target_host: String(d.targetHost ?? ""),
  };
}

const asItems = (v: unknown): ErrorItem[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]).map(mapErrorItem) : [];

/**
 * GET /checks/{id}/error-diff?runId=&baseline=N — the error diff for the latest settled run (or `runId`) vs the
 * union of the last N settled runs. Items arrive already severity-sorted. 404 → null (no signals for this run →
 * the panel self-hides). Session-gated + Cache-Control: no-store (don't cache a live diff).
 */
export async function getErrorDiff(
  checkId: number,
  opts: { runId?: number; baseline?: number } = {},
): Promise<ErrorDiff | null> {
  try {
    const raw = await request<Record<string, unknown>>(`/checks/${checkId}/error-diff`, {
      runId: opts.runId,
      baseline: opts.baseline,
    });
    const counts = (raw?.counts ?? {}) as Record<string, unknown>;
    return {
      check_id: Number(raw?.checkId ?? checkId),
      run_id: Number(raw?.runId ?? 0),
      run_started_at: (raw?.runStartedAt as string | null) ?? null,
      location: (raw?.location as string | null) ?? null,
      baseline_run_ids: Array.isArray(raw?.baselineRunIds) ? (raw.baselineRunIds as number[]) : [],
      new_errors: asItems(raw?.new),
      persistent: asItems(raw?.persistent),
      resolved: asItems(raw?.resolved),
      muted: asItems(raw?.muted),
      counts: {
        new_first_party: Number(counts.newFirstParty ?? 0),
        new_third_party: Number(counts.newThirdParty ?? 0),
        persistent_first_party: Number(counts.persistentFirstParty ?? 0),
        persistent_third_party: Number(counts.persistentThirdParty ?? 0),
        resolved_first_party: Number(counts.resolvedFirstParty ?? 0),
        resolved_third_party: Number(counts.resolvedThirdParty ?? 0),
        muted: Number(counts.muted ?? 0),
      },
      truncated: Boolean(raw?.truncated),
      first_party_truncated: Boolean(raw?.firstPartyTruncated),
      dropped_third_party: Number(raw?.droppedThirdParty ?? 0),
      baseline_run_count: Number(raw?.baselineRunCount ?? 0),
    };
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null;
    throw err;
  }
}

/** One error mute (P4): the muted fingerprint + when/who/why. `muted_by`/`note` are best-effort (nullable). */
export interface ErrorMute {
  fingerprint: string;
  muted_at: string;
  muted_by: string | null;
  note: string | null;
}

function mapMute(r: Record<string, unknown>): ErrorMute {
  return {
    fingerprint: String(r.fingerprint ?? ""),
    muted_at: String(r.mutedAt ?? ""),
    muted_by: (r.mutedBy as string | null) ?? null,
    note: (r.note as string | null) ?? null,
  };
}

/** GET /checks/{id}/error-mutes — every mute for the check (newest first). Session-gated; 401/403 → [] (the
 *  disclosure just shows nothing for a non-editor). */
export async function getErrorMutes(checkId: number): Promise<ErrorMute[]> {
  try {
    const raw = await request<{ mutes?: Record<string, unknown>[] }>(`/checks/${checkId}/error-mutes`);
    return Array.isArray(raw?.mutes) ? raw.mutes.map(mapMute) : [];
  } catch (err) {
    if (err instanceof ApiRequestError && (err.status === 401 || err.status === 403)) return [];
    throw err;
  }
}

/** POST /checks/{id}/error-mutes — mute a fingerprint for this monitor (optional note). Editor-gated (verb-gate
 *  → anon 401). Idempotent server-side. The muted error leaves `new_errors` and joins `muted` on the next read. */
export async function muteError(checkId: number, fingerprint: string, note?: string): Promise<ErrorMute> {
  const raw = await request<Record<string, unknown>>(
    `/checks/${checkId}/error-mutes`,
    undefined,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fingerprint, note: note && note.trim() !== "" ? note.trim() : undefined }),
    },
  );
  return mapMute(raw ?? {});
}

/** DELETE /checks/{id}/error-mutes?fingerprint=… — unmute (the fingerprint is a query param: a network
 *  fingerprint embeds a URL, so it can't be a path segment). Editor-gated; idempotent (204). */
export async function unmuteError(checkId: number, fingerprint: string): Promise<void> {
  await request<null>(
    `/checks/${checkId}/error-mutes`,
    { fingerprint },
    { method: "DELETE" },
  );
}

/** The masked echo the write endpoint (and every read) returns: { key -> "set" }, never a value/ciphertext. */
export interface MaskedCredentials {
  secret_headers: Record<string, string> | null;
  login_credentials: Record<string, string> | null;
}

/**
 * PUT /api/checks/{id}/credentials — model B: SET a monitor's secret_headers / login_credentials VALUES
 * (encrypted server-side; the DB never holds plaintext). Editor/admin-gated (PUT verb-gate → anon 401); the
 * bearer rides `request()` like every other write. ★ REPLACE semantics per column: each provided map REPLACES
 * that whole column (send the full desired set); an omitted map leaves it unchanged; an EMPTY map clears it.
 * The response is WRITE-ONLY — masked slots ({key->"set"}) only, so a caller can never round-trip a value.
 * Send PLAINTEXT values; they are encrypted before store.
 */
export async function setCredentials(
  id: number,
  body: { secretHeaders?: Record<string, string>; loginCredentials?: Record<string, string> },
): Promise<MaskedCredentials> {
  const raw = await request<{ secretHeaders?: Record<string, string> | null; loginCredentials?: Record<string, string> | null }>(
    `/checks/${id}/credentials`,
    undefined,
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  return { secret_headers: raw?.secretHeaders ?? null, login_credentials: raw?.loginCredentials ?? null };
}

/**
 * GET /api/checks/:id/runs — one cursor-paginated page of run history over a date-range
 * window. Keyset cursor on started_at (stable for the append-only runs table); omit `from`
 * and the API bounds the query to a recent default window so it never loads all-time. Pass
 * the returned `next_cursor` back as `cursor` for the following page.
 */
export async function getRuns(id: number, query: RunsQuery = {}): Promise<RunsPage> {
  const raw = await request<RawRunsPage>(`/checks/${id}/runs`, {
    from: query.from,
    to: query.to,
    cursor: query.cursor,
    pageSize: query.pageSize,
    // "all"/undefined → omit (server default). Never send an unknown value — the API 400s on those.
    outcome: query.outcome && query.outcome !== "all" ? query.outcome : undefined,
  });
  return {
    runs: (raw.items ?? []).map(mapRun),
    next_cursor: raw.nextCursor ?? null,
    page_size: raw.pageSize ?? query.pageSize ?? 50,
  };
}

/** GET /api/runs/:id/steps — run_steps for the funnel stage-bar. */
export async function getSteps(runId: number): Promise<RunStep[]> {
  const raw = await request<RawStep[]>(`/runs/${runId}/steps`);
  return raw.map(mapStep);
}

// ─── Trace SIGNALS summary (GET /api/runs/:id/trace-signals — the compact, redacted network/console summary) ─
// Distinct from the AI insights above: no AOAI, no token spend — just the persisted trace_signals the runner
// extracted at capture. Available even when there's NO downloadable trace (a sensitive monitor's green run:
// trace_url null by B10 design, but signals persisted). The API serializes the TraceSignalsDto camelCase; we
// type only the fields the summary renders (extra keys are ignored structurally).
export interface TraceSignalsSummary {
  targetHost: string | null;
  network: {
    totalRequests: number;
    wireKb: number;
    thirdPartyCount: number;
    failed: { url: string; status: number; thirdParty: boolean }[];
    topThirdParties: { host: string; count: number; kb: number }[];
  };
  console: {
    messages: { level: string; origin: string; sourceHost?: string; text: string }[];
    droppedError: number;
  };
}

/** GET /api/runs/:id/trace-signals — null when the run has no signals (404). 401/403 propagate to the global
 *  re-login/permission UX (same as the other gated fetchers). */
export async function getTraceSignals(runId: number): Promise<TraceSignalsSummary | null> {
  try {
    return await request<TraceSignalsSummary>(`/runs/${runId}/trace-signals`);
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 404) return null;
    throw e;
  }
}

// ─── Trace AI insights (POST /api/runs/:id/ai-insights — slice 2 endpoint, gated editor/admin) ────────
// ★ The REAL API (AiInsightsDto, slice 2) returns a FLAT 200 body — categories at the TOP level, NOT
// wrapped in an `insights` object, and the non-fatal note is `note` (not `message`):
//   { configured: false, ..., note }                                    → not configured (AOAI prereq pending)
//   { configured: true,  summary: null, ..., note }                     → AOAI/parse failed (non-fatal) → retry
//   { configured: true,  summary, performance[], network[], errors[], suggestions[], caveats[], note }
// (#100 assumed a nested { insights: {...} } shape — it never matched the live API, so success bodies were
//  misread. 401/403 never reach here: request() throws + drives the global re-login / permission UX.)
interface RawAiInsightDto {
  severity?: string;
  confidence?: string;
  title?: string;
  detail?: string;
  evidence?: string | null;
}
interface RawAiInsightsDto {
  configured?: boolean;
  summary?: string | null;
  performance?: RawAiInsightDto[];
  network?: RawAiInsightDto[];
  errors?: RawAiInsightDto[];
  suggestions?: RawAiInsightDto[];
  caveats?: string[];
  note?: string | null;
}

const AI_SEVERITIES: readonly string[] = ["critical", "high", "medium", "low", "info"];
const AI_CONFIDENCES: readonly string[] = ["high", "medium", "low"];

function mapAiInsight(r: RawAiInsightDto): AiInsight {
  return {
    severity: (AI_SEVERITIES.includes(r.severity ?? "") ? r.severity : "info") as AiInsightSeverity,
    confidence: (AI_CONFIDENCES.includes(r.confidence ?? "") ? r.confidence : "low") as AiInsightConfidence,
    title: String(r.title ?? ""),
    detail: String(r.detail ?? ""),
    evidence: r.evidence ?? null,
    scope: null, // the API doesn't (yet) tag site/third-party scope; kept optional on the domain type
  };
}

function mapAiInsights(r: RawAiInsightsDto): AiInsights {
  const arr = (a?: RawAiInsightDto[]) => (a ?? []).map(mapAiInsight);
  return {
    summary: String(r.summary ?? ""),
    performance: arr(r.performance),
    network: arr(r.network),
    errors: arr(r.errors),
    suggestions: arr(r.suggestions),
    caveats: (r.caveats ?? []).map(String),
  };
}

// AOAI calls are slow (blob download + parse + model); bound the request so a hung one becomes a clean
// transport_error ("timed out, try again") instead of an indefinite spinner.
const AI_INSIGHTS_TIMEOUT_MS = 60_000;

/**
 * Diagnostic breadcrumb for an ai-insights TRANSPORT failure (no usable response). Logs only the SHAPE —
 * did we get a response at all, the HTTP status, why we classify it as transport — no PII. This is the trail
 * that was missing when a transient edge blip was mislabeled "unavailable" and cost hours to diagnose.
 * NOTE: there is no client-side telemetry sink (Sentry/analytics) in this app, so this is console-only —
 * adding one would let a recurrence be diagnosed without a repro. (See the PR notes.)
 */
function logAiTransportFailure(runId: number, err: unknown): "timeout" | "http_error" | "network" {
  const timedOut = err instanceof Error && err.name === "AbortError";
  const gotResponse = err instanceof ApiRequestError; // ApiRequestError ⇒ the API responded (non-2xx)
  const reason = timedOut ? "timeout" : gotResponse ? "http_error" : "network";
  const status = err instanceof ApiRequestError ? err.status : "none";
  console.warn(
    `[ai-insights] transport failure run=${runId} reason=${reason} gotResponse=${gotResponse} httpStatus=${status}`,
  );
  return reason;
}

/**
 * POST /api/runs/:id/ai-insights — on-demand AOAI trace analysis. Goes through request() (bearer token
 * injected; 401/403 drive the global re-login / permission UX). Distinguishes the two failure families that
 * were previously conflated into one "unavailable" message:
 *   • TRANSPORT (fetch rejected / timed out / non-2xx without our error shape) → transport_error: we never
 *     got a usable response; the request likely never reached the API. Retry may help (often transient).
 *   • API-SIDE: a structured 200 body we classify by `configured` / content:
 *       configured === false                         → not_configured (the ONLY trigger for that copy)
 *       configured === true  but no summary/insights → unavailable (the API RAN but produced nothing)
 *       configured === true  with content            → ok
 */
export async function getAiInsights(runId: number): Promise<AiInsightsResult> {
  let raw: RawAiInsightsDto | null;
  try {
    raw = await request<RawAiInsightsDto | null>(
      `/runs/${runId}/ai-insights`,
      undefined,
      { method: "POST" },
      { timeoutMs: AI_INSIGHTS_TIMEOUT_MS },
    );
  } catch (err) {
    // 401/403 are genuine API responses the global interceptor already handled — rethrow so the caller
    // drives re-login / the permission toast (NOT a transport error).
    if (err instanceof ApiRequestError && (err.status === 401 || err.status === 403)) throw err;
    // Anything else = no usable response (network/edge/DNS/TLS reject, timeout, or a non-2xx without our
    // JSON error shape). Distinct from an API-side "ran but no insights". Leave a breadcrumb + say so.
    const reason = logAiTransportFailure(runId, err);
    return {
      status: "transport_error",
      message:
        reason === "timeout"
          ? "The AI service didn’t respond in time — this is usually transient. Try again."
          : "Couldn’t reach the AI service — this is usually transient. Try again.",
    };
  }

  if (!raw || raw.configured === false) {
    return { status: "not_configured", message: raw?.note ?? "AI insights aren’t configured for this environment yet." };
  }
  const insights = mapAiInsights(raw);
  const hasContent =
    insights.summary.trim() !== "" ||
    insights.performance.length + insights.network.length + insights.errors.length + insights.suggestions.length > 0;
  if (!hasContent) {
    return { status: "unavailable", message: raw.note ?? "The AI service ran but couldn’t generate insights for this run." };
  }
  return { status: "ok", insights };
}

// ─── Location comparison: POST /api/runs/{id}/baseline-diff ──────────────────────────────────────────
// The DIFF needs no AOAI, so it's present for every non-transport state; the INSIGHT only when configured.
// Mirrors getAiInsights' transport-vs-API-side state machine + the camelCase contract (flat top-level).

interface RawDiffConsoleLine {
  level?: string;
  origin?: string;
  text?: string;
}
interface RawBaselineDiffDto {
  configured?: boolean;
  note?: string | null;
  retryable?: boolean;
  failing?: { runId?: number; location?: string | null; status?: string };
  baseline?: { source?: string; capturedAt?: string | null; location?: string | null };
  diff?: {
    console?: { onlyInA?: RawDiffConsoleLine[]; onlyInB?: RawDiffConsoleLine[]; shared?: number };
    network?: {
      totalRequestsA?: number;
      totalRequestsB?: number;
      failedHostsOnlyInA?: string[];
      thirdPartyOnlyInA?: { host?: string; count?: number; kb?: number }[];
    };
  };
  insight?: {
    summary?: string;
    verdict?: string;
    likelyCause?: string;
    confidence?: string;
    isFlaky?: boolean;
    findings?: RawAiInsightDto[];
    caveats?: string[];
  } | null;
}

const DIFF_CAUSES: readonly string[] = [
  "regional-waf-cdn", "network-allowlist", "geo-dns", "region-timeout", "third-party-blocked",
  "flaky-transient", "undetermined",
];

const DIFF_VERDICTS: readonly string[] = [
  "site-failure", "monitor-verification-bug", "transient", "undetermined",
];

const mapDiffLine = (r: RawDiffConsoleLine): DiffConsoleLine => ({
  level: String(r.level ?? ""),
  origin: String(r.origin ?? "unknown"),
  text: String(r.text ?? ""),
});

function mapBaselineDiff(r: RawBaselineDiffDto): BaselineDiff {
  const c = r.diff?.console ?? {};
  const n = r.diff?.network ?? {};
  return {
    failing: {
      runId: Number(r.failing?.runId ?? 0),
      location: r.failing?.location ?? null,
      status: String(r.failing?.status ?? ""),
    },
    baseline: { source: String(r.baseline?.source ?? "success-baseline"), capturedAt: r.baseline?.capturedAt ?? null },
    console: {
      onlyInThisRun: (c.onlyInA ?? []).map(mapDiffLine),
      onlyInBaseline: (c.onlyInB ?? []).map(mapDiffLine),
      shared: Number(c.shared ?? 0),
    },
    network: {
      totalRequestsThisRun: Number(n.totalRequestsA ?? 0),
      totalRequestsBaseline: Number(n.totalRequestsB ?? 0),
      failedHostsOnlyInThisRun: (n.failedHostsOnlyInA ?? []).map(String),
      thirdPartyOnlyInThisRun: (n.thirdPartyOnlyInA ?? []).map((t) => ({
        host: String(t.host ?? ""),
        count: Number(t.count ?? 0),
        kb: Number(t.kb ?? 0),
      })),
    },
  };
}

function mapBaselineDiffInsight(i: NonNullable<RawBaselineDiffDto["insight"]>): BaselineDiffInsight {
  return {
    summary: String(i.summary ?? ""),
    // verdict (#118): a valid taxonomy value → the value; absent (legacy/pre-#118) or off-taxonomy → null,
    // which renders NO badge (back-compat). "undetermined" is a real value → it DOES get a neutral badge.
    verdict: (DIFF_VERDICTS.includes(i.verdict ?? "") ? i.verdict : null) as BaselineDiffVerdict | null,
    likelyCause: (DIFF_CAUSES.includes(i.likelyCause ?? "") ? i.likelyCause : "undetermined") as BaselineDiffCause,
    confidence: (AI_CONFIDENCES.includes(i.confidence ?? "") ? i.confidence : "low") as AiInsightConfidence,
    isFlaky: i.isFlaky === true,
    findings: (i.findings ?? []).map(mapAiInsight),
    caveats: (i.caveats ?? []).map(String),
  };
}

/**
 * POST /api/runs/:id/baseline-diff — diff the failing run vs the monitor's last-known-good baseline + the
 * AI comparison. Same transport-vs-API-side discipline as getAiInsights. The diff is returned for every
 * non-transport state; the insight only when configured + produced.
 */
export async function getBaselineDiff(runId: number): Promise<BaselineDiffResult> {
  let raw: RawBaselineDiffDto | null;
  try {
    raw = await request<RawBaselineDiffDto | null>(
      `/runs/${runId}/baseline-diff`,
      undefined,
      { method: "POST" },
      { timeoutMs: AI_INSIGHTS_TIMEOUT_MS },
    );
  } catch (err) {
    if (err instanceof ApiRequestError && (err.status === 401 || err.status === 403)) throw err;
    const reason = logAiTransportFailure(runId, err);
    return {
      status: "transport_error",
      message:
        reason === "timeout"
          ? "The comparison didn’t finish in time — this is usually transient. Try again."
          : "Couldn’t run the comparison — this is usually transient. Try again.",
    };
  }

  // A 404 (no trace / no baseline) surfaces as an ApiRequestError → handled above as transport_error with a
  // breadcrumb; a 200 body always carries the diff.
  if (!raw || !raw.diff) {
    return { status: "transport_error", message: "Couldn’t run the comparison for this run." };
  }
  const diff = mapBaselineDiff(raw);
  if (raw.configured === false) {
    return { status: "not_configured", diff, message: raw.note ?? "AI insights aren’t configured for this environment yet." };
  }
  if (!raw.insight) {
    return { status: "unavailable", diff, message: raw.note ?? "The comparison ran but produced no analysis.", retryable: raw.retryable === true };
  }
  return { status: "ok", diff, insight: mapBaselineDiffInsight(raw.insight) };
}

/** GET /api/checks/:id/metrics — run_metrics time series. */
export async function getMetrics(id: number): Promise<MetricPoint[]> {
  const raw = await request<RawMetricsPage>(`/checks/${id}/metrics`);
  return (raw.items ?? []).map(mapMetric);
}

/** Filters + cursor for the paginated incidents list (mirrors the API contract). */
export interface IncidentsQuery {
  status?: "open" | "resolved";
  checkId?: number;
  /** ISO-8601 window start; the API defaults to the last 30d (status=open is exempt). */
  from?: string;
  to?: string;
  cursor?: string;
  pageSize?: number;
}

interface RawIncidentsPage {
  items: RawIncident[];
  nextCursor: string | null;
  pageSize: number;
}

/**
 * GET /api/incidents — one cursor-paginated page of incidents over a date-range window. Keyset
 * cursor on opened_at (sparse, append-only-over-time); omit `from` and the API bounds the query to
 * the last 30d so it never loads all-time. `status=open` is exempt from the window (open incidents
 * are count-bounded). Pass the returned `next_cursor` back as `cursor` for the following page.
 */
export async function getIncidents(query: IncidentsQuery = {}): Promise<IncidentsPage> {
  const raw = await request<RawIncidentsPage>("/incidents", {
    status: query.status,
    checkId: query.checkId,
    from: query.from,
    to: query.to,
    cursor: query.cursor,
    pageSize: query.pageSize,
  });
  return {
    incidents: (raw.items ?? []).map(mapIncident),
    next_cursor: raw.nextCursor ?? null,
    page_size: raw.pageSize ?? query.pageSize ?? 50,
  };
}

// The UNSCOPED { open, resolved } consumers (status page, the availability-chart incident overlay, the
// monitor report-detail) read HISTORICAL resolved incidents across windows up to 90d — so listIncidents()
// must NOT inherit the API's default 30d window, which would silently drop 30–90d-old resolved incidents
// from those surfaces (the chart promises they're overlaid; the 90d report omits them otherwise). Incidents
// are SPARSE (≤ one per failure episode), so a wide lookback + a large page returns effectively all of them
// while staying bounded. The incidents PAGE does NOT use this — it uses useIncidentHistory (getIncidents)
// with its own date-range + Load more, which is the unbounded set the cursor design exists to bound.
const LEGACY_INCIDENT_LOOKBACK_DAYS = 365;

/**
 * GET /api/incidents — all open + wide-window resolved, split for the legacy { open, resolved } consumers.
 * Open is count-bounded + window-exempt; resolved is fetched over a wide (≥ widest consumer window)
 * lookback at a large page so no consumer silently loses history. For the full paginated/date-ranged
 * history use getIncidents / useIncidentHistory directly (the incidents page).
 */
export async function listIncidents(): Promise<IncidentsResponse> {
  const from = new Date(Date.now() - LEGACY_INCIDENT_LOOKBACK_DAYS * 86_400_000).toISOString();
  const [open, resolved] = await Promise.all([
    getIncidents({ status: "open", pageSize: 200 }),
    getIncidents({ status: "resolved", from, pageSize: 200 }),
  ]);
  return { open: open.incidents, resolved: resolved.incidents };
}

interface RawTimelineRun {
  runId: number;
  status: RunStatus;
  startedAt: string;
  durationMs: number | null;
  httpStatus: number | null;
  errorMessage: string | null;
  failedStep: string | null;
  screenshotUrl: string | null;
  traceUrl: string | null;
  location: string | null;
}
interface RawRecurrence {
  id: number;
  openedAt: string;
  resolvedAt: string | null;
  status: string;
  summary: string | null;
}
interface RawIncidentDetail {
  id: number;
  checkId: number;
  checkName: string;
  checkKind: CheckKind;
  environment?: string | null; // authoritative checks.environment (api #205 → incident DTO); absent → default "prod"
  status: string;
  severity: IncidentSeverity;
  openedAt: string;
  resolvedAt: string | null;
  durationSeconds: number | null;
  consecutiveFailures: number;
  summary: string | null;
  rca: IncidentRca | null;
  perLocation: LocationStatus[] | null;
  timeline: RawTimelineRun[] | null;
  timelineTotal?: number | null; // optional → tolerant of a pre-timeline-cap API (absent → null, UI unchanged)
  recurrence: RawRecurrence[] | null;
  nearbyDeploys?: RawNearbyDeploy[] | null; // optional → tolerant of the pre-#157 API (absent → [])
}

interface RawNearbyDeploy {
  detectedAt: string;
  source: string;
  isSha: boolean;
  sha: string;
  fingerprint: string;
  offsetMinutes: number;
}

interface RawTraceSas {
  url: string;
  expiresAt: string;
}

/** GET /api/runs/{id}/trace-sas — mint a short-TTL read-only SAS so the browser fetches the trace blob
 *  DIRECTLY (off the Vercel proxy that can't stream 124MB). Auth-gated on the API side (401/403 → throws). */
export async function getRunTraceSas(runId: number): Promise<TraceSas> {
  const raw = await request<RawTraceSas>(`/runs/${runId}/trace-sas`);
  return { url: raw.url, expires_at: raw.expiresAt };
}

/** GET /api/checks/{id}/success-trace-sas — same, for a monitor's last-known-good success trace. */
export async function getCheckSuccessTraceSas(checkId: number): Promise<TraceSas> {
  const raw = await request<RawTraceSas>(`/checks/${checkId}/success-trace-sas`);
  return { url: raw.url, expires_at: raw.expiresAt };
}

/** GET /api/incidents/{id} — the incident investigation payload. */
export async function getIncident(id: number): Promise<IncidentDetail> {
  const raw = await request<RawIncidentDetail>(`/incidents/${id}`);
  return {
    id: raw.id,
    check_id: raw.checkId,
    check_name: raw.checkName,
    check_kind: raw.checkKind,
    environment: raw.environment ?? "prod", // authoritative column (api #205); default prod when absent
    status: raw.status,
    severity: raw.severity,
    opened_at: raw.openedAt,
    resolved_at: raw.resolvedAt,
    consecutive_failures: raw.consecutiveFailures,
    summary: raw.summary,
    rca: raw.rca ?? null,
    per_location: raw.perLocation ?? [],
    timeline: (raw.timeline ?? []).map((t) => ({
      run_id: t.runId,
      status: t.status,
      started_at: t.startedAt,
      duration_ms: t.durationMs,
      http_status: t.httpStatus,
      error_message: t.errorMessage,
      failed_step: t.failedStep,
      screenshot_url: t.screenshotUrl,
      trace_url: t.traceUrl,
      location: t.location ?? null,
    })),
    // null (absent/pre-cap API) preserved — NEVER 0 (a fake "0 of 0" caption); the UI only captions when
    // the value is present and exceeds the rows served (the api-side bounded-timeline companion).
    timeline_total: raw.timelineTotal ?? null,
    recurrence: (raw.recurrence ?? []).map((r) => ({
      id: r.id,
      opened_at: r.openedAt,
      resolved_at: r.resolvedAt,
      status: r.status,
      summary: r.summary,
    })),
    // Absent (pre-#157 API) → [] → the annotation section is absent. Forward-compatible.
    nearby_deploys: (raw.nearbyDeploys ?? []).map((d) => ({
      detected_at: d.detectedAt,
      source: d.source,
      is_sha: d.isSha,
      sha: d.sha ?? "",
      fingerprint: d.fingerprint,
      offset_minutes: d.offsetMinutes,
    })),
  };
}

interface RawFlow {
  name: string;
  description: string | null;
  entryUrlHint: string | null;
  updatedAt: string;
}

function mapFlow(raw: RawFlow): Flow {
  return {
    name: raw.name,
    description: raw.description ?? null,
    entry_url_hint: raw.entryUrlHint ?? null,
    updated_at: raw.updatedAt,
  };
}

/** GET /api/flows — runner-emitted flow manifest (name + metadata). */
export async function listFlows(): Promise<Flow[]> {
  const raw = await request<RawFlow[]>("/flows");
  return (raw ?? []).map(mapFlow);
}

// ─── monitors-as-code drift (Phase 6b) ───────────────────────────────────────
// The API serves the runner-owned reconcile_drift snapshot read-only (mirrors the narrative read path).
// FLAGGED DEP: a 404 (endpoint not deployed yet) → null, so the surface hides cleanly rather than erroring.
// An empty items array is DIFFERENT from null: it means the reconcile ran and found nothing → "in sync".

interface RawDriftItem {
  sourceKey: string;
  driftType: string;
  detail?: Record<string, unknown> | null;
  detectedAt: string;
}

/** GET /api/reconcile/drift — the latest reconcile snapshot (read-only; reconcile runs in report mode). */
export async function getReconcileDrift(): Promise<ReconcileDrift | null> {
  try {
    const raw = await request<{ items?: RawDriftItem[]; detectedAt?: string | null }>("/reconcile/drift");
    const items: DriftRow[] = (raw?.items ?? []).map((d) => ({
      source_key: d.sourceKey,
      drift_type: d.driftType as DriftType,
      detail: d.detail ?? {},
      detected_at: d.detectedAt,
    }));
    return { items, detected_at: raw?.detectedAt ?? null };
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null;
    throw err;
  }
}

interface RawPlanItem {
  sourceKey: string;
  driftType: string;
  status: string;
  plan?: ReconcileApplyPlanItem["plan"] | null;
  computedAt: string;
}

/** GET /api/reconcile/plan — the DRY-RUN apply plan per drift (reconcile-apply Phase 0). Read-only preview;
 *  nothing is applied or approved this phase. */
export async function getReconcilePlan(): Promise<ReconcileApplyPlan | null> {
  try {
    const raw = await request<{ items?: RawPlanItem[]; computedAt?: string | null }>("/reconcile/plan");
    const items: ReconcileApplyPlanItem[] = (raw?.items ?? []).map((p) => ({
      source_key: p.sourceKey,
      drift_type: p.driftType as DriftType,
      status: p.status as PlanStatus,
      plan: p.plan ?? { summary: "", disposition: p.status, statements: [] },
      computed_at: p.computedAt,
    }));
    return { items, computed_at: raw?.computedAt ?? null };
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null;
    throw err;
  }
}

/**
 * POST /api/reconcile/trigger — ARM-start the reconcile job NOW (off-cron), the #115-proven path. Editor/
 * admin-gated by the API (write verb). 202 { triggered: true } on success; 503 if the ACA job-start failed.
 * Fire-and-forget — there's NO execution id to poll; the result surfaces as the drift snapshot's detected_at
 * advancing on the next /reconcile/drift read (poll it while reconciling).
 */
export async function triggerReconcile(): Promise<{ triggered: boolean }> {
  return request<{ triggered: boolean }>("/reconcile/trigger", undefined, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
}

// ─── reconcile-apply Phase 1 (approve / reject / APPLY — editor-only; the API gates + audits) ──────
/** POST /api/reconcile/approve — pending → approved. A blocked plan returns 4xx (can't be approved). */
export async function approveReconcilePlan(sourceKey: string, driftType: string): Promise<void> {
  await request<unknown>("/reconcile/approve", undefined, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceKey, driftType }),
  });
}

/** POST /api/reconcile/reject — pending → rejected. */
export async function rejectReconcilePlan(sourceKey: string, driftType: string): Promise<void> {
  await request<unknown>("/reconcile/reject", undefined, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceKey, driftType }),
  });
}

/** POST /api/reconcile/apply — execute the approved plans (the API caps at 5/call). */
export async function applyReconcilePlans(): Promise<{ applied: string[]; failed: string[]; cap: number }> {
  return request<{ applied: string[]; failed: string[]; cap: number }>("/reconcile/apply", undefined, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
}

// ─── spec catalog (Phase 13 — read-only inventory) ───────────────────────────
// GET /api/specs serves the runner-owned spec_catalog snapshot LEFT JOINed to checks (coverage + health),
// mirroring the reconcile read path. FLAGGED DEP: a 404 (endpoint not deployed yet) → null, so the catalog
// page hides gracefully. An empty items array is DIFFERENT from null: the reconcile hasn't populated it yet.

interface RawSpecHealth {
  currentStatus?: RunStatus | null;
  p95Ms?: number | null;
  openIncidentCount?: number | null;
  lastRunAt?: string | null;
}
interface RawSpecItem {
  sourceKey: string;
  name: string;
  specPath: string;
  kind: string;
  target?: string | null;
  suggestedIntervalSeconds?: number | null;
  tags?: string[] | null;
  description?: string | null;
  enabledByDefault?: boolean;
  runnable: boolean;
  notRunnableReason?: string | null;
  monitored: boolean;
  checkId?: number | null;
  checkName?: string | null;
  enabled?: boolean | null;
  archivedAt?: string | null;
  removedAt?: string | null;
  health?: RawSpecHealth | null;
}

/** GET /api/specs — the latest spec catalog (read-only inventory; activation is a later PR). */
export async function getSpecCatalog(): Promise<SpecCatalog | null> {
  try {
    const raw = await request<{ items?: RawSpecItem[]; probedAt?: string | null }>("/specs");
    const items: SpecCatalogEntry[] = (raw?.items ?? []).map((s) => ({
      source_key: s.sourceKey,
      name: s.name,
      spec_path: s.specPath,
      kind: s.kind,
      target: s.target ?? null,
      suggested_interval_seconds: s.suggestedIntervalSeconds ?? null,
      tags: s.tags ?? [],
      description: s.description ?? null,
      enabled_by_default: Boolean(s.enabledByDefault),
      runnable: Boolean(s.runnable),
      not_runnable_reason: s.notRunnableReason ?? null,
      monitored: Boolean(s.monitored),
      check_id: s.checkId ?? null,
      check_name: s.checkName ?? null,
      enabled: s.enabled ?? null,
      archived_at: s.archivedAt ?? null,
      removed_at: s.removedAt ?? null,
      health: s.health
        ? {
            current_status: s.health.currentStatus ?? null,
            p95_ms: s.health.p95Ms ?? null,
            open_incident_count: s.health.openIncidentCount ?? 0,
            last_run_at: s.health.lastRunAt ?? null,
          }
        : null,
    }));
    return { items, probed_at: raw?.probedAt ?? null };
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null;
    throw err;
  }
}

// ─── locations (multi-location: the run-location ASSIGNMENT, not per-run status) ──
// Contract (served by the parallel API PR):
//   GET /api/locations            -> { locations: [{ name, enabled }] }  (selector options)
//   GET /api/checks/{id}/locations-> { locations: ["eastus2", …] }       (current assignment)
//   PUT /api/checks/{id}/locations  body { locations:[…] } -> { locations:[…] }
//     (400 on empty or on unknown/disabled names). `name`/`enabled` are already the
//     UI shape — no camel→snake adaptation needed.

/** An available run location (selector option). */
export interface LocationOption {
  name: string;
  enabled: boolean;
}

interface RawLocationsResponse {
  locations?: { name: string; enabled: boolean }[];
}
interface RawCheckLocations {
  locations?: string[];
}

/** GET /api/locations — every available location (callers filter to enabled). */
export async function getLocations(): Promise<LocationOption[]> {
  const raw = await request<RawLocationsResponse>("/locations");
  return (raw?.locations ?? []).map((l) => ({ name: l.name, enabled: l.enabled }));
}

/** GET /api/checks/{id}/locations — the check's current location assignment. */
export async function getCheckLocations(id: number): Promise<string[]> {
  const raw = await request<RawCheckLocations>(`/checks/${id}/locations`);
  return raw?.locations ?? [];
}

/** PUT /api/checks/{id}/locations — set the assignment; returns the new set. */
export async function setCheckLocations(id: number, locations: string[]): Promise<string[]> {
  const raw = await request<RawCheckLocations>(`/checks/${id}/locations`, undefined, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ locations }),
  });
  return raw?.locations ?? [];
}

// ─── alerting: channels + routing (dashboard-managed) ────────────────────────
// Channels are delivery TARGETS — no transport credentials. `config` is JSONB-ish
// (nested camelCase) and passes through verbatim, like check assertions/auth.
// Contract (matches the API's RoutingDto EXACTLY):
//   GET/POST /api/channels, PUT/DELETE /api/channels/{id}
//   GET/PUT  /api/routing  -> { severity:{[critical|warning]:{channelIds}}, perCheck:{[checkId]:{channelIds}} }
//   ★ NOT { defaults, overrides }: the API drops unrecognized keys, then deletes all
//   routes and inserts none — a SILENT WIPE that reports 200. Keep these names exact.

/** Fields a channel create/update accepts (everything but the server-assigned id). */
export type ChannelInput = Omit<Channel, "id">;

export async function listChannels(): Promise<Channel[]> {
  const raw = await request<Channel[]>("/channels");
  return raw ?? [];
}

export async function createChannel(input: ChannelInput): Promise<Channel> {
  return request<Channel>("/channels", undefined, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function updateChannel(id: number, input: ChannelInput): Promise<Channel> {
  return request<Channel>(`/channels/${id}`, undefined, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function deleteChannel(id: number): Promise<void> {
  await request<unknown>(`/channels/${id}`, undefined, { method: "DELETE" });
}

// The API serves routing as { severity, perCheck, tagRules } (null/absent when empty).
// Map exactly — mismatched keys were a silent wipe (the {defaults,overrides} bug).
type RawRouting = {
  severity?: Record<string, RoutingRule> | null;
  perCheck?: Record<string, RoutingRule> | null;
  tagRules?: TagRule[] | null;
};

export async function getRouting(): Promise<Routing> {
  const raw = await request<RawRouting>("/routing");
  return { severity: raw?.severity ?? {}, perCheck: raw?.perCheck ?? {}, tagRules: raw?.tagRules ?? [] };
}

export async function setRouting(routing: Routing): Promise<Routing> {
  // Send the FULL object (severity + perCheck + tagRules) so saving one dimension
  // never wipes another — mirrors the #66-safe save pattern.
  const raw = await request<RawRouting>("/routing", undefined, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ severity: routing.severity, perCheck: routing.perCheck, tagRules: routing.tagRules }),
  });
  return {
    severity: raw?.severity ?? routing.severity,
    perCheck: raw?.perCheck ?? routing.perCheck,
    tagRules: raw?.tagRules ?? routing.tagRules,
  };
}

// ─── tags (Phase 9a — key:value labels on checks) ────────────────────────────
// Contract (parallel API PR): tag = { key, value }, normalized lowercase.
//   GET/PUT /api/checks/{id}/tags  (PUT replaces the check's full tag set)
//   GET /api/tags            -> distinct in-use tags (for the future 9b filter bar)
//   GET /api/tags/suggested  -> suggested keys: [env, service, team, criticality]

// Tolerant of both a bare [Tag] array and a { tags:[…] } wrapper (the locations
// endpoint wraps; the tags response shape is unconfirmed until the API serves it).
const asTags = (raw: Tag[] | { tags?: Tag[] } | null): Tag[] =>
  Array.isArray(raw) ? raw : (raw?.tags ?? []);

export async function getCheckTags(id: number): Promise<Tag[]> {
  return asTags(await request<Tag[] | { tags?: Tag[] }>(`/checks/${id}/tags`));
}

export async function setCheckTags(id: number, tags: Tag[]): Promise<Tag[]> {
  const raw = await request<Tag[] | { tags?: Tag[] }>(`/checks/${id}/tags`, undefined, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tags }),
  });
  return asTags(raw) ?? tags;
}

/** Distinct in-use tags (with per-tag check count) for the filter bar. The API
    wraps them as { tags:[{key,value,count}] }; tolerate a bare array too. */
export async function getTags(): Promise<TagInUse[]> {
  const raw = await request<TagInUse[] | { tags?: TagInUse[] }>("/tags");
  const list = Array.isArray(raw) ? raw : (raw?.tags ?? []);
  return list.map((t) => ({ key: t.key, value: t.value, count: t.count ?? 0 }));
}

/** Suggested tag keys (env/service/team/criticality) for the editor's key autocomplete. */
export async function getSuggestedKeys(): Promise<string[]> {
  const raw = await request<string[]>("/tags/suggested");
  return raw ?? [];
}

// ─── async test-send (runs via the runner, not synchronously) ────────────────
// A test send is now a one-off ACA job (~10-15s), so the dashboard ENQUEUES it
// and polls for the outcome instead of blocking on a synchronous response.
// Contract (the API implements EXACTLY this — do not deviate):
//   POST /api/channels/{id}/test                       -> 202 { requestId }
//   GET  /api/channels/{id}/test/status?requestId={id} -> { status, detail, requestedAt, completedAt }
//   status ∈ pending | sending | delivered | failed.

/** Lifecycle of a queued test send (mirrors the runner's job states). */
export type ChannelTestStatus = "pending" | "sending" | "delivered" | "failed";

/** GET .../test/status response — the polled outcome of one queued test send. */
export interface ChannelTestStatusResult {
  status: ChannelTestStatus;
  detail: string | null;
  requestedAt: string | null;
  completedAt: string | null;
}

/**
 * POST /api/channels/{id}/test — ENQUEUE a test delivery on the runner. Returns
 * the 202 { requestId } the caller then polls via getChannelTestStatus.
 * FLAGGED API DEPENDENCY: the endpoint may not exist yet (404) — callers treat
 * that as "unavailable" (returns { unavailable: true }), never a hard error.
 */
export async function sendChannelTest(
  id: number,
): Promise<{ unavailable: true } | { unavailable?: false; requestId: number }> {
  try {
    const raw = await request<{ requestId: number }>(`/channels/${id}/test`, undefined, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    return { requestId: raw.requestId };
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return { unavailable: true };
    throw err;
  }
}

/**
 * POST /api/checks/{id}/run — trigger an on-demand run now (don't wait for the timer). Editor-gated by
 * the API. 202 { requestId }; idempotent server-side (a second request while one is pending coalesces).
 * The run then appears in the check's run history.
 */
export async function runCheckNow(id: number, opts?: { sandbox?: boolean }): Promise<{ requestId: number }> {
  // ?sandbox=true lets a PAUSED (enabled=false) monitor be run out-of-band for VALIDATION: the runner writes
  // a visible runs row + trace but skips evaluate() (no incident/alert/SLO) and never resumes the check
  // (synthwatch-api #195 / runner #225). Omitted for an enabled check → a normal on-demand run (a paused
  // check without the flag is a 409, unchanged). Query flag (not a body) so the normal POST stays identical.
  return request<{ requestId: number }>(
    `/checks/${id}/run`,
    opts?.sandbox ? { sandbox: true } : undefined,
    { method: "POST", headers: { "content-type": "application/json" } },
  );
}

/**
 * GET /api/channels/{id}/test/status?requestId= — poll one queued test send.
 * Throws ApiRequestError (incl. 404 for an unknown requestId) so the caller can
 * stop polling and surface the reason.
 */
export async function getChannelTestStatus(
  id: number,
  requestId: number,
): Promise<ChannelTestStatusResult> {
  const raw = await request<Partial<ChannelTestStatusResult>>(
    `/channels/${id}/test/status`,
    { requestId },
  );
  return {
    status: (raw?.status ?? "pending") as ChannelTestStatus,
    detail: raw?.detail ?? null,
    requestedAt: raw?.requestedAt ?? null,
    completedAt: raw?.completedAt ?? null,
  };
}

/**
 * GET /api/notifications/health — delivery-readiness (is the ACS transport set up?).
 * FLAGGED API DEPENDENCY: returns null if the endpoint isn't served yet (404), so
 * the UI can fall back to a neutral note rather than asserting an unverified state.
 */
export interface DeliveryReadiness {
  /** ≥1 enabled channel with a real target (email recipient / webhook URL) — DB-verified. */
  channelsConfigured: boolean;
  /** ≥1 routing rule exists — DB-verified. */
  routingConfigured: boolean;
  /** ACS transport: true/false only if the API can see it; null = UNKNOWN (it can't). */
  transportConfigured: boolean | null;
  detail?: string | null;
}

export async function getDeliveryReadiness(): Promise<DeliveryReadiness | null> {
  try {
    const raw = await request<Partial<DeliveryReadiness>>("/notifications/health");
    return {
      channelsConfigured: Boolean(raw?.channelsConfigured),
      routingConfigured: Boolean(raw?.routingConfigured),
      // ?? null preserves the UNKNOWN state — never coerce null→false (that would lie).
      transportConfigured: raw?.transportConfigured ?? null,
      detail: raw?.detail ?? null,
    };
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null;
    throw err;
  }
}

// ─── reporting (Layer 2): availability + performance, grouped by tag ─────────
// Contract (parallel API PR): GET /api/reports/availability?window=&groupBy= and
// GET /api/reports/performance?window=&groupBy= . Both serve camelCase; mapped to
// the snake_case report types. FLAGGED DEP: return null on 404 (endpoint not served
// yet → the page shows "reports pending", never a broken view).

// ★ The API serves series with `day` (not `date`) and a metric-specific value field:
// availability → `availabilityPct`, performance → `avgMs`. Map both to the domain
// { date, value } so chart components stay agnostic.
interface RawReportSeriesPoint { day: string; availabilityPct?: number | null; avgMs?: number | null }
const mapSeries = (s?: RawReportSeriesPoint[] | null): ReportSeriesPoint[] =>
  (s ?? []).map((p) => ({ date: p.day, value: p.availabilityPct ?? p.avgMs ?? null }));

// Repeatable ?tag=key:value for the report tag-filter (multi-select AND, server-side). undefined → omitted →
// whole fleet (the no-op default), matching the API's cardinality=0 short-circuit.
const tagParams = (tags: Tag[]): string[] | undefined =>
  tags.length ? tags.map((t) => `${t.key}:${t.value}`) : undefined;

export async function getAvailabilityReport(
  window: ReportWindow,
  groupBy: string,
  tags: Tag[] = [],
): Promise<AvailabilityReport | null> {
  try {
    const raw = await request<Record<string, unknown>>("/reports/availability", { window, groupBy, tag: tagParams(tags) });
    const groups = ((raw?.groups as Record<string, unknown>[]) ?? []).map((g) => {
      const checks = ((g.checks as Record<string, unknown>[]) ?? []).map((c) => ({
        check_id: c.checkId as number,
        name: String(c.checkName ?? ""),
        availability_pct: (c.availabilityPct as number) ?? null,
        downtime_minutes: (c.downtimeMinutes as number) ?? 0,
        incident_count: (c.incidentsOpened as number) ?? 0,
      }));
      return {
        group: String(g.group ?? "ungrouped"),
        availability_pct: (g.availabilityPct as number) ?? null,
        downtime_minutes: (g.downtimeMinutes as number) ?? 0,
        incident_count: (g.incidentsOpened as number) ?? 0,
        check_count: (g.checkCount as number) ?? checks.length,
        series: mapSeries(g.series as RawReportSeriesPoint[]),
        checks,
      };
    });
    return { window, group_by: String(raw?.groupBy ?? groupBy), groups };
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null;
    throw err;
  }
}

// Build the audit chips from the API's passthrough fact_pack. The runner writes fact_pack as a rich
// OBJECT ({ current:{availabilityPct,p95,incidents,downtimeMin,…}, deltas:{availabilityPts,p95Pct,…}, … }),
// NOT a pre-shaped chip array — so derive the cited-number chips (value + w/w delta) here. Tolerates a
// future array shape too. (Field names mirror runner/narrative.ts's FactPack — keep in sync.)
function toFactChips(fp: unknown): NarrativeFact[] {
  if (Array.isArray(fp)) {
    return (fp as Record<string, unknown>[]).map((f) => ({
      label: String(f.label ?? ""),
      value: String(f.value ?? ""),
      delta: f.delta == null ? null : String(f.delta),
    }));
  }
  if (!fp || typeof fp !== "object") return [];
  const o = fp as Record<string, unknown>;
  const c = (o.current ?? {}) as Record<string, number | null>;
  const d = (o.deltas ?? {}) as Record<string, number | null>;
  const signed = (n: number, unit: string) => `${n >= 0 ? "+" : ""}${n}${unit}`;
  const facts: NarrativeFact[] = [];
  if (c.availabilityPct != null)
    facts.push({ label: "Availability", value: `${c.availabilityPct}%`, delta: d.availabilityPts != null ? signed(d.availabilityPts, "pp") : null });
  if (c.p95 != null)
    facts.push({ label: "p95", value: `${c.p95}ms`, delta: d.p95Pct != null ? signed(d.p95Pct, "%") : null });
  if (c.incidents != null)
    facts.push({ label: "Incidents", value: String(c.incidents), delta: d.incidents ? signed(d.incidents, "") : null });
  if (c.downtimeMin != null)
    facts.push({ label: "Downtime", value: `${c.downtimeMin}m`, delta: d.downtimeMin ? signed(d.downtimeMin, "m") : null });

  // Cost citations (Layer 3). The runner writes fleet compute-cost into fact_pack.cost
  // ({ fleetProjected, fleetMeasured, fleetDivergence, notable:[{name,projected,divergenceFlag,…}], topDrivers }).
  // Fleet-scoped only (guard on scopeType) so a monitor card never cites the whole fleet's cost; self-absent
  // when the pack predates cost (fleetProjected == null → no chips, never a fake $0). Cites the real keys
  // field-for-field, same discipline as the reliability chips above.
  const cost = (o.cost ?? {}) as {
    fleetProjected?: number | null;
    fleetMeasured?: number | null;
    fleetDivergence?: number | null;
    notable?: Array<{ name?: string; projected?: number | null; divergenceFlag?: boolean }>;
  };
  if (o.scopeType === "fleet" && cost.fleetProjected != null) {
    const usd = (n: number) => `$${n.toFixed(2)}/mo`;
    facts.push({ label: "Proj. cost", value: usd(cost.fleetProjected), delta: null });
    if (cost.fleetMeasured != null)
      // divergence = measured/projected; surface how far measured runs under/over projected (signed %).
      facts.push({
        label: "Measured",
        value: usd(cost.fleetMeasured),
        delta: cost.fleetDivergence != null ? signed(Math.round((cost.fleetDivergence - 1) * 100), "%") : null,
      });
    const top = cost.notable?.[0];
    if (top?.projected != null && top.name) {
      const name = top.name.length > 26 ? `${top.name.slice(0, 25)}…` : top.name;
      facts.push({ label: "Top cost", value: usd(top.projected), delta: `${top.divergenceFlag ? "⚠ " : ""}${name}` });
    }
  }
  return facts;
}

// AI narrative (Layer 3). FLAGGED DEP: 404 → null (endpoint not enabled / not generated
// yet → the card hides). scope=fleet, or scope=monitor&key=<checkId>.
export async function getNarrative(
  scope: "fleet" | "monitor",
  window: ReportWindow,
  key?: number,
): Promise<Narrative | null> {
  try {
    const raw = await request<Record<string, unknown>>("/reports/narrative", {
      scope,
      window,
      key: scope === "monitor" ? key : undefined,
    });
    if (!raw || !raw.headline) return null; // empty/unusable response → hide
    return {
      scope: (raw.scope as Narrative["scope"]) ?? scope,
      window: String(raw.window ?? window),
      headline: String(raw.headline),
      body: String(raw.body ?? ""),
      highlights: Array.isArray(raw.highlights) ? (raw.highlights as string[]) : [],
      factPack: toFactChips(raw.factPack),
      generatedAt: raw.generatedAt == null ? null : String(raw.generatedAt),
      stale: Boolean(raw.stale),
    };
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null;
    throw err;
  }
}

export async function getPerformanceReport(
  window: ReportWindow,
  groupBy: string,
  tags: Tag[] = [],
): Promise<PerformanceReport | null> {
  try {
    const raw = await request<Record<string, unknown>>("/reports/performance", { window, groupBy, tag: tagParams(tags) });
    const groups = ((raw?.groups as Record<string, unknown>[]) ?? []).map((g) => {
      // ★ The API NESTS latency under `latency` and web-vitals (p75) under `webVitals` — they are NOT flat
      // on the group, and per-check uses `checkName` + a nested `latency`. Reading flat (g.p50Ms / wv.lcpMs
      // / c.p50Ms / c.name) silently nulled every percentile + vital + blanked names → the reports page's
      // "windowed" latency never populated (it always fell back to the 24h metrics). Anchored by a contract
      // test now (the missing test let this ship).
      // ★ P9 Stage 3 — INP + resource_count ARE now aggregated (feat/vitals-report-inp-resource); the prior
      // "INP intentionally absent (never captured)" belief was FALSE (INP is captured on ~52% of runs) and is
      // why the whole chain dropped it. Read the Stage-2 fields below (inpP75Ms/inpCount/resourceCount, +
      // the existing sampleCount) — all `?? null`, so this self-degrades to honest "no data" (never crashes,
      // never fakes a 0).
      const lat = (g.latency ?? {}) as Record<string, unknown>;
      const wv = g.webVitals as Record<string, unknown> | null | undefined;
      const rawChecks = (g.checks as Record<string, unknown>[]) ?? [];
      const checks = rawChecks.map((c) => {
        const cl = (c.latency ?? {}) as Record<string, unknown>;
        return {
          check_id: c.checkId as number,
          name: String(c.checkName ?? ""),
          avg_ms: (cl.avgMs as number) ?? null,
          p50_ms: (cl.p50Ms as number) ?? null,
          p95_ms: (cl.p95Ms as number) ?? null,
          p99_ms: (cl.p99Ms as number) ?? null,
        };
      });
      return {
        group: String(g.group ?? "ungrouped"),
        avg_ms: (lat.avgMs as number) ?? null,
        p50_ms: (lat.p50Ms as number) ?? null,
        p95_ms: (lat.p95Ms as number) ?? null,
        p99_ms: (lat.p99Ms as number) ?? null,
        series: mapSeries(g.series as RawReportSeriesPoint[]),
        web_vitals: wv
          ? {
              lcp_ms: (wv.lcpP75Ms as number) ?? null,
              fcp_ms: (wv.fcpP75Ms as number) ?? null,
              ttfb_ms: (wv.ttfbP75Ms as number) ?? null,
              cls: (wv.clsP75 as number) ?? null,
              // ★ P9 Stage 3: null-defensive — absent → null → the UI shows honest "no data".
              inp_ms: (wv.inpP75Ms as number) ?? null,
              inp_count: (wv.inpCount as number) ?? null,
              // Stage 2 (#147) shipped `resource_count` → resourceCount (the earlier resourceCountP75 hedge is
              // a now-dead branch, removed in #168; verified against the live endpoint).
              resource_count: (wv.resourceCount as number) ?? null,
              vitals_count: (wv.sampleCount as number) ?? null,
            }
          : null,
        browser_check_count: (g.browserCheckCount as number) ?? rawChecks.filter((c) => c.webVitals != null).length,
        check_count: (g.checkCount as number) ?? checks.length,
        checks,
      };
    });
    return { window, group_by: String(raw?.groupBy ?? groupBy), groups };
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null;
    throw err;
  }
}

/** GET /api/sla?window= — per-check availability + server fleet rollup. */
export async function getSla(window: SlaWindow = "24h"): Promise<SlaResponse> {
  const raw = await request<RawSlaResponse>("/sla", { window });
  return {
    window,
    items: (raw.items ?? []).map(mapSla),
    fleet: mapFleet(raw.fleet),
  };
}

// GET /api/reports/deploys?host=&window= (deploy-markers v1). Auto-detected deploy markers for a host, for the
// chart overlay. ★ null-safe: no host → null; maps ALL rows; sha stays null for a non-commit marker (honest).
export async function getDeploys(host: string, window: ReportWindow = "30d"): Promise<DeploysReport | null> {
  if (!host) return null;
  let raw: Record<string, unknown>;
  try {
    raw = await request<Record<string, unknown>>("/reports/deploys", { host, window });
  } catch (err) {
    // ★ 404 = feature genuinely absent (endpoint/table not migrated) → null (no overlay, correct). A
    // 500/network/parse error is NOT "absent" — rethrow so the caller can surface it (loud, not silent).
    if (err instanceof ApiRequestError && err.status === 404) return null;
    throw err; // no overlay + the SWR error is visible to useDeployMarks (chart stays; caption shows)
  }
  const deploys = ((raw?.deploys as Record<string, unknown>[]) ?? []).map((d) => ({
    sha: d.sha == null ? null : String(d.sha),
    is_sha: Boolean(d.isSha),
    source: String(d.source ?? ""),
    deployed_at: String(d.deployedAt ?? ""),
  }));
  return { host: String(raw?.host ?? host), window: String(raw?.window ?? window), deploys };
}

// GET /api/reports/egress?window=all|24h — per-region egress-IP soak: the current IP(s) to allowlist +
// distinct-IP rotation monitor. ★ null-safe (mirrors getDeploys): 404 / endpoint-not-deployed → null so the
// /status section self-hides. Maps ALL regions + their per-IP first/last-seen; camel→snake.
export async function getEgressReport(window: EgressWindow = "all"): Promise<EgressReport | null> {
  let raw: Record<string, unknown>;
  try {
    raw = await request<Record<string, unknown>>("/reports/egress", { window });
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null; // absent → self-hide (correct)
    throw err; // 500/network → surface a loud error, not a silent blank (the incident-day failure mode)
  }
  const str = (v: unknown) => String(v ?? "");
  const num = (v: unknown) => Number(v ?? 0);
  const mapIp = (d: Record<string, unknown>): EgressIp => ({
    ip: str(d.ip),
    first_seen: str(d.firstSeen),
    last_seen: str(d.lastSeen),
    run_count: num(d.runCount),
  });
  const regions = ((raw?.regions as Record<string, unknown>[]) ?? []).map((r) => {
    const ips = ((r.ips as Record<string, unknown>[]) ?? []).map(mapIp);
    // ★ The API sends first/last-seen + run counts PER IP, NOT at the region level (confirmed by the captured
    // real fixture — region rows carry only location/currentIps/distinctCount/ips). Reading r.firstSeen /
    // r.lastSeen / r.runCount produced ""/""/0 in prod, so the "N runs · stable since …" region summary was
    // blank. Derive the rollup from the IPs — sum of runs, earliest first_seen, latest last_seen (ISO strings
    // sort lexically). The e2e mock sets its region-level values to exactly these aggregates, so its output is
    // unchanged. Anchored by egress.contract.ts.
    const firsts = ips.map((x) => x.first_seen).filter(Boolean);
    const lasts = ips.map((x) => x.last_seen).filter(Boolean);
    return {
      location: str(r.location),
      current_ips: ((r.currentIps as unknown[]) ?? []).map((x) => String(x)),
      distinct_count: num(r.distinctCount),
      first_seen: firsts.length ? firsts.reduce((a, b) => (a < b ? a : b)) : "",
      last_seen: lasts.length ? lasts.reduce((a, b) => (a > b ? a : b)) : "",
      run_count: ips.reduce((s, x) => s + x.run_count, 0),
      ips,
    };
  });
  return { window: str(raw?.window ?? window), regions };
}

// GET /api/reports/region-health (api #168 — the F-4 pair): per-region run freshness, the visible alarm
// for a silently-dead region. ★ 404 → null → the /status section self-hides (pre-deploy env); any other
// error THROWS → loud ErrorState (an alarm panel going silently blank is the exact F-4 failure mode).
const REGION_HEALTH_STATUSES: readonly RegionHealthStatus[] = ["fresh", "stale", "never_reported"];

export async function getRegionHealth(): Promise<RegionHealthReport | null> {
  let raw: Record<string, unknown>;
  try {
    raw = await request<Record<string, unknown>>("/reports/region-health");
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null; // absent → self-hide (correct)
    throw err; // 500/network → surface loudly, never a silent blank
  }
  const nullable = (v: unknown) => (v == null ? null : Number(v));
  const regions: RegionHealthRow[] = ((raw?.regions as Record<string, unknown>[]) ?? []).map((r) => ({
    // The API serves the region name as `location` (confirmed by the captured real fixture; the e2e mock now
    // serves `location` too). Reading `region` produced "" for every row in prod — blank labels + empty
    // testids + duplicate React keys. Anchored by region-health.contract.ts.
    region: String(r.location ?? ""),
    last_run_at: r.lastRunAt == null ? null : String(r.lastRunAt),
    age_seconds: nullable(r.ageSeconds),
    // ★ FAIL-SAFE-LOUD taxonomy coercion: an off-taxonomy/absent status must NEVER render as healthy —
    // this panel IS the alarm, so unknown coerces to "stale" (alarm), the opposite direction of the
    // trust chips' neutral fallback. A benign false alarm beats a silent dead region.
    status: (REGION_HEALTH_STATUSES as readonly string[]).includes(String(r.status))
      ? (r.status as RegionHealthStatus)
      : "stale",
  }));
  return { regions };
}

// GET /api/reports/trust?window= (§D1 fleet scorecard) + /reports/trust/{id}?window= (detail + daily retry
// series). ★ null-safe (mirrors getSloReport/getEgressReport): 404 → null → the page/card self-hides. Renders
// the API's rule-derived `trust` chip verbatim (no client-side re-derivation); redTest is an explicit gap.
const TRUST_CHIPS = ["proven-live", "flaky", "nominal", "unverified"] as const;
const TRUST_DIM_STATES = ["ok", "elevated", "flaky"] as const;
// Coerce one dimension state; unknown/absent (pre-deploy API) → "ok" so the strip reads clean, forward-compatible.
const dimState = (v: unknown) =>
  (TRUST_DIM_STATES as readonly string[]).includes(String(v)) ? (v as TrustDimensions["flap"]) : "ok";

function mapTrustRow(r: Record<string, unknown>): TrustRow {
  const num = (v: unknown) => Number(v ?? 0);
  const nul = (v: unknown) => (v == null ? null : Number(v));
  const inc = (r.incidents ?? {}) as Record<string, unknown>;
  const sp = (r.specProvenance ?? {}) as Record<string, unknown>;
  const rt = (r.redTest ?? {}) as Record<string, unknown>;
  const dim = (r.dimensions ?? {}) as Record<string, unknown>;
  const dimObj = (k: string) => ((dim[k] ?? {}) as Record<string, unknown>).state;
  return {
    check_id: num(r.checkId),
    check_name: String(r.checkName ?? ""),
    sensitive: Boolean(r.sensitive),
    last_green_at: r.lastGreenAt == null ? null : String(r.lastGreenAt),
    last_run_at: r.lastRunAt == null ? null : String(r.lastRunAt),
    run_count: num(r.runCount),
    retry_count: num(r.retryCount),
    retry_rate: nul(r.retryRate), // null preserved → "—", never a fake 0%
    retried_passes: num(r.retriedPasses), // absent (pre-deploy API) → 0 → annotation hidden; forward-compatible
    flap_count: num(r.flapCount), // confirmation-retry P2: transient failures; absent (pre-deploy) → 0 → hidden
    scheduled_count: num(r.scheduledCount),
    flap_rate: nul(r.flapRate), // null preserved → "—", never a fake 0%
    incidents: {
      total: num(inc.total),
      real_outage: num(inc.realOutage),
      flaky_transient: num(inc.flakyTransient),
      selector_drift: num(inc.selectorDrift),
      environment_regional: num(inc.environmentRegional),
      perf_regression: num(inc.perfRegression),
      unclassified: num(inc.unclassified),
    },
    red_test_captured: Boolean(rt.captured), // true only when a harness-confirmed red_tests row exists
    red_test_tested_at: rt.testedAt == null ? null : String(rt.testedAt),
    red_test_method: rt.method == null ? null : String(rt.method),
    spec_provenance: {
      executed_sha256: sp.executedSha256 == null ? null : String(sp.executedSha256),
      spec_path: sp.specPath == null ? null : String(sp.specPath),
    },
    // ★ B3-2: the distinct per-dimension states. Absent (pre-deploy API) → each "ok" → the strip reads clean
    // (forward-compatible); the chip itself still comes through verbatim below.
    dimensions: {
      flap: dimState(dimObj("flap")),
      retry: dimState(dimObj("retry")),
      monitor_noise: dimState(dimObj("monitorNoise")),
    },
    // Coerce to a known chip; an unknown/absent value → "unverified" (null-safe, never crashes the table).
    trust: (TRUST_CHIPS as readonly string[]).includes(String(r.trust)) ? (r.trust as TrustChip) : "unverified",
  };
}

export async function getTrustReport(window: ReportWindow = "30d"): Promise<TrustReport | null> {
  let raw: Record<string, unknown>;
  try {
    raw = await request<Record<string, unknown>>("/reports/trust", { window });
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null; // absent → self-hide (correct)
    throw err; // 500/network → the scorecard shows a loud error, not a blank (silent on incident day)
  }
  const monitors = ((raw?.monitors as Record<string, unknown>[]) ?? []).map(mapTrustRow);
  return { window: String(raw?.window ?? window), monitors };
}

export async function getTrustDetail(checkId: number, window: ReportWindow = "30d"): Promise<TrustDetail | null> {
  let raw: Record<string, unknown>;
  try {
    raw = await request<Record<string, unknown>>(`/reports/trust/${checkId}`, { window });
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null; // absent → card self-hides (correct)
    throw err; // 500/network → the trust card shows a loud error, not a silent blank
  }
  const m = raw?.monitor as Record<string, unknown> | null | undefined;
  if (!m) return null;
  const nul = (v: unknown) => (v == null ? null : Number(v));
  const retry_series = ((raw?.retrySeries as Record<string, unknown>[]) ?? []).map((p) => ({
    day: String(p.day ?? ""),
    run_count: Number(p.runCount ?? 0),
    retry_count: Number(p.retryCount ?? 0),
    retry_rate: nul(p.retryRate), // null when run_count 0 → a gap, never 0
  }));
  return { window: String(raw?.window ?? window), monitor: mapTrustRow(m), retry_series };
}

// GET /api/status (§A3) — the internal/stakeholder status page: per-PROPERTY current state + uptime + recent
// incidents. ★ Maps ALL rows (the map-all lesson); null-safe (uptime stays null while building; state coerced
// to a known value; missing arrays → []). Returns null on 404 → the page shows an empty state.
export async function getStatus(): Promise<StatusPage | null> {
  let raw: Record<string, unknown>;
  try {
    raw = await request<Record<string, unknown>>("/status");
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null; // absent → section self-hides (correct)
    throw err; // 500/network → the by-property section shows a loud error, not a silent blank
  }
  const num = (v: unknown) => Number(v ?? 0);
  const nullable = (v: unknown) => (v == null ? null : Number(v));
  const STATES = ["up", "degraded", "down", "unknown"] as const;
  const properties = ((raw?.properties as Record<string, unknown>[]) ?? []).map((p) => ({
    name: String(p.name ?? ""),
    state: (STATES.includes(p.state as (typeof STATES)[number]) ? p.state : "unknown") as StatusProperty["state"],
    check_count: num(p.checkCount),
    up_count: num(p.upCount),
    degraded_count: num(p.degradedCount),
    down_count: num(p.downCount),
    uptime_pct: nullable(p.uptimePct),
    building_baseline: Boolean(p.buildingBaseline),
  }));
  const recent_incidents = ((raw?.recentIncidents as Record<string, unknown>[]) ?? []).map((i) => ({
    property: String(i.property ?? ""),
    title: String(i.title ?? ""),
    opened_at: String(i.openedAt ?? ""),
    resolved_at: i.resolvedAt ? String(i.resolvedAt) : null,
    status: String(i.status ?? ""),
    severity: String(i.severity ?? ""),
  }));
  return { window: String(raw?.window ?? "30d"), properties, recent_incidents };
}

// GET /api/reports/slo?window=&tag= (P5 v1, companion API PR). Fleet error-budget — per-check budget rows +
// a fleet rollup, mirroring /sla (items + fleet + insufficient_data). Budget accounting only; burn_rate is
// informational. ★ Maps ALL rows (the map-all lesson) + composes with the ?tag= filter (undefined when empty).

export async function getSloReport(window: ReportWindow, tags: Tag[] = []): Promise<SloReport | null> {
  let raw: Record<string, unknown>;
  try {
    raw = await request<Record<string, unknown>>("/reports/slo", { window, tag: tagParams(tags) });
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null; // absent → section hides (correct)
    throw err; // 500/network → the error-budget panel shows a loud error, not a silent blank
  }
  const num = (v: unknown) => Number(v ?? 0);
  const nullable = (v: unknown) => (v == null ? null : Number(v));
  const items = ((raw?.items as Record<string, unknown>[]) ?? []).map((r) => ({
    check_id: Number(r.checkId),
    check_name: String(r.checkName ?? ""),
    kind: (r.kind as SloReport["items"][number]["kind"]) ?? "http",
    target: num(r.target),
    budget: num(r.budget),
    consumed: num(r.consumed),
    remaining: num(r.remaining),
    remaining_pct: nullable(r.remainingPct),
    burn_rate: nullable(r.burnRate),
    // ★ P5 PR2 — null-safe: default to 'none'/0 if the field is absent (older API / the .tone-crash lesson).
    burn_state: (r.burnState === "fast" || r.burnState === "slow" ? r.burnState : "none") as SloReport["items"][number]["burn_state"],
    reported_burn: num(r.reportedBurn),
    completed_runs: num(r.completedRuns),
    insufficient_data: Boolean(r.insufficientData),
  }));
  const f = raw?.fleet as Record<string, unknown> | null | undefined;
  const fleet = f
    ? {
        budget: num(f.budget),
        consumed: num(f.consumed),
        remaining: num(f.remaining),
        remaining_pct: nullable(f.remainingPct),
        insufficient_data: Boolean(f.insufficientData),
      }
    : null;
  return { window, items, fleet };
}

// GET /api/reports/cost (synthwatch-api #198) — ESTIMATED monthly ACA compute cost per monitor + fleet.
// Grounded projection (recon #220/#229), NOT the Azure bill. Every figure traces to a real input; the rate
// is ECHOED (rateUsed/rateSource/rateSetDate) so the UI shows provenance instead of hardcoding a drifting rate.
function mapCostCheck(r: Record<string, unknown>): CostCheck {
  const num = (v: unknown) => Number(v ?? 0);
  const nul = (v: unknown) => (v == null ? null : Number(v));
  return {
    check_id: num(r.checkId),
    source_key: r.sourceKey == null ? null : String(r.sourceKey),
    name: String(r.name ?? ""),
    kind: (r.kind as CostCheck["kind"]) ?? "http",
    interval_seconds: num(r.intervalSeconds),
    region_count: num(r.regionCount),
    avg_duration_s: nul(r.avgDurationS), // null = no runs in window → projection unavailable (never a fake 0)
    projected_monthly: num(r.projectedMonthly),
    measured_monthly_7d: num(r.measuredMonthly7d),
    divergence_ratio: nul(r.divergenceRatio),
    divergence_flag: Boolean(r.divergenceFlag),
    // 0078 run-count columns — tolerant of an API that predates them (→ 0, and the divergence copy
    // gracefully backs the run count out of divergence×expected instead).
    run_count_7d: num(r.runCount7d),
    confirmation_count_7d: num(r.confirmationCount7d),
    sandbox_count_7d: num(r.sandboxCount7d),
    run_count_recent: num(r.runCountRecent),
    run_count_prior: num(r.runCountPrior),
  };
}

export async function getCostReport(): Promise<CostReport | null> {
  let raw: Record<string, unknown>;
  try {
    raw = await request<Record<string, unknown>>("/reports/cost");
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null; // absent → cost UI self-hides
    throw err; // 500/network → a loud error, never a silent/blank cost figure
  }
  const arr = (v: unknown) => ((v as Record<string, unknown>[]) ?? []).map(mapCostCheck);
  return {
    generated_at: String(raw?.generatedAt ?? ""),
    rate_used: Number(raw?.rateUsed ?? 0),
    rate_source: String(raw?.rateSource ?? ""),
    rate_set_date: String(raw?.rateSetDate ?? ""),
    total_projected_monthly: Number(raw?.totalProjectedMonthly ?? 0),
    total_measured_monthly: Number(raw?.totalMeasuredMonthly ?? 0),
    top_cost_drivers: arr(raw?.topCostDrivers),
    checks: arr(raw?.checks),
  };
}

// GET /api/reports/mttr?window=&tag= (§A5, companion API PR). Fleet incident analytics — MTTR (mean+median
// over RESOLVED incidents), classification breakdown, trend. ★ Maps ALL rows/buckets (the map-all lesson) +
// null-safe (mean/median stay null on insufficient data; missing arrays → []). ?tag= composes (undefined when empty).
export async function getMttrReport(window: ReportWindow, tags: Tag[] = []): Promise<MttrReport | null> {
  let raw: Record<string, unknown>;
  try {
    raw = await request<Record<string, unknown>>("/reports/mttr", { window, tag: tagParams(tags) });
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null; // absent → section hides (correct)
    throw err; // 500/network → the incident-analytics panel shows a loud error, not a silent blank
  }
  const num = (v: unknown) => Number(v ?? 0);
  const nullable = (v: unknown) => (v == null ? null : Number(v));
  const items = ((raw?.items as Record<string, unknown>[]) ?? []).map((r) => ({
    check_id: Number(r.checkId),
    check_name: String(r.checkName ?? ""),
    kind: (r.kind as MttrReport["items"][number]["kind"]) ?? "http",
    resolved_count: num(r.resolvedCount),
    open_count: num(r.openCount),
    mean_seconds: nullable(r.meanSeconds),
    median_seconds: nullable(r.medianSeconds),
    mttd_proxy_seconds: nullable(r.mttdProxySeconds),
    insufficient_data: Boolean(r.insufficientData),
  }));
  const f = raw?.fleet as Record<string, unknown> | null | undefined;
  const fleet = f
    ? {
        resolved_count: num(f.resolvedCount),
        open_count: num(f.openCount),
        total_incidents: num(f.totalIncidents),
        mean_seconds: nullable(f.meanSeconds),
        median_seconds: nullable(f.medianSeconds),
        mttd_proxy_seconds: nullable(f.mttdProxySeconds),
        insufficient_data: Boolean(f.insufficientData),
      }
    : null;
  const classification = ((raw?.classification as Record<string, unknown>[]) ?? []).map((c) => ({
    classification: String(c.classification ?? "unclassified"),
    count: num(c.count),
    pct_of_total: num(c.pctOfTotal),
  }));
  const trend = ((raw?.trend as Record<string, unknown>[]) ?? []).map((t) => ({
    bucket_start: String(t.bucketStart ?? ""),
    resolved_count: num(t.resolvedCount),
    mean_seconds: nullable(t.meanSeconds),
  }));
  return { window, fleet, items, classification, trend };
}

interface RawAvailabilityPoint {
  ts: string;
  availabilityPct: number | null;
  upRuns: number;
  downRuns: number;
}
interface RawAvailabilitySeries {
  window: string;
  bucket: string;
  points: RawAvailabilityPoint[];
}

/** GET /api/checks/{id}/availability-series — availability % over time for a window. */
export async function getAvailabilitySeries(
  id: number,
  window: SlaWindow = "24h",
): Promise<AvailabilitySeries> {
  const raw = await request<RawAvailabilitySeries>(`/checks/${id}/availability-series`, { window });
  return {
    window,
    bucket: raw.bucket === "day" ? "day" : "hour",
    points: (raw.points ?? []).map((p) => ({
      ts: p.ts,
      availability_pct: p.availabilityPct ?? null,
      up_runs: p.upRuns,
      down_runs: p.downRuns,
    })),
  };
}

// ─── writes (outgoing body snake→camel) ──────────────────────────────────────

/** POST /api/checks — create a check. */
export async function createCheck(input: CreateCheckInput): Promise<Check> {
  const raw = await request<RawCheck>("/checks", undefined, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(toCamelBody(input as Record<string, unknown>)),
  });
  return mapCheck(raw);
}

/** PATCH /api/checks/:id — edit / pause a check. */
export async function updateCheck(id: number, input: UpdateCheckInput): Promise<Check> {
  const raw = await request<RawCheck>(`/checks/${id}`, undefined, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(toCamelBody(input as Record<string, unknown>)),
  });
  return mapCheck(raw);
}

// ─── env PR-3: per-check override + the domain→env map management ──────────────────────────────────────────
export type EnvValue = "prod" | "staging" | "dev";

/** PUT /checks/{id}/environment — set the manual env override, or CLEAR it (null → revert to the derived env). */
export async function setEnvironmentOverride(id: number, environmentOverride: EnvValue | null): Promise<Check> {
  const raw = await request<RawCheck>(`/checks/${id}/environment`, undefined, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ environmentOverride }),
  });
  return mapCheck(raw);
}

/** One domain→env inference rule (env_domain_map). id for edit/delete; ordered by priority asc. */
export interface EnvDomainRule {
  id: number;
  pattern: string;
  environment: EnvValue;
  priority: number;
}
interface RawEnvDomainRule {
  id: number;
  pattern: string;
  environment: string;
  priority: number;
}
function mapEnvRule(r: RawEnvDomainRule): EnvDomainRule {
  return { id: r.id, pattern: r.pattern, environment: (r.environment as EnvValue) ?? "prod", priority: r.priority };
}

/** GET /env-domain-map — the ordered inference rules (priority asc, id asc — the runner's match order). */
export async function getEnvDomainMap(): Promise<EnvDomainRule[]> {
  const raw = await request<{ rules?: RawEnvDomainRule[] }>("/env-domain-map");
  return (raw.rules ?? []).map(mapEnvRule);
}

export interface EnvRuleInput {
  pattern: string;
  environment: EnvValue;
  priority?: number;
}

/** POST /env-domain-map — create a rule. */
export async function createEnvDomainRule(input: EnvRuleInput): Promise<EnvDomainRule> {
  const raw = await request<RawEnvDomainRule>("/env-domain-map", undefined, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return mapEnvRule(raw);
}

/** PUT /env-domain-map/{id} — replace a rule's pattern/environment/priority. */
export async function updateEnvDomainRule(id: number, input: EnvRuleInput): Promise<EnvDomainRule> {
  const raw = await request<RawEnvDomainRule>(`/env-domain-map/${id}`, undefined, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return mapEnvRule(raw);
}

/** DELETE /env-domain-map/{id}. */
export async function deleteEnvDomainRule(id: number): Promise<void> {
  await request<void>(`/env-domain-map/${id}`, undefined, { method: "DELETE" });
}

/** DELETE /api/checks/:id — soft delete by default; hard=true for permanent. */
export async function deleteCheck(id: number, hard = false): Promise<DeleteCheckResult> {
  await request<unknown>(`/checks/${id}`, { hard: hard ? true : undefined }, { method: "DELETE" });
  return { id, deleted: hard ? "hard" : "soft" };
}

// ─── auth (Phase 12 slice 3) — OTP login + session + editor management ────────────────────────────
// All /auth/* endpoints are anonymous (they're how you GET a token); the 401/403 interceptor skips them.
// request() attaches the bearer token automatically once a session is stored.

/** POST /api/auth/request-code — issue an OTP. Always the enumeration-safe message (display as-is). */
export async function authRequestCode(email: string): Promise<{ message: string }> {
  return request<{ message: string }>("/auth/request-code", undefined, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

/** POST /api/auth/verify — consume the code, mint a session. 400 (ApiRequestError) on bad/expired code. */
export async function authVerify(
  email: string,
  code: string,
): Promise<{ token: string; email: string; role: Role; expiresAt: string }> {
  return request("/auth/verify", undefined, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, code }),
  });
}

/** GET /api/auth/me — live {email, role} for the stored token, or null (no/invalid session). */
export async function authMe(): Promise<{ email: string; role: Role } | null> {
  try {
    return await request<{ email: string; role: Role }>("/auth/me");
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 401) return null;
    throw err;
  }
}

/** POST /api/auth/logout — revoke the current session server-side (idempotent; tolerate failure). */
export async function authLogout(): Promise<void> {
  try {
    await request<unknown>("/auth/logout", undefined, { method: "POST" });
  } catch {
    /* best-effort — the client clears its session regardless */
  }
}

/** POST /api/auth/request-access — enumeration-safe "request edit access" (display the message as-is). */
export async function authRequestAccess(email: string): Promise<{ message: string }> {
  return request<{ message: string }>("/auth/request-access", undefined, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

// ── editor (user) management — admin-only (the API enforces; these 403 for a non-admin) ──
export interface EditorRow {
  email: string;
  added_by: string;
  added_at: string;
}
export interface AccessRequestRow {
  email: string;
  requested_at: string;
  count: number;
}

interface RawEditor {
  email: string;
  addedBy: string;
  addedAt: string;
}
interface RawAccessRequest {
  email: string;
  requestedAt: string;
  count: number;
}

/** GET /api/editors — the editor allowlist (admin-only). */
export async function listEditors(): Promise<EditorRow[]> {
  const raw = await request<RawEditor[]>("/editors");
  return (raw ?? []).map((e) => ({ email: e.email, added_by: e.addedBy, added_at: e.addedAt }));
}

/** POST /api/editors — add an editor by email (admin-only). */
export async function addEditor(email: string): Promise<EditorRow> {
  const raw = await request<RawEditor>("/editors", undefined, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  return { email: raw.email, added_by: raw.addedBy, added_at: raw.addedAt };
}

/** DELETE /api/editors/{email} — remove an editor (admin-only). */
export async function removeEditor(email: string): Promise<void> {
  await request<unknown>(`/editors/${encodeURIComponent(email)}`, undefined, { method: "DELETE" });
}

/** GET /api/access-requests — pending edit-access requests, admin-only (excludes existing editors/admins). */
export async function listAccessRequests(): Promise<AccessRequestRow[]> {
  const raw = await request<RawAccessRequest[]>("/access-requests");
  return (raw ?? []).map((a) => ({ email: a.email, requested_at: a.requestedAt, count: a.count }));
}

/** DELETE /api/access-requests/{email} — dismiss a pending access request (admin-only). */
export async function dismissAccessRequest(email: string): Promise<void> {
  await request<unknown>(`/access-requests/${encodeURIComponent(email)}`, undefined, { method: "DELETE" });
}

// Reports P6 — GET /api/reports/incident-breakdown?window= . The verdict-taxonomy breakdown +
// alert-precision (real-outage / classified). Serves camelCase; `precision` is null when nothing's classified.
export async function getIncidentBreakdown(window: ReportWindow, tags: Tag[] = []): Promise<IncidentBreakdown | null> {
  try {
    const raw = await request<Record<string, unknown>>("/reports/incident-breakdown", { window, tag: tagParams(tags) });
    const buckets = ((raw?.buckets as Record<string, unknown>[]) ?? []).map((b) => ({
      classification: String(b.classification ?? "unclassified"),
      count: (b.count as number) ?? 0,
      pctOfTotal: (b.pctOfTotal as number) ?? 0,
    }));
    return {
      window: (raw?.window as ReportWindow) ?? window,
      total: (raw?.total as number) ?? 0,
      classified: (raw?.classified as number) ?? 0,
      unclassified: (raw?.unclassified as number) ?? 0,
      realOutages: (raw?.realOutages as number) ?? 0,
      precision: (raw?.precision as number) ?? null, // null on the wire → null here (honest empty)
      buckets,
    };
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null;
    throw err;
  }
}

// POST /api/checks/parse-intent — chat-to-prefill. Free text → a validated non-browser monitor suggestion.
// ★ Never creates: returns fields to PREFILL the create modal; the human reviews + clicks Create.
export async function getParseIntent(text: string): Promise<ParseIntentResult> {
  const raw = await request<Record<string, unknown>>("/checks/parse-intent", undefined, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const f = (raw?.fields as Record<string, unknown>) ?? null;
  const nc = f?.netConfig as Record<string, unknown> | null | undefined;
  const prefill: Partial<Check> | null = f
    ? {
        name: (f.name as string) ?? undefined,
        kind: (f.kind as CheckKind) ?? undefined,
        target_url: (f.targetUrl as string) ?? undefined,
        interval_seconds: (f.intervalSeconds as number) ?? undefined,
        timeout_ms: (f.timeoutMs as number) ?? undefined,
        cert_expiry_warn_days: (f.certExpiryWarnDays as number) ?? undefined,
        net_config: nc
          ? {
              recordType: (nc.recordType as DnsRecordType) ?? null,
              expectedValue: (nc.expectedValue as string) ?? null,
              port: (nc.port as number) ?? null,
            }
          : undefined,
      }
    : null;
  return {
    configured: (raw?.configured as boolean) ?? false,
    note: (raw?.note as string) ?? null,
    retryable: (raw?.retryable as boolean) ?? false,
    redirect: (raw?.redirect as string) ?? null,
    reason: (raw?.reason as string) ?? null,
    valid: (raw?.valid as boolean) ?? false,
    prefill,
    fieldErrors: (raw?.fieldErrors as Record<string, string>) ?? {},
    notes: (raw?.notes as string) ?? null,
  };
}
