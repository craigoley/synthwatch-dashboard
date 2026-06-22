/**
 * Status → presentation metadata. Single source of truth for the status color
 * language used across the app: pass=green, warn=amber, fail/error=red.
 * Returns CSS-variable-backed token names defined in globals.css.
 */

import type { CheckWithStatus, IncidentSeverity, RunStatus, RunStepStatus } from "@/lib/types";

export interface StatusMeta {
  label: string;
  /** semantic token: drives --c-<token> color variables */
  token: "pass" | "warn" | "fail" | "running" | "idle";
  dotClass: string;
}

const RUN_STATUS: Record<RunStatus, StatusMeta> = {
  pass: { label: "Pass", token: "pass", dotClass: "sw-dot-pass" },
  warn: { label: "Warn", token: "warn", dotClass: "sw-dot-warn" },
  fail: { label: "Fail", token: "fail", dotClass: "sw-dot-fail" },
  error: { label: "Error", token: "fail", dotClass: "sw-dot-fail" },
  running: { label: "Running", token: "running", dotClass: "sw-dot-running" },
};

export function runStatusMeta(status: RunStatus | null): StatusMeta {
  if (!status) {
    return { label: "No data", token: "idle", dotClass: "sw-dot-idle" };
  }
  return RUN_STATUS[status];
}

// run_steps.status is a plain string in the DB; map known values, default idle.
export function stepStatusToken(status: RunStepStatus | string): StatusMeta["token"] {
  switch (status) {
    case "pass":
      return "pass";
    case "fail":
      return "fail";
    default:
      return "idle";
  }
}

export function severityMeta(sev: IncidentSeverity): StatusMeta {
  return sev === "critical"
    ? { label: "Critical", token: "fail", dotClass: "sw-dot-fail" }
    : { label: "Warning", token: "warn", dotClass: "sw-dot-warn" };
}

/**
 * SLA availability % → status token. Calm thresholds (not alarmist):
 * ≥ 99.9 pass (green), ≥ 99 warn (amber), below fail (red). Null = no data.
 */
export function availabilityTone(pct: number | null | undefined): StatusMeta["token"] {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return "idle";
  if (pct >= 99.9) return "pass";
  if (pct >= 99) return "warn";
  return "fail";
}

// ── Status-page (stakeholder) derivations ────────────────────────────────────

export type SystemStatus = "operational" | "partial" | "major";

export interface SystemStatusMeta {
  status: SystemStatus;
  label: string;
  token: "pass" | "warn" | "fail";
}

const SYSTEM_META: Record<SystemStatus, SystemStatusMeta> = {
  operational: { status: "operational", label: "All Systems Operational", token: "pass" },
  partial: { status: "partial", label: "Partial Outage", token: "warn" },
  major: { status: "major", label: "Major Outage", token: "fail" },
};

/**
 * Roll enabled checks into an overall system status for the public status page:
 *   major   — an open critical incident, or a critical service currently down
 *   partial — an open warning incident, a non-critical service down, or degraded
 *   operational — otherwise
 */
export function deriveSystemStatus(checks: CheckWithStatus[]): SystemStatusMeta {
  let partial = false;
  for (const c of checks) {
    if (!c.enabled) continue;
    const down = c.current_status === "fail" || c.current_status === "error";
    const degraded = c.current_status === "warn";
    const openCritical = c.open_incident_count > 0 && c.max_open_severity === "critical";
    const openWarning = c.open_incident_count > 0 && c.max_open_severity === "warning";

    if (openCritical || (down && c.severity === "critical")) return SYSTEM_META.major;
    if (openWarning || down || degraded) partial = true;
  }
  return partial ? SYSTEM_META.partial : SYSTEM_META.operational;
}

/** Friendly per-component (per-check) status for stakeholders. */
export function componentStatus(c: CheckWithStatus): { label: string; token: StatusMeta["token"] } {
  if (!c.enabled) return { label: "Paused", token: "idle" };
  switch (c.current_status) {
    case "fail":
    case "error":
      return { label: "Down", token: "fail" };
    case "warn":
      return { label: "Degraded", token: "warn" };
    case "pass":
    case "running":
      return { label: "Operational", token: "pass" };
    default:
      return { label: "No data", token: "idle" };
  }
}

/** Order used when sorting/grouping by run status severity (worst first). */
export function statusRank(status: RunStatus | null): number {
  switch (status) {
    case "error":
    case "fail":
      return 0;
    case "warn":
      return 1;
    case "running":
      return 2;
    case "pass":
      return 3;
    default:
      return 4;
  }
}
