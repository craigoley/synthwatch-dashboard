/**
 * SynthWatch database type contract.
 *
 * This file is the COMMIT-TIME contract between the dashboard and the schema
 * that the synthwatch runner owns. It is normally generated from the live
 * database with pg-to-ts:
 *
 *     pnpm gen:types        # reads $DATABASE_URL, writes this file
 *
 * It is COMMITTED on purpose and is NOT regenerated during the Vercel build —
 * the build must never require a database connection. Regenerate it locally
 * (against the shared Azure Postgres) whenever the runner changes the schema,
 * review the diff, and commit it.
 *
 * The shape below mirrors pg-to-ts output: a `Select` interface and an `Input`
 * interface per table, plus a per-table descriptor. Enum-like text columns are
 * narrowed to string unions because the runner constrains them.
 *
 * Generated/maintained for tables: checks, runs, run_steps, run_metrics, incidents.
 */

// ─── checks ──────────────────────────────────────────────────────────────────

export type CheckKind = "http" | "browser";
export type LighthouseFormFactor = "mobile" | "desktop";

export interface Checks {
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
  last_run_at: Date | null;
  lighthouse_enabled: boolean;
  lighthouse_interval_seconds: number | null;
  lighthouse_form_factor: LighthouseFormFactor | null;
  perf_budget_lcp_ms: number | null;
  perf_budget_transfer_bytes: number | null;
}

export interface ChecksInput {
  id?: number;
  name: string;
  kind: CheckKind;
  target_url?: string | null;
  flow?: string | null;
  interval_seconds: number;
  timeout_ms: number;
  latency_warn_ms?: number | null;
  enabled?: boolean;
  failure_threshold: number;
  last_run_at?: Date | null;
  lighthouse_enabled?: boolean;
  lighthouse_interval_seconds?: number | null;
  lighthouse_form_factor?: LighthouseFormFactor | null;
  perf_budget_lcp_ms?: number | null;
  perf_budget_transfer_bytes?: number | null;
}

const checks = {
  tableName: "checks",
  columns: [
    "id",
    "name",
    "kind",
    "target_url",
    "flow",
    "interval_seconds",
    "timeout_ms",
    "latency_warn_ms",
    "enabled",
    "failure_threshold",
    "last_run_at",
    "lighthouse_enabled",
    "lighthouse_interval_seconds",
    "lighthouse_form_factor",
    "perf_budget_lcp_ms",
    "perf_budget_transfer_bytes",
  ],
  requiredForInsert: ["name", "kind", "interval_seconds", "timeout_ms", "failure_threshold"],
  primaryKey: "id",
  foreignKeys: {},
  $type: null as unknown as Checks,
  $input: null as unknown as ChecksInput,
} as const;

// ─── runs ────────────────────────────────────────────────────────────────────

export type RunStatus = "running" | "pass" | "warn" | "fail" | "error";

export interface Runs {
  id: number;
  check_id: number;
  started_at: Date;
  finished_at: Date | null;
  status: RunStatus;
  duration_ms: number | null;
  runner_id: string | null;
  error_message: string | null;
  artifact_url: string | null;
}

export interface RunsInput {
  id?: number;
  check_id: number;
  started_at?: Date;
  finished_at?: Date | null;
  status: RunStatus;
  duration_ms?: number | null;
  runner_id?: string | null;
  error_message?: string | null;
  artifact_url?: string | null;
}

const runs = {
  tableName: "runs",
  columns: [
    "id",
    "check_id",
    "started_at",
    "finished_at",
    "status",
    "duration_ms",
    "runner_id",
    "error_message",
    "artifact_url",
  ],
  requiredForInsert: ["check_id", "status"],
  primaryKey: "id",
  foreignKeys: { check_id: { table: "checks", column: "id" } },
  $type: null as unknown as Runs,
  $input: null as unknown as RunsInput,
} as const;

// ─── run_steps ───────────────────────────────────────────────────────────────

export type RunStepStatus = "pass" | "fail" | "skip";

export interface RunSteps {
  id: number;
  run_id: number;
  step_index: number;
  label: string;
  status: RunStepStatus;
  duration_ms: number | null;
  detail: string | null;
}

export interface RunStepsInput {
  id?: number;
  run_id: number;
  step_index: number;
  label: string;
  status: RunStepStatus;
  duration_ms?: number | null;
  detail?: string | null;
}

const run_steps = {
  tableName: "run_steps",
  columns: ["id", "run_id", "step_index", "label", "status", "duration_ms", "detail"],
  requiredForInsert: ["run_id", "step_index", "label", "status"],
  primaryKey: "id",
  foreignKeys: { run_id: { table: "runs", column: "id" } },
  $type: null as unknown as RunSteps,
  $input: null as unknown as RunStepsInput,
} as const;

// ─── run_metrics ─────────────────────────────────────────────────────────────

export interface RunMetrics {
  run_id: number;
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
  captured_at: Date | null;
}

export interface RunMetricsInput {
  run_id: number;
  ttfb_ms?: number | null;
  dom_content_loaded_ms?: number | null;
  load_event_ms?: number | null;
  fcp_ms?: number | null;
  lcp_ms?: number | null;
  transfer_bytes?: number | null;
  resource_count?: number | null;
  dom_node_count?: number | null;
  js_heap_bytes?: number | null;
  cpu_time_ms?: number | null;
  layout_count?: number | null;
  recalc_style_count?: number | null;
  captured_at?: Date | null;
}

const run_metrics = {
  tableName: "run_metrics",
  columns: [
    "run_id",
    "ttfb_ms",
    "dom_content_loaded_ms",
    "load_event_ms",
    "fcp_ms",
    "lcp_ms",
    "transfer_bytes",
    "resource_count",
    "dom_node_count",
    "js_heap_bytes",
    "cpu_time_ms",
    "layout_count",
    "recalc_style_count",
    "captured_at",
  ],
  requiredForInsert: ["run_id"],
  primaryKey: "run_id",
  foreignKeys: { run_id: { table: "runs", column: "id" } },
  $type: null as unknown as RunMetrics,
  $input: null as unknown as RunMetricsInput,
} as const;

// ─── incidents ───────────────────────────────────────────────────────────────

export type IncidentSeverity = "warning" | "critical";

export interface Incidents {
  id: number;
  check_id: number;
  opened_at: Date;
  resolved_at: Date | null;
  severity: IncidentSeverity;
  summary: string | null;
}

export interface IncidentsInput {
  id?: number;
  check_id: number;
  opened_at?: Date;
  resolved_at?: Date | null;
  severity: IncidentSeverity;
  summary?: string | null;
}

const incidents = {
  tableName: "incidents",
  columns: ["id", "check_id", "opened_at", "resolved_at", "severity", "summary"],
  requiredForInsert: ["check_id", "severity"],
  primaryKey: "id",
  foreignKeys: { check_id: { table: "checks", column: "id" } },
  $type: null as unknown as Incidents,
  $input: null as unknown as IncidentsInput,
} as const;

// ─── table registry ──────────────────────────────────────────────────────────

export interface TableTypes {
  checks: { select: Checks; input: ChecksInput };
  runs: { select: Runs; input: RunsInput };
  run_steps: { select: RunSteps; input: RunStepsInput };
  run_metrics: { select: RunMetrics; input: RunMetricsInput };
  incidents: { select: Incidents; input: IncidentsInput };
}

export const tables = { checks, runs, run_steps, run_metrics, incidents } as const;
