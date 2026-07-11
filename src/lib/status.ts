/**
 * Status → presentation metadata. Single source of truth for the status color
 * language used across the app: pass=green, warn=amber, fail/error=red.
 * Returns CSS-variable-backed token names defined in globals.css.
 */

import type { CheckWithStatus, IncidentSeverity, RunStatus, RunStepStatus, SparkPoint } from "@/lib/types";
import { isNonProd } from "@/lib/env";

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
  // ★ infra_error (runner couldn't fetch the spec): distinct from a check 'error' and, per the runner, NEITHER
  // up nor down — excluded from SLA + never pages. So amber (warn), not red (fail): rendering it as a red
  // failure would misread an infra hiccup as a monitored-target outage. Distinguishable label + tone, adjacent.
  infra_error: { label: "Infra error", token: "warn", dotClass: "sw-dot-warn" },
  running: { label: "Running", token: "running", dotClass: "sw-dot-running" },
};

export function runStatusMeta(status: RunStatus | null): StatusMeta {
  if (!status) {
    return { label: "No data", token: "idle", dotClass: "sw-dot-idle" };
  }
  // The API can report a check-level status outside the run taxonomy (e.g.
  // "paused" for a disabled check, "archived" for an archived one — 0071, "removed" for a git-removed one
  // pending purge — 0072). Fall back to a neutral meta so an unexpected value never crashes the grid.
  return (
    RUN_STATUS[status] ??
    (((): StatusMeta => {
      const s = status as string;
      const label = s === "paused" ? "Paused" : s === "archived" ? "Archived" : s === "removed" ? "Removed" : "No data";
      return { label, token: "idle", dotClass: "sw-dot-idle" };
    })())
  );
}

// Git-removal purge window (runner RETENTION_DAYS / migration 0072). A git-removed check (removed_at set)
// is hard-deleted this many days after removal. Kept in sync with the runner's 90d blob-lifecycle clock.
export const PURGE_WINDOW_DAYS = 90;

// Days until a git-removed check is purged, from its removed_at timestamp. null when not removed.
// Clamped at 0 (an overdue-but-incident-deferred check reads "purging in 0 days", never negative).
export function daysUntilPurge(removedAt: string | null | undefined): number | null {
  if (!removedAt) return null;
  const removedMs = new Date(removedAt).getTime();
  if (Number.isNaN(removedMs)) return null;
  const purgeAt = removedMs + PURGE_WINDOW_DAYS * 86_400_000;
  return Math.max(0, Math.ceil((purgeAt - Date.now()) / 86_400_000));
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
 * Last SETTLED outcome for a check (not current_status) so a generally-passing monitor stays green
 * while a run is in flight — the live run shows via a separate affordance instead. Pure.
 *
 * When current_status is ALREADY settled (not "running") it IS the latest settled outcome — return it
 * directly, identical to the prior behavior, so non-running checks are unchanged even if `spark` is empty
 * (no regression). Only while running do we peel back to the most recent non-running `spark` point;
 * ISO timestamps sort lexically. Null when nothing has settled (brand-new / short-history monitor) → the
 * caller renders idle, never a fabricated pass.
 *
 * ★ SHARED (the #201/#206 card contract, hoisted from check-card.tsx): the card's rail/pill and the
 * header roll-up (deriveSystemStatus) must read the SAME settled value — two local copies would drift.
 */
export function lastSettledStatus(check: CheckWithStatus): RunStatus | null {
  if (check.current_status && check.current_status !== "running") return check.current_status;
  let latest: SparkPoint | null = null;
  for (const p of check.spark) {
    if (p.s === "running") continue;
    if (!latest || p.t > latest.t) latest = p;
  }
  return latest?.s ?? null;
}

/**
 * Roll enabled checks into an overall system status for the public status page:
 *   major   — an open critical incident, or a critical service currently down
 *   partial — an open warning incident, a non-critical service down, or degraded
 *   operational — otherwise
 *
 * ★ PROD-ONLY: non-prod (staging/preview) checks are excluded — the public banner is the PROD promise, and a
 * staging fail must never flip it (display-side pollution the API's aggregation exclude can't fix, since this
 * rolls up the raw /checks list). Env comes from the authoritative `checks.environment` column, not the tag.
 *
 * ★ RUNNING ≠ "no status": the tally reads lastSettledStatus (the #201/#206 card contract), so an in-flight
 * run neither drops a monitor from the banner nor clears a known-bad status — the banner only moves when a
 * run COMPLETES with a different settled result. A check that has NEVER settled (null) contributes nothing,
 * exactly as it did before it started running — never flipped green (the null-vs-green trap).
 */
export function deriveSystemStatus(checks: CheckWithStatus[]): SystemStatusMeta {
  let partial = false;
  for (const c of checks) {
    if (!c.enabled || isNonProd(c)) continue;
    const settled = lastSettledStatus(c);
    const down = settled === "fail" || settled === "error";
    const degraded = settled === "warn";
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
    case "infra_error": // non-paging, SLA-excluded → warn tier, not worst
      return 1;
    case "running":
      return 2;
    case "pass":
      return 3;
    default:
      return 4;
  }
}
