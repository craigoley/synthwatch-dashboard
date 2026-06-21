/**
 * Status → presentation metadata. Single source of truth for the status color
 * language used across the app: pass=green, warn=amber, fail/error=red.
 * Returns CSS-variable-backed token names defined in globals.css.
 */

import type { IncidentSeverity, RunStatus, RunStepStatus } from "@/lib/types";

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

export function stepStatusToken(status: RunStepStatus): StatusMeta["token"] {
  switch (status) {
    case "pass":
      return "pass";
    case "fail":
      return "fail";
    case "skip":
      return "idle";
  }
}

export function severityMeta(sev: IncidentSeverity): StatusMeta {
  return sev === "critical"
    ? { label: "Critical", token: "fail", dotClass: "sw-dot-fail" }
    : { label: "Warning", token: "warn", dotClass: "sw-dot-warn" };
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
