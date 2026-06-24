/**
 * API response types — the snake_case JSON shapes the components consume. The
 * api-client (src/lib/api-client.ts) adapts the C# API's camelCase responses
 * into these shapes. Notes:
 *  1. timestamps are ISO strings over JSON;
 *  2. enum-like columns are narrowed to unions HERE for the UI, since these
 *     literals drive colors/labels/segmented controls.
 *
 * Components import their data types ONLY from here.
 */

// ─── UI enums (runner-constrained; generated db-types calls these `string`) ────

export type CheckKind = "http" | "browser" | "ssl" | "dns" | "tcp" | "ping" | "multistep";

export type DnsRecordType = "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS";

/**
 * Per-kind network config (the host comes from target_url). The API returns a
 * normalized camelCase object with all keys (nulls for the irrelevant ones):
 *   dns  → { recordType, expectedValue }   (port null)
 *   tcp  → { port }                         (port required)
 *   ping → { port }                         (defaults to 443 when null)
 */
export interface NetConfig {
  recordType: DnsRecordType | null;
  expectedValue: string | null;
  port: number | null;
}

// ── HTTP assertion model (no-code) ───────────────────────────────────────────
export type AssertionSource = "status" | "response_time" | "header" | "body" | "json_path" | "size";
export type AssertionComparison =
  | "eq"
  | "ne"
  | "lt"
  | "gt"
  | "gte"
  | "lte"
  | "contains"
  | "not_contains"
  | "matches"
  | "exists"
  | "one_of";

export interface Assertion {
  source: AssertionSource;
  comparison: AssertionComparison;
  /** Header name (source=header) or JSONPath expr (source=json_path). */
  target?: string | null;
  /** Expected value; array for one_of; ignored for exists. */
  expected?: unknown;
}

/** Pull a value from a step's JSON response into a named var, referenced later as {{var}}. */
export interface ExtractRule {
  var: string;
  jsonPath: string;
}

/**
 * One step of a multistep (kind="multistep") API chain. The request shape mirrors
 * a single http check; url/headers/body may contain {{var}} templates resolved
 * from earlier steps' extracts. auth is a secret-ref ([[CheckAuth]], *_env only).
 */
export interface ChainStep {
  name: string;
  method?: HttpMethod | null;
  url: string;
  headers?: Record<string, string> | null;
  body?: string | null;
  auth?: CheckAuth | null;
  assertions?: Assertion[] | null;
  extract?: ExtractRule[] | null;
}

export type AuthType = "none" | "basic" | "bearer" | "api_key";

/**
 * Auth is a SECRET REFERENCE — the *_env fields hold the NAME of a runner env
 * var, never a raw credential. The runner resolves the value at request time.
 */
export interface CheckAuth {
  type: AuthType;
  token_env?: string | null; // bearer
  username?: string | null; // basic (not secret)
  password_env?: string | null; // basic
  header?: string | null; // api_key header name
  value_env?: string | null; // api_key
}
/** A key:value label on a check (Phase 9a). Keys/values are normalized lowercase. */
export interface Tag {
  key: string;
  value: string;
}

/** A distinct in-use tag with how many checks carry it (GET /api/tags → filter bar). */
export interface TagInUse extends Tag {
  count: number;
}

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
  /** SSL checks only: warn when the cert has <= this many days remaining. */
  cert_expiry_warn_days: number | null;
  /** Network checks (dns/tcp/ping): per-kind config; null otherwise. */
  net_config: NetConfig | null;
  /** HTTP checks: rich assertions (empty = legacy expected_status/body_must_contain). */
  assertions: Assertion[];
  request_headers: Record<string, string> | null;
  request_body: string | null;
  auth: CheckAuth | null;
  /** Multistep checks: ordered API-chain steps (null/empty otherwise). */
  steps: ChainStep[] | null;
  /** Opt-in SLO target + error-budget / burn-rate; null when no SLO is set. */
  slo: Slo | null;
  /** key:value tags (Phase 9a); empty until the tags API serves them. */
  tags: Tag[];
}

/**
 * SLO error-budget + burn-rate over a window (opt-in per check). Complements SLA
 * (availability %). `target` is a fraction (0.999 = 99.9%). `budget` is the
 * run-weighted error budget = (1-target)·total_runs; `consumed` = down runs;
 * `remaining` = budget − consumed (NEGATIVE = over budget / blown). `burnRate` is
 * normalized (1.0 = on track to exactly exhaust the budget); `fastBurn` (1h) /
 * `slowBurn` (6h) flag whether the multi-window burn alerts are firing.
 */
export interface Slo {
  target: number;
  budget: number;
  consumed: number;
  remaining: number;
  burnRate: number;
  fastBurn: boolean;
  slowBurn: boolean;
}

/** Latest status for one runner location (the check-list per-location rollup). */
export interface LocationStatus {
  location: string;
  status: RunStatus;
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
  /** SSL checks: days until cert expiry from the latest run (null otherwise). */
  last_cert_days_remaining: number | null;
  /** Per-location latest status rollup (single `default` entry for single-location). */
  locations: LocationStatus[];
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
  /** Runner location that produced this run ("default" for single-location checks). */
  location: string | null;
  /** Proxy path to the failure screenshot (image/png), or null. */
  screenshot_url: string | null;
  /** Proxy path to the Playwright trace (.zip download), or null. */
  trace_url: string | null;
  /** SSL runs: structured days-until-expiry (negative if expired; null otherwise). */
  cert_days_remaining: number | null;
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
  /** Cumulative Layout Shift (unitless). */
  cls: number | null;
  /** Interaction to Next Paint (ms); null when the load had no interaction. */
  inp_ms: number | null;
  transfer_bytes: number | null;
  resource_count: number | null;
  dom_node_count: number | null;
  js_heap_bytes: number | null;
  cpu_time_ms: number | null;
  layout_count: number | null;
  recalc_style_count: number | null;
}

/**
 * Root-cause analysis the runner attaches to an incident (incidents.rca JSONB).
 * The honesty structure is intentional: `observed` are facts the evidence shows,
 * `inferred` are the model's hypotheses — the UI must keep them visually distinct.
 */
export type RcaClassification =
  | "real-outage"
  | "flaky-transient"
  | "selector-drift"
  | "environment-regional"
  | "perf-regression";
export type RcaConfidence = "high" | "medium" | "low";
export interface IncidentRca {
  classification: RcaClassification;
  confidence: RcaConfidence;
  observed: string[];
  inferred: string[];
  summary: string;
  signature?: string;
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
  /** Runner root-cause analysis; null when not computed. */
  rca: IncidentRca | null;
}

/** One run in an incident's evidence timeline (GET /api/incidents/{id}). */
export interface IncidentTimelineRun {
  run_id: number;
  status: RunStatus;
  started_at: string;
  duration_ms: number | null;
  http_status: number | null;
  error_message: string | null;
  failed_step: string | null;
  screenshot_url: string | null;
  trace_url: string | null;
  location: string | null;
}

/** A prior/related incident on the same check (recurrence / flapping). */
export interface IncidentRecurrence {
  id: number;
  opened_at: string;
  resolved_at: string | null;
  status: string;
  summary: string | null;
}

/** Full incident investigation payload (GET /api/incidents/{id}). */
export interface IncidentDetail {
  id: number;
  check_id: number;
  check_name: string;
  check_kind: CheckKind;
  status: string;
  severity: IncidentSeverity;
  opened_at: string;
  resolved_at: string | null;
  consecutive_failures: number;
  summary: string | null;
  rca: IncidentRca | null;
  per_location: LocationStatus[];
  timeline: IncidentTimelineRun[];
  recurrence: IncidentRecurrence[];
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

/** Rolling SLA window backed by the sla_availability_<window> views. */
export type SlaWindow = "24h" | "7d" | "30d" | "90d";

/**
 * One row from the SLA endpoint — per-check availability over a rolling window.
 * `availability_pct` is null when the API marks the window `insufficient_data`
 * (not enough completed runs yet to report a meaningful number — distinct from a
 * real breach).
 */
export interface SlaRow {
  check_id: number;
  check_name: string;
  kind: CheckKind;
  window_from: string;
  window_to: string;
  completed_runs: number;
  up_runs: number;
  down_runs: number;
  availability_pct: number | null;
  insufficient_data: boolean;
}

/**
 * Server-computed (run-weighted) fleet rollup for a window. Replaces the old
 * client-side count summation. `availability_pct` is null when
 * `insufficient_data` is true.
 */
export interface SlaFleet {
  completed_runs: number;
  up_runs: number;
  down_runs: number;
  availability_pct: number | null;
  insufficient_data: boolean;
}

/** Full SLA response for one window. */
export interface SlaResponse {
  window: SlaWindow;
  items: SlaRow[];
  fleet: SlaFleet | null;
}

/** One bucket of the availability-over-time series. `availability_pct` null = no
 *  completed runs in that bucket (a GAP in the line, NOT a 0% dip). */
export interface AvailabilityPoint {
  ts: string;
  availability_pct: number | null;
  up_runs: number;
  down_runs: number;
}

/** GET /api/checks/{id}/availability-series — uptime shape over a window. */
export interface AvailabilitySeries {
  window: SlaWindow;
  bucket: "hour" | "day";
  points: AvailabilityPoint[];
}

export interface ApiError {
  error: string;
  details?: unknown;
}

/**
 * A flow from the runner-emitted manifest (the single source of truth for
 * browser flows, replacing distinct `checks.flow_name`). `/api/flows`.
 */
export interface Flow {
  name: string;
  description: string | null;
  entry_url_hint: string | null;
  updated_at: string;
}

// ─── alerting (dashboard-managed): channels + routing ────────────────────────
// Delivery TARGETS only — no transport credentials live here (email uses the ACS
// transport configured in infrastructure). `config` is JSONB-ish and passes
// through verbatim (nested camelCase), like check assertions/auth.
export type ChannelType = "email" | "webhook";

export interface ChannelConfig {
  /** email: recipients (the sender is transport env — ALERT_EMAIL_FROM — not a channel field) */
  to?: string[];
  /** webhook: target URL */
  url?: string | null;
  /** webhook: optional header sent to the target (e.g. "Authorization: Bearer …") */
  authHeader?: string | null;
}

export interface Channel {
  id: number;
  name: string;
  type: ChannelType;
  config: ChannelConfig;
  enabled: boolean;
}

/**
 * Routing severities — MUST match the API exactly: the routing endpoint only
 * accepts `critical | warning` and 400s on anything else. This is the
 * IncidentSeverity vocab, NOT the run-outcome vocab (fail/error/warn/resolved).
 * Tag-based routing is Phase 9.
 */
export type RoutingSeverity = "critical" | "warning";

export interface RoutingRule {
  channelIds: number[];
}

/**
 * Routing config. Field names match the API exactly: `severity` (per-severity
 * defaults) + `perCheck` (per-check overrides, keyed by checkId). The API serves
 * these as null when empty.
 */
export interface Routing {
  severity: Record<string, RoutingRule>;
  perCheck: Record<string, RoutingRule>;
}
