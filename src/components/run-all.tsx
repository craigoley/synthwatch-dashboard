"use client";

/**
 * "Run all" — fan out the per-check "Run now" trigger across the CURRENT filtered set in one click (re-run
 * the fleet after a runner deploy without clicking each monitor). There is no batch API, so this loops the
 * single POST /checks/{id}/run (runCheckNow) with a CONCURRENCY CAP, and shows live aggregate progress by
 * watching each monitor's latest-run settle in the shared checks list (the same live signal the cards use).
 *
 * Guardrails baked in: editor/admin only (real ACA cost), the trigger fan-out is capped (never N simultaneous
 * POSTs), partial trigger failures are surfaced without aborting the rest, and the count is always on the
 * button so it's never a surprise mass-fire.
 */

import { useEffect, useState } from "react";

import { runCheckNow } from "@/lib/client";
import { useAuth } from "@/components/auth-provider";
import type { CheckWithStatus, RunStatus } from "@/lib/types";

// Cap the TRIGGER fan-out: each runCheckNow is a quick POST that ENQUEUES a run (the runner drains the queue
// at its own pace), so this throttles the burst of API calls rather than ACA jobs directly — 4 keeps it gentle
// on the API and staggers the visible ramp-up, while a 20-monitor set still fans out in ~5 quick rounds.
const RUN_ALL_CONCURRENCY = 4;
// Don't wait forever for runs to land (runner backlog / a stuck run) — stop the live state after this.
const BATCH_TIMEOUT_MS = 120_000;

const isTerminal = (s: RunStatus | null): boolean =>
  s === "pass" || s === "warn" || s === "fail" || s === "error";

interface Batch {
  ids: number[]; // monitors triggered (the filtered scope captured at click time)
  baseline: Record<number, string | null>; // last_started_at per id BEFORE the trigger
  failedTrigger: number[]; // ids whose trigger POST 4xx/5xx'd (couldn't start)
  timedOut: boolean;
}

export function RunAllControl({
  allChecks,
  scope,
  onRunningChange,
}: {
  allChecks: CheckWithStatus[]; // the LIVE full list — status lookup by id (re-renders as the page polls)
  scope: CheckWithStatus[]; // the current filtered set — what gets triggered + the button count
  onRunningChange: (running: boolean) => void;
}) {
  const { canWrite } = useAuth();
  const [batch, setBatch] = useState<Batch | null>(null);
  const [firing, setFiring] = useState(false); // the trigger POST fan-out itself is in flight

  const byId = new Map(allChecks.map((c) => [c.id, c]));

  // A monitor's NEW run is done when its latest run advanced past the pre-trigger snapshot AND settled.
  // The list endpoint exposes last_started_at (lastRunAt), not last_finished_at — so we key off that
  // advancing + a terminal status, which also catches a run that starts+finishes between polls.
  function isDone(id: number, b: Batch): boolean {
    if (b.failedTrigger.includes(id) || b.timedOut) return true;
    const c = byId.get(id);
    if (!c) return true; // vanished from the fleet → stop waiting on it
    return c.last_started_at !== b.baseline[id] && isTerminal(c.current_status);
  }

  const agg = batch
    ? batch.ids.reduce(
        (a, id) => {
          if (batch.failedTrigger.includes(id)) return a;
          if (!isDone(id, batch)) return { ...a, running: a.running + 1 };
          const s = byId.get(id)?.current_status;
          return s === "pass" || s === "warn"
            ? { ...a, passed: a.passed + 1 }
            : { ...a, failed: a.failed + 1 };
        },
        { running: 0, passed: 0, failed: 0 },
      )
    : null;

  const triggerFailed = batch?.failedTrigger.length ?? 0;
  const total = batch?.ids.length ?? 0;
  const active = firing || (agg?.running ?? 0) > 0;

  // Drive the page's fast-poll while the batch is active; stop once everything settles.
  useEffect(() => {
    onRunningChange(active);
  }, [active, onRunningChange]);

  // Safety stop — runner backlog / a stuck run shouldn't pin the live state open forever.
  useEffect(() => {
    if (!batch || !active) return;
    const t = setTimeout(() => setBatch((b) => (b ? { ...b, timedOut: true } : b)), BATCH_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [batch, active]);

  if (!canWrite) return null; // editor/admin only — this triggers real runs (real cost)

  const enabledCount = scope.filter((c) => c.enabled).length; // disabled monitors are skipped

  async function handleRunAll() {
    const targets = scope.filter((c) => c.enabled);
    if (targets.length === 0 || firing) return;
    const baseline: Record<number, string | null> = {};
    for (const c of targets) baseline[c.id] = c.last_started_at;
    const ids = targets.map((c) => c.id);
    setBatch({ ids, baseline, failedTrigger: [], timedOut: false });
    setFiring(true);
    onRunningChange(true);

    // ★ Capped fan-out: fire in rounds of RUN_ALL_CONCURRENCY. allSettled → a failed trigger doesn't abort
    // the round or the batch; we record which couldn't start and keep going.
    const failedTrigger: number[] = [];
    for (let i = 0; i < ids.length; i += RUN_ALL_CONCURRENCY) {
      const slice = ids.slice(i, i + RUN_ALL_CONCURRENCY);
      const results = await Promise.allSettled(slice.map((id) => runCheckNow(id)));
      results.forEach((r, k) => {
        if (r.status === "rejected") failedTrigger.push(slice[k]!);
      });
    }
    setBatch((b) => (b ? { ...b, failedTrigger } : b));
    setFiring(false);
  }

  const label = firing
    ? "Starting…"
    : agg && agg.running > 0
      ? `Running ${agg.running}…`
      : `Run ${enabledCount} monitor${enabledCount === 1 ? "" : "s"}`;

  return (
    <div className="flex flex-wrap items-center justify-end gap-2" data-testid="run-all">
      <button
        type="button"
        onClick={handleRunAll}
        disabled={enabledCount === 0 || active}
        data-testid="run-all-button"
        className="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2.5 py-1 text-xs font-medium text-[var(--color-ink)] transition hover:bg-[var(--color-panel-2)] disabled:opacity-60"
      >
        {label}
      </button>
      {agg && (
        <span className="sw-mono text-[11px] text-[var(--color-ink-dim)]" data-testid="run-all-progress">
          {agg.running > 0
            ? `${agg.passed + agg.failed}/${total - triggerFailed} done`
            : `done — ${agg.passed} passed, ${agg.failed} failed`}
          {triggerFailed > 0 && (
            <span style={{ color: "var(--color-fail)" }} data-testid="run-all-trigger-failed">
              {" "}
              · {triggerFailed} couldn’t start
            </span>
          )}
          {batch?.timedOut && <span className="text-[var(--color-ink-faint)]"> · timed out</span>}
        </span>
      )}
    </div>
  );
}
