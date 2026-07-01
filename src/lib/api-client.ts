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
  DeploysReport,
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
  MetricPoint,
  Run,
  RunStatus,
  RunStep,
  RunStepStatus,
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
 * Resolve an origin-relative proxy path (e.g. "/api/runs/1/screenshot") to an
 * absolute URL — for direct browser loads like <img src> and download links that
 * bypass the typed request() helper. These paths already include the "/api"
 * segment, so they resolve against the API ORIGIN (not API_BASE, which itself
 * ends in "/api" — concatenating would double it). Already-absolute URLs pass
 * through; empty base = same-origin.
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
      //   401 (expired/invalid session) → drop the session + signal a re-login prompt.
      //   403 (valid session, wrong role) → signal a permission message; do NOT clear (they ARE logged in).
      if (!path.startsWith("/auth/")) {
        if (res.status === 401) {
          clearSession();
          emitAuthEvent({ type: "unauthorized" });
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
    created_at: raw.createdAt,
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
  // eslint-disable-next-line no-console
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
  recurrence: RawRecurrence[] | null;
}

/** GET /api/incidents/{id} — the incident investigation payload. */
export async function getIncident(id: number): Promise<IncidentDetail> {
  const raw = await request<RawIncidentDetail>(`/incidents/${id}`);
  return {
    id: raw.id,
    check_id: raw.checkId,
    check_name: raw.checkName,
    check_kind: raw.checkKind,
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
    recurrence: (raw.recurrence ?? []).map((r) => ({
      id: r.id,
      opened_at: r.openedAt,
      resolved_at: r.resolvedAt,
      status: r.status,
      summary: r.summary,
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
export async function runCheckNow(id: number): Promise<{ requestId: number }> {
  return request<{ requestId: number }>(`/checks/${id}/run`, undefined, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
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
      // test now (the missing test let this ship). INP is intentionally absent (never captured).
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

// GET /api/reports/slo?window=&tag= (P5 v1, companion API PR). Fleet error-budget — per-check budget rows +
// a fleet rollup, mirroring /sla (items + fleet + insufficient_data). Budget accounting only; burn_rate is
// informational. ★ Maps ALL rows (the map-all lesson) + composes with the ?tag= filter (undefined when empty).
// GET /api/reports/deploys?host=&window= (deploy-markers v1). Auto-detected deploy markers for a host, for the
// chart overlay. ★ null-safe: no host → null; maps ALL rows; sha stays null for a non-commit marker (honest).
export async function getDeploys(host: string, window: ReportWindow = "30d"): Promise<DeploysReport | null> {
  if (!host) return null;
  let raw: Record<string, unknown>;
  try {
    raw = await request<Record<string, unknown>>("/reports/deploys", { host, window });
  } catch {
    return null; // endpoint not deployed / deploys table not migrated yet → no overlay
  }
  const deploys = ((raw?.deploys as Record<string, unknown>[]) ?? []).map((d) => ({
    sha: d.sha == null ? null : String(d.sha),
    is_sha: Boolean(d.isSha),
    source: String(d.source ?? ""),
    deployed_at: String(d.deployedAt ?? ""),
  }));
  return { host: String(raw?.host ?? host), window: String(raw?.window ?? window), deploys };
}

export async function getSloReport(window: ReportWindow, tags: Tag[] = []): Promise<SloReport | null> {
  let raw: Record<string, unknown>;
  try {
    raw = await request<Record<string, unknown>>("/reports/slo", { window, tag: tagParams(tags) });
  } catch {
    return null; // endpoint not deployed yet (companion API PR) → the section hides gracefully
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

// GET /api/reports/mttr?window=&tag= (§A5, companion API PR). Fleet incident analytics — MTTR (mean+median
// over RESOLVED incidents), classification breakdown, trend. ★ Maps ALL rows/buckets (the map-all lesson) +
// null-safe (mean/median stay null on insufficient data; missing arrays → []). ?tag= composes (undefined when empty).
export async function getMttrReport(window: ReportWindow, tags: Tag[] = []): Promise<MttrReport | null> {
  let raw: Record<string, unknown>;
  try {
    raw = await request<Record<string, unknown>>("/reports/mttr", { window, tag: tagParams(tags) });
  } catch {
    return null; // endpoint not deployed yet (companion API PR) → the section hides gracefully
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
