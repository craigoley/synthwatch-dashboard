import { test, expect } from "@playwright/test";

import { runStatusMeta, statusRank } from "@/lib/status";

/**
 * Render-path guard for the infra_error gap this PR closes: adding it to the RunStatus union is necessary but
 * not sufficient — it must also RENDER (a label + styling), not blank. Pins the chosen treatment so it can't
 * regress. (RUN_STATUS is a Record<RunStatus>, so tsc already forces an entry; this pins WHAT that entry is.)
 */
test.describe("run-status render — infra_error", () => {
  test("infra_error renders a distinct label + amber (warn) tone, not blank/red", () => {
    const meta = runStatusMeta("infra_error");
    expect(meta.label).toBe("Infra error"); // ★ not blank — the live gap was an unlabeled run
    expect(meta.label).not.toBe("Error"); // distinguishable from a check 'error'
    // amber, not red: infra_error is SLA-excluded + non-paging, so it must not read as a target outage
    expect(meta.token).toBe("warn");
    expect(meta.dotClass).toBe("sw-dot-warn");
  });

  test("infra_error ranks in the warn tier (non-paging → not worst)", () => {
    expect(statusRank("infra_error")).toBe(statusRank("warn"));
    expect(statusRank("infra_error")).toBeGreaterThan(statusRank("error")); // below hard fail/error
  });
});
