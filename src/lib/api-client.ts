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
  Check,
  CheckAuth,
  CheckDetail,
  CheckKind,
  CheckWithStatus,
  IncidentSeverity,
  IncidentsResponse,
  IncidentWithCheck,
  MetricPoint,
  Run,
  RunStatus,
  RunStep,
  RunStepStatus,
  RunsPage,
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
  assertions?: Assertion[] | null;
  requestHeaders?: Record<string, string> | null;
  requestBody?: string | null;
  auth?: CheckAuth | null;
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
  screenshotUrl: string | null;
  certDaysRemaining: number | null;
}

interface RawCheckDetail extends RawCheck {
  recentRuns: RawRun[];
}

interface RawRunsPage {
  items: RawRun[];
  page: number;
  pageSize: number;
  total: number;
}

interface RawMetric {
  runId: number;
  capturedAt: string;
  ttfbMs: number | null;
  domContentLoadedMs: number | null;
  loadEventMs: number | null;
  fcpMs: number | null;
  lcpMs: number | null;
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
    // JSONB columns: the API returns these verbatim (nested keys already in the
    // UI's shape — assertion {source,comparison,target,expected}, auth.token_env,
    // header dict), so pass them through unchanged.
    assertions: raw.assertions ?? [],
    request_headers: raw.requestHeaders ?? null,
    request_body: raw.requestBody ?? null,
    auth: raw.auth ?? null,
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
    screenshot_url: raw.screenshotUrl,
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
  limit?: number;
  offset?: number;
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

/** GET /api/checks/:id/runs — paginated run history. */
export async function getRuns(id: number, query: RunsQuery = {}): Promise<RunsPage> {
  const raw = await request<RawRunsPage>(`/checks/${id}/runs`, {
    limit: query.limit,
    offset: query.offset,
  });
  const pageSize = raw.pageSize || raw.items.length;
  return {
    runs: raw.items.map(mapRun),
    total: raw.total,
    limit: pageSize,
    offset: pageSize ? (raw.page - 1) * pageSize : 0,
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

/** GET /api/incidents — open + resolved incidents, split client-side. */
export async function listIncidents(): Promise<IncidentsResponse> {
  const raw = await request<RawIncident[]>("/incidents");
  const all = raw.map(mapIncident);
  return {
    open: all.filter((i) => i.resolved_at === null),
    resolved: all.filter((i) => i.resolved_at !== null),
  };
}

/** GET /api/flows — distinct non-null flow_name values. */
export async function listFlows(): Promise<string[]> {
  return request<string[]>("/flows");
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
