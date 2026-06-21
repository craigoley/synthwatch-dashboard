/**
 * API response types — the JSON shapes the /api/* route handlers return and the
 * client components consume. These differ from the raw DB row types in
 * `db-types.ts` in two ways:
 *  1. timestamps are serialized to ISO strings over JSON (pg returns `Date`,
 *     `NextResponse.json` stringifies them);
 *  2. enum-like columns are typed as plain `string` in the generated db-types,
 *     but the runner constrains them — so we narrow them to unions HERE for the
 *     UI, since these literals drive colors/labels/segmented controls.
 *
 * Components import ONLY from here (and never from `db-types.ts` / `db.ts`),
 * which keeps the database client out of the React bundle.
 */

// ─── UI enums (runner-constrained; generated db-types calls these `string`) ────

export type CheckKind = "http" | "browser";
export type RunStatus = "running" | "pass" | "warn" | "fail" | "error";
export type RunStepStatus = "pass" | "fail" | "skip";
export type IncidentSeverity = "warning" | "critical";
export type IncidentStatus = "open" | "resolved";
export type LighthouseFormFactor = "mobile" | "desktop";
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

/** A check as configured (timestamps as ISO strings). */
export interface Check {
  id: number;
  name: string;
  kind: CheckKind;
  target_url: string;
  flow_name: string | null;
  method: string;
  expected_status: number;
  body_must_contain: string | null;
  interval_seconds: number;
  last_run_at: string | null;
  timeout_ms: number;
  failure_threshold: number;
  severity: string;
  enabled: boolean;
  created_at: string;
  lighthouse_enabled: boolean;
  lighthouse_interval_seconds: number | null;
  lighthouse_form_factor: string;
  perf_budget_lcp_ms: number | null;
  perf_budget_transfer_bytes: number | null;
}

/** One point in a card sparkline: recent run duration + outcome. */
export interface SparkPoint {
  t: string; // started_at ISO
  d: number | null; // duration_ms
  s: RunStatus;
}

/**
 * A check enriched with derived current status for the status grid.
 * `current_status` is the status of the latest run (null if never run).
 */
export interface CheckWithStatus extends Check {
  current_status: RunStatus | null;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_error_message: string | null;
  p50_ms: number | null;
  p95_ms: number | null;
  runs_24h: number;
  open_incident_count: number;
  max_open_severity: IncidentSeverity | null;
  spark: SparkPoint[];
}

export interface Run {
  id: number;
  check_id: number;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  http_status: number | null;
  error_message: string | null;
  failed_step: string | null;
  screenshot_url: string | null;
}

/** Check detail payload: the check plus its most recent runs. */
export interface CheckDetail {
  check: Check;
  recent_runs: Run[];
}

export interface RunStep {
  id: number;
  run_id: number;
  step_index: number;
  name: string;
  status: RunStepStatus;
  duration_ms: number;
  error_message: string | null;
  started_at: string;
}

/** A run_metrics row joined with its run timestamp, for time-series charts. */
export interface MetricPoint {
  run_id: number;
  captured_at: string;
  started_at: string;
  status: RunStatus;
  ttfb_ms: number | null;
  dom_content_loaded_ms: number | null;
  load_event_ms: number | null;
  fcp_ms: number | null;
  lcp_ms: number | null;
  transfer_bytes: number | null;
  resource_count: number | null;
  dom_node_count: number | null;
  js_heap_bytes: number | null;
  cpu_time_ms: number | null;
  layout_count: number | null;
  recalc_style_count: number | null;
}

export interface IncidentWithCheck {
  id: number;
  check_id: number;
  status: string;
  severity: IncidentSeverity;
  opened_at: string;
  resolved_at: string | null;
  opened_run_id: number | null;
  resolved_run_id: number | null;
  consecutive_failures: number;
  summary: string | null;
  check_name: string;
  check_kind: CheckKind;
}

/** Paginated run history. */
export interface RunsPage {
  runs: Run[];
  total: number;
  limit: number;
  offset: number;
}

export interface IncidentsResponse {
  open: IncidentWithCheck[];
  resolved: IncidentWithCheck[];
}

export interface ApiError {
  error: string;
  details?: unknown;
}
