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
  // The API can report a check-level status outside the run taxonomy (e.g.
  // "paused" for a disabled check). Fall back to a neutral meta so an unexpected
  // value never crashes the grid.
  return (
    RUN_STATUS[status] ?? {
      label: (status as string) === "paused" ? "Paused" : "No data",
      token: "idle",
      dotClass: "sw-dot-idle",
    }
  );
}

// run_steps.status is a plain string in the DB; map known values, default idle.
export function stepStatusToken(status: RunStepStatus | string): StatusMeta["token"] {
  switch (status) {
    case "pass":
      return "pass";
    case "fail":
    case "error":
      return "fail";
    case "running":
      return "running";
    default:
      return "idle"; // skip / pending
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

/**
 * Standard Core Web Vitals (+ supporting paint/network) thresholds → status token. null = no reading (idle).
 * Sources: web.dev Core Web Vitals (2026).
 *   LCP  (ms): ≤2500 good · ≤4000 needs-improvement · >4000 poor   (Core Web Vital)
 *   CLS      : ≤0.1  good · ≤0.25 needs-improvement · >0.25 poor   (Core Web Vital)
 *   INP  (ms): ≤200  good · ≤500  needs-improvement · >500  poor   (Core Web Vital)
 *   FCP  (ms): ≤1800 good · ≤3000 needs-improvement · >3000 poor   (supporting metric)
 *   TTFB (ms): ≤800  good · ≤1800 needs-improvement · >1800 poor   (supporting metric)
 */
export function cwvTone(
  metric: "lcp" | "cls" | "inp" | "fcp" | "ttfb",
  value: number | null | undefined,
): StatusMeta["token"] {
  if (value === null || value === undefined || Number.isNaN(value)) return "idle";
  const bands: Record<typeof metric, [number, number]> = {
    lcp: [2500, 4000],
    cls: [0.1, 0.25],
    inp: [200, 500],
    fcp: [1800, 3000],
    ttfb: [800, 1800],
  };
  const [good, ni] = bands[metric];
  if (value <= good) return "pass";
  if (value <= ni) return "warn";
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
