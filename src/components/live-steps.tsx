"use client";

import { useRunSteps } from "@/lib/client";
import { TONE_VAR } from "@/components/status-badge";
import { stepStatusToken } from "@/lib/status";
import type { Run, RunStep, RunStepStatus } from "@/lib/types";

// ★ DERIVED from RunStepStatus (the union that gates run_steps.status via enum-coverage.json) + a UI-only
// "pending" (future/template steps not reached yet — not a DB status). This kills the old drift-prone local
// copy: if run_steps.status grows a value, RunStepStatus must cover it (enum-coverage) AND the GLYPH Record
// below won't compile until it's given a glyph — so a new step status can't render blank.
type RowStatus = RunStepStatus | "pending";
interface Row {
  index: number;
  name: string;
  status: RowStatus;
}

const GLYPH: Record<RowStatus, string> = {
  pass: "✓",
  fail: "✗",
  error: "✗",
  running: "⟳",
  skip: "⊘", // a step the runner skipped (RunStepStatus) — distinct from not-yet-reached (pending ◦)
  pending: "◦",
};

/**
 * Live step-by-step checklist for the IN-FLIGHT run. Rides #108's fast poll (live while the run is
 * running). The runner writes a `run_steps` row 'running' on step start + finalizes it to pass/fail/error,
 * so we render the REAL per-step status — "1 ✓ … 2 ✓ … 3 ⟳ … 4 ◦". Future not-yet-started steps (and
 * their names) come from a prior run's steps (the template), shown pending ◦. Same status-color law as the
 * funnel. When the run goes terminal the page stops rendering this (the run-history funnel takes over).
 */
export function LiveStepsChecklist({ run, templateRunId }: { run: Run; templateRunId: number | null }) {
  const running = run.status === "running";
  const { data: liveSteps } = useRunSteps(run.id, running); // poll fast while in flight
  const { data: template } = useRunSteps(templateRunId, false); // prior run's steps → names of pending steps

  const liveByIndex = new Map<number, RunStep>((liveSteps ?? []).map((s) => [s.step_index, s]));
  const total = Math.max(template?.length ?? 0, liveSteps?.length ?? 0);
  if (total === 0) return null; // no steps yet + no template (e.g. first-ever run) — nothing to show

  const rows: Row[] = Array.from({ length: total }, (_, i) => {
    const live = liveByIndex.get(i);
    if (live) return { index: i, name: live.name, status: live.status }; // RunStepStatus ⊆ RowStatus — no cast
    return { index: i, name: template?.[i]?.name ?? `step ${i + 1}`, status: "pending" }; // not reached yet
  });
  const done = rows.filter((r) => r.status === "pass" || r.status === "fail" || r.status === "error").length;

  return (
    <section className="sw-panel p-4" data-testid="live-steps">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-[var(--color-ink)]">Live progress</h3>
        <span className="sw-mono text-[11px] text-[var(--color-ink-faint)]">
          {done} of {rows.length} steps
        </span>
      </div>
      <div className="mb-3 h-1.5 w-full overflow-hidden rounded bg-[var(--color-bg)]">
        <div
          className="h-full rounded transition-all"
          style={{ width: `${(done / rows.length) * 100}%`, background: "var(--color-brand)" }}
        />
      </div>
      <ol className="space-y-1.5">
        {rows.map((r) => {
          const tone = TONE_VAR[stepStatusToken(r.status)];
          return (
            <li key={r.index} className="flex items-center gap-2.5 text-sm" data-testid={`live-step-${r.index}`}>
              <span
                className={`sw-mono inline-flex h-5 w-5 items-center justify-center ${r.status === "running" ? "sw-spin" : ""}`}
                style={{ color: tone }}
                aria-label={r.status}
              >
                {GLYPH[r.status]}
              </span>
              <span className="sw-mono text-[11px] text-[var(--color-ink-faint)]">{r.index + 1}</span>
              <span className={r.status === "pending" ? "text-[var(--color-ink-faint)]" : "text-[var(--color-ink)]"}>
                {r.name}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
