import { test, expect } from "@playwright/test";

import { deriveSystemStatus, lastSettledStatus } from "@/lib/status";
import type { CheckWithStatus, RunStatus, SparkPoint } from "@/lib/types";

/**
 * Header roll-up × running checks — the settled-status contract (#201/#206, hoisted to the roll-up).
 * A running check contributes its LAST SETTLED outcome to the banner tally: it is neither dropped nor
 * does running CLEAR a known-bad status. Pre-fix, deriveSystemStatus read the live current_status, for
 * which "running" matched neither down nor degraded — a failing monitor vanished from the banner the
 * moment it started a re-run (banner flickered green mid-run). These pin the fixed tally, pure-node.
 */

const spark = (...points: [string, RunStatus][]): SparkPoint[] =>
  points.map(([t, s]) => ({ t, d: 100, s }));

function mk(over: Partial<CheckWithStatus>): CheckWithStatus {
  return {
    enabled: true,
    environment: "prod",
    severity: "warning",
    current_status: "pass",
    spark: [],
    open_incident_count: 0,
    max_open_severity: null,
    ...over,
  } as CheckWithStatus;
}

test.describe("deriveSystemStatus — running checks tally their settled status", () => {
  test("settled-pass + running → counted as pass, banner Operational (never flipped by a run)", () => {
    const c = mk({ current_status: "running", spark: spark(["2026-07-07T10:00:00Z", "pass"]) });
    expect(lastSettledStatus(c)).toBe("pass");
    expect(deriveSystemStatus([c]).status).toBe("operational");
  });

  test("★ MUST-GO-RED: settled-FAIL (critical) + running → still Major Outage (running does NOT clear known-bad)", () => {
    // Pre-fix: current_status "running" → down=false → this returned "operational" (the reported flicker).
    const c = mk({
      severity: "critical",
      current_status: "running",
      spark: spark(["2026-07-07T09:00:00Z", "pass"], ["2026-07-07T10:00:00Z", "fail"]),
    });
    expect(lastSettledStatus(c)).toBe("fail");
    expect(deriveSystemStatus([c]).status).toBe("major");
  });

  test("★ settled-WARN + running → still Partial (degraded survives an in-flight run)", () => {
    const c = mk({ current_status: "running", spark: spark(["2026-07-07T10:00:00Z", "warn"]) });
    expect(deriveSystemStatus([c]).status).toBe("partial");
  });

  test("never-settled + running → contributes NOTHING (null ≠ green; same as before it started running)", () => {
    // A brand-new check mid-first-run: no settled spark point → null → neither down nor degraded — and
    // critically NOT pass. Alone it yields operational (identical to its pre-run state), and it must not
    // mask or amplify anything: alongside a failing check the banner still reads the failure.
    const neverRun = mk({ current_status: "running", spark: spark(["2026-07-07T10:00:00Z", "running"]) });
    expect(lastSettledStatus(neverRun)).toBeNull();
    expect(deriveSystemStatus([neverRun]).status).toBe("operational");
    const failing = mk({ current_status: "fail" });
    expect(deriveSystemStatus([neverRun, failing]).status).toBe("partial");
  });

  test("run COMPLETES with a different result → the banner moves (the fix doesn't freeze the tally)", () => {
    // While running, the settled 'pass' holds the banner green; once the run lands as fail, the same
    // check (current_status now settled) drives partial — the running→settled transition still works.
    const during = mk({ current_status: "running", spark: spark(["2026-07-07T10:00:00Z", "pass"]) });
    expect(deriveSystemStatus([during]).status).toBe("operational");
    const after = mk({ current_status: "fail", spark: spark(["2026-07-07T10:00:00Z", "pass"], ["2026-07-07T10:05:00Z", "fail"]) });
    expect(deriveSystemStatus([after]).status).toBe("partial");
  });

  test("#228 env-guard intact: a running staging check with settled-FAIL still never touches the prod banner", () => {
    const staging = mk({
      environment: "staging",
      severity: "critical",
      current_status: "running",
      spark: spark(["2026-07-07T10:00:00Z", "fail"]),
    });
    expect(deriveSystemStatus([staging, mk({})]).status).toBe("operational");
  });
});
