/**
 * API response types — the JSON shapes the /api/* route handlers return and the
 * client components consume. These differ from the raw DB row types in
 * `db-types.ts` in one important way: timestamps are serialized to ISO strings
 * over JSON (pg returns `Date`, `NextResponse.json` stringifies them).
 *
 * Components import ONLY from here (and never from `db-types.ts` / `db.ts`),
 * which keeps the database client out of the React bundle.
 */

import type {
  CheckKind,
  IncidentSeverity,
  LighthouseFormFactor,
  RunStatus,
  RunStepStatus,
} from "@/db-types";

export type {
  CheckKind,
  IncidentSeverity,
  LighthouseFormFactor,
  RunStatus,
  RunStepStatus,
};

/** A check as configured (timestamps as ISO strings). */
export interface Check {
  id: number;
  name: string;
  kind: CheckKind;
  target_url: string | null;
  flow: string | null;
  interval_seconds: number;
  timeout_ms: number;
  latency_warn_ms: number | null;
  enabled: boolean;
  failure_threshold: number;
  last_run_at: string | null;
  lighthouse_enabled: boolean;
  lighthouse_interval_seconds: number | null;
  lighthouse_form_factor: LighthouseFormFactor | null;
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
  started_at: string;
  finished_at: string | null;
  status: RunStatus;
  duration_ms: number | null;
  runner_id: string | null;
  error_message: string | null;
  artifact_url: string | null;
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
  label: string;
  status: RunStepStatus;
  duration_ms: number | null;
  detail: string | null;
}

/** A run_metrics row joined with its run timestamp, for time-series charts. */
export interface MetricPoint {
  run_id: number;
  captured_at: string | null;
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
  opened_at: string;
  resolved_at: string | null;
  severity: IncidentSeverity;
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
