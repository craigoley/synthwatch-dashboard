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
  ReportSeriesPoint,
  AvailabilityReport,
  PerformanceReport,
  Narrative,
  NarrativeFact,
  DriftType,
  DriftRow,
  ReconcileDrift,
  SpecCatalog,
  SpecCatalogEntry,
  Check,
  CheckAuth,
  CheckDetail,
  CheckKind,
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

type QueryValue = string | number | boolean | null | undefined;

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
      if (value !== null && value !== undefined) qs.set(key, String(value));
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
): Promise<T> {
  const res = await fetch(buildUrl(path, params), {
    ...init,
    headers: { accept: "application/json", ...init?.headers },
  });

  if (!res.ok) {
    let body: { error?: string; message?: string; details?: unknown } = {};
    try {
      body = await res.json();
    } catch {
      /* non-JSON error body */
    }
    throw new ApiRequestError(
      body.message ?? body.error ?? `Request failed (${res.status})`,
      res.status,
      body.details,
    );
  }

  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
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
  lastRunAt: string | null;
  createdAt: string;
}

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

interface RawSeriesPoint { date: string; value: number | null }
const mapSeries = (s?: RawSeriesPoint[] | null): ReportSeriesPoint[] =>
  (s ?? []).map((p) => ({ date: p.date, value: p.value ?? null }));

export async function getAvailabilityReport(
  window: ReportWindow,
  groupBy: string,
): Promise<AvailabilityReport | null> {
  try {
    const raw = await request<Record<string, unknown>>("/reports/availability", { window, groupBy });
    const groups = ((raw?.groups as Record<string, unknown>[]) ?? []).map((g) => ({
      group: String(g.group ?? "ungrouped"),
      availability_pct: (g.availabilityPct as number) ?? null,
      downtime_minutes: (g.downtimeMinutes as number) ?? 0,
      incident_count: (g.incidentCount as number) ?? 0,
      check_count: (g.checkCount as number) ?? 0,
      series: mapSeries(g.series as RawSeriesPoint[]),
      checks: ((g.checks as Record<string, unknown>[]) ?? []).map((c) => ({
        check_id: c.checkId as number,
        name: String(c.name ?? ""),
        kind: c.kind as CheckKind,
        availability_pct: (c.availabilityPct as number) ?? null,
        downtime_minutes: (c.downtimeMinutes as number) ?? 0,
        incident_count: (c.incidentCount as number) ?? 0,
      })),
    }));
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
): Promise<PerformanceReport | null> {
  try {
    const raw = await request<Record<string, unknown>>("/reports/performance", { window, groupBy });
    const groups = ((raw?.groups as Record<string, unknown>[]) ?? []).map((g) => {
      const wv = g.webVitals as Record<string, unknown> | null | undefined;
      return {
        group: String(g.group ?? "ungrouped"),
        avg_ms: (g.avgMs as number) ?? null,
        p50_ms: (g.p50Ms as number) ?? null,
        p95_ms: (g.p95Ms as number) ?? null,
        p99_ms: (g.p99Ms as number) ?? null,
        series: mapSeries(g.series as RawSeriesPoint[]),
        // null when the group has no browser checks → the UI renders NO vitals.
        // ★ INP is intentionally absent (never captured) — not mapped at all.
        web_vitals: wv
          ? {
              lcp_ms: (wv.lcpMs as number) ?? null,
              fcp_ms: (wv.fcpMs as number) ?? null,
              ttfb_ms: (wv.ttfbMs as number) ?? null,
              cls: (wv.cls as number) ?? null,
            }
          : null,
        browser_check_count: (g.browserCheckCount as number) ?? 0,
        check_count: (g.checkCount as number) ?? 0,
        checks: ((g.checks as Record<string, unknown>[]) ?? []).map((c) => ({
          check_id: c.checkId as number,
          name: String(c.name ?? ""),
          kind: c.kind as CheckKind,
          avg_ms: (c.avgMs as number) ?? null,
          p50_ms: (c.p50Ms as number) ?? null,
          p95_ms: (c.p95Ms as number) ?? null,
          p99_ms: (c.p99Ms as number) ?? null,
        })),
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
