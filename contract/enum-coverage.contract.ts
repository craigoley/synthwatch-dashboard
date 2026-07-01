import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Enum-coverage check — the must-go-red for the CI tooling itself. Drives the REAL CLI (exit code + message)
 * against synthetic schema fixtures, so it's self-contained (runs in the hermetic Playwright job that has no
 * runner checkout; the real cross-repo drift is gated by .github/workflows/enum-coverage.yml). The CLI reads
 * the REAL enum-coverage.json manifest + real src/lib/types.ts; only the schema is fixtured via the path arg.
 */

const ROOT = join(__dirname, "..");
const SCRIPT = join(ROOT, "scripts/check-enum-coverage.mjs");

// runs.status / reconcile_drift.drift_type exactly as the real runner schema defines them (the covered set).
const COVERED_SCHEMA = `
CREATE TABLE runs (
    id BIGINT PRIMARY KEY,
    -- prose that must be stripped, never parsed: pass | warn | GHOST
    status TEXT NOT NULL CHECK (status IN ('pass', 'warn', 'fail', 'error', 'infra_error', 'running')),
    started_at TIMESTAMPTZ
);
CREATE TABLE reconcile_drift (
    id BIGINT PRIMARY KEY,
    drift_type TEXT NOT NULL CHECK (drift_type IN ('new', 'changed', 'missing', 'orphan', 'redaction_mismatch'))
);
CREATE TABLE run_steps (
    id BIGINT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'error', 'running'))
);
`;

function run(schema: string): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "enum-cov-"));
  const path = join(dir, "schema.sql");
  writeFileSync(path, schema);
  try {
    const out = execFileSync("node", [SCRIPT, path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

test.describe("enum-coverage CLI", () => {
  test("green: the exact real CHECK sets are covered by the real unions (and comment prose is ignored)", () => {
    const { code, out } = run(COVERED_SCHEMA);
    expect(out).toContain("OK");
    expect(code).toBe(0); // GHOST in a comment did NOT get parsed → no false drift
  });

  test("★ MUST-GO-RED: a runner CHECK value absent from its union fails, naming the value + column + union", () => {
    const withGap = COVERED_SCHEMA.replace(
      "'running')),\n    started_at",
      "'running', 'cancelled')),\n    started_at",
    );
    const { code, out } = run(withGap);
    expect(code).toBe(1); // the check GOES RED on a real gap
    expect(out).toContain("ENUM DRIFT");
    expect(out).toContain("cancelled"); // the specific missing value
    expect(out).toContain("runs.status"); // the table.column
    expect(out).toContain("RunStatus"); // the union
  });

  test("fail-closed: a mapping that can't be resolved (missing CHECK) errors, never a silent pass", () => {
    const noRuns = `CREATE TABLE reconcile_drift (\n  id BIGINT PRIMARY KEY,\n  drift_type TEXT NOT NULL CHECK (drift_type IN ('new', 'changed', 'missing', 'orphan', 'redaction_mismatch'))\n);\n`;
    const { code, out } = run(noRuns);
    expect(code).toBe(1);
    expect(out).toContain("UNRESOLVED MAPPING");
    expect(out).toContain("runs.status");
  });

  test("the real src/lib/types.ts covers the seeded runner enums (RunStatus incl. infra_error, DriftType)", () => {
    const types = readFileSync(join(ROOT, "src/lib/types.ts"), "utf8");
    const runStatusDecl = types.match(/type RunStatus =[^;]*/)?.[0] ?? "";
    for (const v of ["pass", "warn", "fail", "error", "infra_error", "running"]) {
      expect(runStatusDecl, `RunStatus must cover runs.status '${v}'`).toContain(`"${v}"`);
    }
  });

  test("RunStepStatus covers run_steps.status (pass/fail/error/running) — the drift-prone RowStatus dup is gone", () => {
    const types = readFileSync(join(ROOT, "src/lib/types.ts"), "utf8");
    const stepDecl = types.match(/type RunStepStatus =[^;]*/)?.[0] ?? "";
    for (const v of ["pass", "fail", "error", "running"]) {
      expect(stepDecl, `RunStepStatus must cover run_steps.status '${v}'`).toContain(`"${v}"`);
    }
    // RowStatus now DERIVES from RunStepStatus (+ UI-only "pending"), so it can't drift from the real statuses.
    const live = readFileSync(join(ROOT, "src/components/live-steps.tsx"), "utf8");
    expect(live, "RowStatus derives from RunStepStatus (no independent hardcoded copy)").toMatch(
      /type RowStatus = RunStepStatus \| "pending"/,
    );
  });
});
