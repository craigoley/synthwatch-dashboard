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
export type RunStepStatus = "pass" | "fail" | "error" | "running" | "skip";
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
  /** Monitors-as-code (Phase 13): the manifest id this check was activated from; null for hand-made. */
  source_key: string | null;
  /** The manifest spec path; non-null → the runner fetches+runs the Git spec (Option C). */
  spec_path: string | null;
  /** Last-known-good success-trace baseline timestamp (migration 0039); null = none yet. When set
   *  (browser checks), the monitor page shows "View last success trace". */
  success_trace_at: string | null;
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
  /**
   * Attempts taken to reach this run's verdict (runner migration 0048). 1 = clean first try; >1 = settled
   * after fast-retry. null for pre-telemetry runs. A `pass` with retry_count > 1 is "degrading-but-green" —
   * the monitor only passes on retry — surfaced as a soft-warning in the run row.
   */
  retry_count: number | null;
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

/**
 * One cursor-paginated page of run history. Mirrors the API's CursorPage envelope:
 * `next_cursor` is an opaque token to pass back as the next request's cursor, and is
 * null once the date-range window is exhausted. No total — counting an append-only
 * table is the unbounded scan the cursor design avoids.
 */
export interface RunsPage {
  runs: Run[];
  next_cursor: string | null;
  page_size: number;
}

/** One cursor-paginated page of incidents — same CursorPage envelope as RunsPage, keyed on opened_at. */
export interface IncidentsPage {
  incidents: IncidentWithCheck[];
  next_cursor: string | null;
  page_size: number;
}

/**
 * A relative look-back preset for the shared date-range control (runs, incidents). `custom`
 * carries explicit from/to; a preset resolves to from = now − N days. Shared so every
 * cursor+date-range surface uses one control.
 */
export type CursorRangePreset = "7d" | "30d" | "90d";

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

/** A tag-routing rule: checks carrying (tagKey,tagValue) also route to channelId. */
export interface TagRule {
  tagKey: string;
  tagValue: string;
  channelId: number;
}

/**
 * Routing config. Field names match the API exactly: `severity` (per-severity
 * defaults), `perCheck` (per-check overrides, keyed by checkId), `tagRules`
 * (tag:value → channel). ALL-ADDITIVE: an alert fires to the UNION of all three,
 * deduped by channel id (the runner's resolveChannels semantics, #85). The API
 * serves the maps as null when empty.
 */
export interface Routing {
  severity: Record<string, RoutingRule>;
  perCheck: Record<string, RoutingRule>;
  tagRules: TagRule[];
}

// ─── reporting (Layer 2): availability + performance, grouped by tag, windowed ──
export type ReportWindow = "7d" | "30d" | "90d";

/** One point in a daily report time-series (date = YYYY-MM-DD). */
export interface ReportSeriesPoint {
  date: string;
  value: number | null;
}

/** Per-check row inside an availability group's drill-down. */
export interface AvailabilityCheckRow {
  check_id: number;
  name: string;
  availability_pct: number | null;
  downtime_minutes: number;
  incident_count: number;
}

/** One group (a tag value, or "ungrouped") in the availability report. */
export interface AvailabilityGroup {
  group: string;
  availability_pct: number | null;
  downtime_minutes: number;
  incident_count: number;
  check_count: number;
  /** Daily availability% over the window. */
  series: ReportSeriesPoint[];
  checks: AvailabilityCheckRow[];
}

export interface AvailabilityReport {
  window: ReportWindow;
  group_by: string; // "team" | "service" | "env" | "criticality" | "none"
  groups: AvailabilityGroup[];
}

/**
 * Browser-only web vitals. Latency (duration) is universal, but vitals are captured
 * ONLY for browser checks — so this is null for groups with no browser checks (the
 * UI then renders NO vitals). ★ INP is never captured: it is omitted entirely (no field).
 */
export interface WebVitals {
  lcp_ms: number | null;
  fcp_ms: number | null;
  ttfb_ms: number | null;
  cls: number | null;
}

export interface PerformanceCheckRow {
  check_id: number;
  name: string;
  avg_ms: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
}

export interface PerformanceGroup {
  group: string;
  avg_ms: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  /** Daily p95 latency over the window. */
  series: ReportSeriesPoint[];
  /** Web vitals for the BROWSER checks in this group; null if the group has none. */
  web_vitals: WebVitals | null;
  /** How many of the group's checks are browser checks (for "covers only the browser subset"). */
  browser_check_count: number;
  check_count: number;
  checks: PerformanceCheckRow[];
}

export interface PerformanceReport {
  window: ReportWindow;
  group_by: string;
  groups: PerformanceGroup[];
}

// ─── reporting Layer 3: AI narrative (GET /api/reports/narrative) ─────────────
/** One cited figure behind the prose (auditability): the actual number + optional delta. */
export interface NarrativeFact {
  label: string;
  value: string;
  /** e.g. "+15%" / "-3pp"; raw string, shown neutrally beside the prose. */
  delta?: string | null;
}

/**
 * An AI-generated summary for a scope (fleet, or one monitor). `body` is markdown;
 * `factPack` are the figures the prose cites (rendered as audit chips). `generatedAt`
 * + `stale` drive the freshness hint. Card HIDES entirely when there's no narrative.
 */
export interface Narrative {
  scope: "fleet" | "monitor";
  window: string;
  headline: string;
  body: string;
  highlights: string[];
  factPack: NarrativeFact[];
  generatedAt: string | null;
  stale: boolean;
}

// ─── monitors-as-code drift (GET /api/reconcile/drift, Phase 6b) ──────────────
/**
 * What the reconcile found differs between Git (the synthwatch-monitors manifest) and the live monitors.
 * The reconcile is READ-ONLY (report mode) — it never applies. Two classes (the UI labels them apart):
 *  - new | changed | missing → resolvable CONFIG drift ("monitor config differs from Git"; apply WOULD fix).
 *  - orphan → a KNOWN GAP: Git defines a monitor the runner can't run yet (browser spec-exec deferred).
 *    NOT a failure — render it informationally/neutrally, visually distinct from the config-drift trio.
 */
export type DriftType = "new" | "changed" | "missing" | "orphan";

/**
 * One drift row. `source_key` is the monitor's manifest id. `detail` is the runner-written jsonb passed
 * through verbatim; its shape varies by type (e.g. a `changed` row carries
 * `{ fields: { name: { git, live }, … } }`, an `orphan` carries `{ flow_name, reason }`).
 */
export interface DriftRow {
  source_key: string;
  drift_type: DriftType;
  detail: Record<string, unknown>;
  detected_at: string;
}

/** The latest reconcile snapshot. Empty `items` = live monitors are in sync with Git. */
export interface ReconcileDrift {
  items: DriftRow[];
  /** When the last reconcile ran (latest detected_at), null when there's no drift. */
  detected_at: string | null;
}

// ─── spec catalog (GET /api/specs, Phase 13 — read-only inventory) ────────────
/**
 * Coverage state of a spec, derived from whether a check is bound to it (by source_key):
 *  - `unmonitored` — no check → not set up yet (the activation target, in a later PR).
 *  - `active` — a check exists and is enabled (running).
 *  - `paused` — a check exists but is disabled.
 * Orthogonal to runnability (a spec can be unmonitored+orphan, or active+orphan).
 */
export type SpecCoverage = "unmonitored" | "active" | "paused";

/** Per-check health for a MONITORED spec (null when unmonitored). */
export interface SpecHealth {
  /** Latest run's status (or null if never run). Coverage carries Active/Paused separately. */
  current_status: RunStatus | null;
  p95_ms: number | null;
  open_incident_count: number;
  last_run_at: string | null;
}

/**
 * One catalog row: a manifest spec joined to the live check (if any) that activated it. Two orthogonal
 * dimensions drive the UI — coverage (unmonitored/active/paused) and runnable (✓ / ⚠ orphan + reason).
 */
export interface SpecCatalogEntry {
  source_key: string;
  name: string;
  spec_path: string;
  kind: string;
  /** Suggested defaults from the manifest (for the later activation form). */
  target: string | null;
  suggested_interval_seconds: number | null;
  tags: string[];
  description: string | null;
  enabled_by_default: boolean;
  /** Runnability probe: fetchable+compilable from main. false → orphan (see not_runnable_reason). */
  runnable: boolean;
  not_runnable_reason: string | null;
  /** Coverage join. monitored=false → unmonitored; else check_id/check_name/enabled are set. */
  monitored: boolean;
  check_id: number | null;
  check_name: string | null;
  enabled: boolean | null;
  health: SpecHealth | null;
}

/** The latest spec catalog. Empty `items` = the reconcile job hasn't populated it yet. */
export interface SpecCatalog {
  items: SpecCatalogEntry[];
  /** When the last reconcile populated the catalog (latest probe time), null when empty. */
  probed_at: string | null;
}

// ─── Trace AI insights (slice 3 — consumes POST /api/runs/{id}/ai-insights) ──────────────────────────
// On-demand AOAI analysis of a run's Playwright trace. The endpoint is gated (editor/admin) and
// inert-until-configured (the AOAI deploy prereq), so the client normalizes its non-fatal states.

export type AiInsightSeverity = "critical" | "high" | "medium" | "low" | "info";
export type AiInsightConfidence = "high" | "medium" | "low";
/** Whether a finding is the site's own code, an embedded third party, or undetermined (honesty over guessing). */
export type AiInsightScope = "site" | "third_party" | "unknown";

export interface AiInsight {
  severity: AiInsightSeverity;
  confidence: AiInsightConfidence;
  title: string;
  detail: string;
  /** The specific trace signal the finding is based on (a request, a console line, a payload size). */
  evidence: string | null;
  scope: AiInsightScope | null;
}

export interface AiInsights {
  summary: string;
  performance: AiInsight[];
  network: AiInsight[];
  errors: AiInsight[];
  suggestions: AiInsight[];
  /** Honesty notes that MUST be surfaced (SPA Web Vitals unreliable, not a Lighthouse audit, …). */
  caveats: string[];
}

/**
 * Normalized result of POST /runs/{id}/ai-insights — the UI's non-happy states made explicit:
 *  - ok: insights to render.
 *  - not_configured: 200, AI not set up yet (the live state until the AOAI deploy prereq). NOT an error.
 *  - unavailable: the API RESPONDED (200, configured:true) but produced no insights — an AOAI/backend-side
 *      failure ("ran but couldn't generate insights for this run").
 *  - transport_error: we never got a USABLE response — the fetch rejected (network/edge/DNS/TLS), timed out,
 *      or returned a non-2xx without our error shape. The request likely never reached the API. Kept DISTINCT
 *      from `unavailable` so a transient transport blip is legible (conflating the two cost hours). Retryable.
 * (401/403 are handled by the global auth interceptor before this resolves.)
 */
export type AiInsightsResult =
  | { status: "ok"; insights: AiInsights }
  | { status: "not_configured"; message: string }
  | { status: "unavailable"; message: string }
  | { status: "transport_error"; message: string };

// ─── Location comparison: baseline-diff (consumes POST /api/runs/{id}/baseline-diff) ─────────────────
// "Why does this run fail when the last-known-good baseline passed?" — the canonicalized DELTA between
// the failing run's trace signals and the monitor's success-trace baseline, + an AI comparison.
// ★ HONEST framing: it compares the failing run vs the BASELINE, NOT directly vs the passing location
// (passing runs have no trace). Mirrors the ai-insights non-fatal states + adds the regional-cause taxonomy.

export type BaselineDiffCause =
  | "regional-waf-cdn"
  | "network-allowlist"
  | "geo-dns"
  | "region-timeout"
  | "third-party-blocked"
  | "flaky-transient"
  | "undetermined";

/**
 * The PRIMARY classification (which LAYER failed) — synthwatch-api #118. The at-a-glance signal that
 * separates a real outage from a false-negative red: site-failure (the site broke) vs
 * monitor-verification-bug (the monitor's own verification broke; the site may be fine) vs transient vs
 * undetermined. Distinct from `likelyCause` (the finer regional taxonomy). null on legacy/pre-#118 insights.
 */
export type BaselineDiffVerdict =
  | "site-failure"
  | "monitor-verification-bug"
  | "transient"
  | "undetermined";

/** A console line in the delta: error/warning, the site's own vs an embedded third party, and the text. */
export interface DiffConsoleLine {
  level: string;
  origin: string; // "site" | "third-party"
  text: string;
}

/** The structured delta the UI shows (what differs between the failing run and the baseline). */
export interface BaselineDiff {
  failing: { runId: number; location: string | null; status: string };
  baseline: { source: string; capturedAt: string | null };
  console: { onlyInThisRun: DiffConsoleLine[]; onlyInBaseline: DiffConsoleLine[]; shared: number };
  network: {
    totalRequestsThisRun: number;
    totalRequestsBaseline: number;
    failedHostsOnlyInThisRun: string[];
    thirdPartyOnlyInThisRun: { host: string; count: number; kb: number }[];
  };
}

/** The AI comparison over the delta — a categorized regional cause + the honest flakiness call. */
export interface BaselineDiffInsight {
  summary: string;
  /** Primary layer-failed classification (#118). null on legacy insights → no verdict badge. */
  verdict: BaselineDiffVerdict | null;
  likelyCause: BaselineDiffCause;
  confidence: AiInsightConfidence;
  isFlaky: boolean;
  findings: AiInsight[];
  caveats: string[];
}

/**
 * Normalized result of POST /runs/{id}/baseline-diff. The DIFF is present for every non-transport state
 * (it needs no AOAI), so the UI always shows what differs; the INSIGHT only when configured + produced.
 *  - ok: diff + a parsed insight.
 *  - not_configured: diff present, AOAI not set up yet (NOT an error).
 *  - unavailable: configured, but the model produced nothing (retryable iff transient).
 *  - transport_error: never got a usable response (no diff).
 */
export type BaselineDiffResult =
  | { status: "ok"; diff: BaselineDiff; insight: BaselineDiffInsight }
  | { status: "not_configured"; diff: BaselineDiff; message: string }
  | { status: "unavailable"; diff: BaselineDiff; message: string; retryable: boolean }
  | { status: "transport_error"; message: string };
