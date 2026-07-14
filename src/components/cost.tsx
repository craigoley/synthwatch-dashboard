"use client";

import Link from "next/link";

import { useCostReport } from "@/lib/client";
import type { CostCheck, CostReport } from "@/lib/types";

/**
 * Estimated monthly ACA compute cost (GET /reports/cost, synthwatch-api #198; recon #220/#229). ★ A grounded
 * PROJECTION, never the Azure bill — every figure traces to a real endpoint input (measured avg duration /
 * configured interval / assigned region count / a NAMED rate the endpoint echoes). No client-side complexity
 * guessing, no hardcoded rate.
 */

export const SECONDS_PER_MONTH = 2_592_000; // 30d × 86400 — matches the API's runs/month divisor.

/** $ with honest small-value handling — never a fake $0.00 for a real-but-tiny cost. */
export function money(n: number): string {
  if (n <= 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/** The estimate provenance line, read from the endpoint's echoed rate (never hardcoded). */
export function costEstimateLabel(r: CostReport): string {
  return `Estimate · rate $${r.rate_used}/active-s (${r.rate_source}, set ${r.rate_set_date}). The Azure bill is ground truth.`;
}

/**
 * The proven cost model as a PURE function (recon #220/#229) — the SAME arithmetic the API's /reports/cost
 * uses, so the modal's live recompute is consistent with the endpoint. `avg_duration_s` is MEASURED (held
 * constant across interval/region edits); interval + region_count are the user-editable inputs.
 */
export function projectedMonthlyCost(
  avgDurationS: number,
  intervalSeconds: number,
  regionCount: number,
  ratePerActiveSecond: number,
): number {
  if (intervalSeconds <= 0) return 0;
  return avgDurationS * (SECONDS_PER_MONTH / intervalSeconds) * regionCount * ratePerActiveSecond;
}

const SECONDS_PER_WEEK = 604800;

/**
 * Attribute a divergence FLAG from data, never from retries. The algebra: since Σduration = avg × N over the
 * SAME 7d run set, duration cancels EXACTLY and `divergence = run_count_7d / expected` — a PURE RUN-COUNT
 * ratio. So retries (which persist no extra row/duration) and slow/failing runs (which inflate measured AND
 * projected identically) CANNOT move it. Only EXTRA ROWS do: a config (interval) change straddling the 7d
 * window, confirmation re-runs (0077), or sandbox/on-demand fires (0065). We name only those, from the count
 * columns — and back the run count out of divergence×expected if the API predates them.
 */
function divergenceInfo(c: CostCheck): { badge: string; detail: string; title: string } | null {
  if (!c.divergence_flag) return null;
  const x = c.divergence_ratio != null ? `${c.divergence_ratio.toFixed(1)}×` : "";
  const expected = c.interval_seconds > 0 ? Math.round((SECONDS_PER_WEEK / c.interval_seconds) * c.region_count) : 0;
  // run_count_7d is authoritative; if the API predates it, divergence = M/expected ⇒ M = divergence×expected.
  const m =
    c.run_count_7d > 0
      ? c.run_count_7d
      : c.divergence_ratio != null && expected > 0
        ? Math.round(c.divergence_ratio * expected)
        : 0;
  const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`;

  const causes: string[] = [];
  // A cadence step between the two 3.5d halves ⇒ a recent interval change (the dominant real cause).
  const { run_count_recent: rec, run_count_prior: pri } = c;
  if (rec > 0 && pri > 0 && (rec < pri * 0.7 || rec > pri * 1.3)) {
    causes.push("its interval changed recently — measured still holds the old cadence; this self-clears as the 7d window rolls");
  }
  if (c.confirmation_count_7d > 0) causes.push(plural(c.confirmation_count_7d, "confirmation re-run"));
  if (c.sandbox_count_7d > 0) causes.push(plural(c.sandbox_count_7d, "sandbox/on-demand fire"));

  const counts = expected > 0 ? `${m} runs in the last 7d vs ${expected} its schedule predicts` : `${m} runs in the last 7d`;
  const why = causes.length
    ? ` — ${causes.join("; ")}`
    : " — more runs than its current schedule predicts (a recent interval change, confirmation re-runs, or sandbox fires)";
  return {
    badge: expected > 0 ? `⚠ ${m}/${expected} runs (${x})` : `⚠ ${x}`,
    detail: `⚠ ${counts}${why}`,
    title: `Divergence is a pure RUN-COUNT ratio (duration cancels) — EXTRA runs vs the schedule, not longer runs. ${counts}${why}.`,
  };
}

function DivergenceFlag({ c }: { c: CostCheck }) {
  const info = divergenceInfo(c);
  if (!info) return null;
  return (
    <span className="inline-flex items-center gap-1">
      <span
        data-testid={`cost-divergence-${c.check_id}`}
        className="sw-mono text-[10px]"
        style={{ color: "var(--color-warn)" }}
        title={info.title}
      >
        {info.badge}
      </span>
      {/* "divergence" is jargon — link the glossary AT the point of confusion, not only from the trust legend */}
      <Link href="/glossary" className="text-[10px] text-[var(--color-brand)] hover:underline" data-testid="cost-divergence-glossary-link" title="What does divergence mean?">
        ⓘ
      </Link>
    </span>
  );
}

/**
 * OVERVIEW: total projected monthly cost headline + the top-N cost drivers (#229's insight — WHICH monitors
 * dominate is the actionable part). Self-hides on 404 (endpoint not deployed); a loud error on 500.
 */
export function FleetCostSummary() {
  const { data, error } = useCostReport();
  if (error) {
    return (
      <p className="sw-mono text-[11px] text-[var(--color-fail)]" data-testid="fleet-cost-error">
        Cost estimate unavailable (report error).
      </p>
    );
  }
  if (!data) return null; // loading or 404 (not deployed) → nothing
  // Prefer the API's ranked top_cost_drivers; if it's ever empty, fall back to the checks list SORTED by
  // projected cost (never fetch-order — the list is labeled "Top cost drivers").
  const drivers =
    data.top_cost_drivers.length > 0
      ? data.top_cost_drivers
      : [...data.checks].sort((a, b) => b.projected_monthly - a.projected_monthly).slice(0, 5);

  return (
    <div className="sw-panel p-4" data-testid="fleet-cost-summary">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
            Projected monthly compute
          </div>
          <div className="sw-mono text-2xl font-semibold text-[var(--color-ink)]" data-testid="fleet-cost-total-projected">
            {money(data.total_projected_monthly)}
            <span className="ml-1 text-[11px] font-normal text-[var(--color-ink-faint)]">/mo est.</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">Measured (7d → mo)</div>
          <div className="sw-mono text-sm text-[var(--color-ink-dim)]" data-testid="fleet-cost-total-measured">
            {money(data.total_measured_monthly)}
          </div>
        </div>
      </div>

      <div className="mt-3">
        <div className="mb-1.5 text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
          Top cost drivers
        </div>
        <ul className="space-y-1" data-testid="fleet-cost-drivers">
          {drivers.map((c) => (
            <li key={c.check_id} className="flex items-center justify-between gap-3 text-[13px]" data-testid={`cost-driver-${c.check_id}`}>
              <Link href={`/checks/${c.check_id}`} className="min-w-0 flex items-center gap-2 hover:underline">
                <span className="sw-mono text-[9px] uppercase text-[var(--color-ink-faint)]">{c.kind}</span>
                <span className="truncate text-[var(--color-ink)]">{c.name}</span>
                <DivergenceFlag c={c} />
              </Link>
              <span className="sw-mono shrink-0 text-[var(--color-ink-dim)]">{money(c.projected_monthly)}</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="mt-2 text-[10px] text-[var(--color-ink-faint)]" data-testid="fleet-cost-estimate-label">
        {costEstimateLabel(data)}
      </p>
    </div>
  );
}

/**
 * MONITOR-DETAIL: this monitor's projected monthly cost with an INSPECTABLE breakdown (avg duration × runs/mo
 * × regions × rate) + the measured (7d-extrapolated) figure + a divergence flag. Labeled an estimate with the
 * endpoint's echoed rate/date. Self-hides when the endpoint is absent or the check isn't in the report.
 */
export function MonitorCostPanel({ checkId }: { checkId: number }) {
  const { data, error } = useCostReport();
  // ★ Honest-render: split "broken" from "absent". A 500/network error is LOUD (getCostReport throws → SWR
  // error); a 404 (getCostReport returns null) or loading is silent-hide. Never render a broken report as an
  // absent panel (#175/#177/#179).
  if (error) {
    return (
      <div className="sw-panel p-4" data-testid="monitor-cost-panel">
        <p className="sw-mono text-[11px] text-[var(--color-fail)]" data-testid="monitor-cost-error">
          Cost estimate unavailable (report error).
        </p>
      </div>
    );
  }
  if (!data) return null; // loading / 404 (endpoint not deployed) → hide
  const c = data.checks.find((x) => x.check_id === checkId);
  if (!c) return null;

  const runsPerMonth = c.interval_seconds > 0 ? Math.round(SECONDS_PER_MONTH / c.interval_seconds) : 0;
  const hasRuns = c.avg_duration_s != null;

  return (
    <div className="sw-panel p-4" data-testid="monitor-cost-panel">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--color-ink)]">Estimated monthly cost</h3>
        <span
          className="sw-mono cursor-help text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]"
          title={costEstimateLabel(data)}
          data-testid="monitor-cost-estimate-label"
        >
          estimate ⓘ
        </span>
      </div>

      {!hasRuns ? (
        <p className="text-sm text-[var(--color-ink-dim)]">No runs in the last 7 days — projection unavailable.</p>
      ) : (
        <>
          <div className="flex items-end gap-4">
            <div>
              <div className="sw-mono text-2xl font-semibold text-[var(--color-ink)]" data-testid="monitor-cost-projected">
                {money(c.projected_monthly)}
                <span className="ml-1 text-[11px] font-normal text-[var(--color-ink-faint)]">/mo</span>
              </div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">projected</div>
            </div>
            <div>
              <div className="sw-mono text-sm text-[var(--color-ink-dim)]" data-testid="monitor-cost-measured">
                {money(c.measured_monthly_7d)}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">measured 7d→mo</div>
            </div>
          </div>

          {/* ★ Inspectable breakdown — every factor is a real endpoint field, not a magic number. */}
          <p className="mt-2 sw-mono text-[11px] text-[var(--color-ink-dim)]" data-testid="monitor-cost-breakdown">
            {c.avg_duration_s!.toFixed(2)}s avg × {runsPerMonth.toLocaleString()} runs/mo × {c.region_count} region
            {c.region_count === 1 ? "" : "s"} × ${data.rate_used}/active-s
          </p>

          {divergenceInfo(c) && (
            <p className="mt-2 text-[11px]" style={{ color: "var(--color-warn)" }} data-testid="monitor-cost-divergence" title={divergenceInfo(c)!.title}>
              {divergenceInfo(c)!.detail}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * EDIT MODAL live recompute: projects this monitor's monthly cost from the modal's CURRENT interval + region
 * count, holding `avg_duration_s` CONSTANT (it's MEASURED from past runs — a config change can't retro-alter
 * it). Pure arithmetic, so it recomputes instantly as the user edits frequency/regions — before save.
 *
 * ★ Honesty: it exactly predicts a FREQUENCY or REGION change; it CANNOT predict how a SPEC change would move
 * duration (that's measured, not projected) — the label says so. A never-run check has no measured duration →
 * the "no history yet" state, never $0. On save, the card + detail projected figures adopt these settings
 * (go-forward); measured (7d) stays backward-looking until new runs accumulate (an expected, non-error gap).
 */
export function MonitorCostEstimate({
  checkId,
  intervalSeconds,
  regionCount,
}: {
  checkId: number | null; // null = new check (no measured duration yet)
  intervalSeconds: number;
  regionCount: number;
}) {
  const { data } = useCostReport();
  if (!data) return null; // cost endpoint absent → no estimate (the form still works)

  const stored = checkId != null ? data.checks.find((c) => c.check_id === checkId) : undefined;
  const avg = stored?.avg_duration_s ?? null;

  if (avg == null) {
    return (
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2" data-testid="modal-cost-estimate">
        <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">Projected monthly cost</div>
        <p className="mt-0.5 text-[12px] text-[var(--color-ink-dim)]" data-testid="modal-cost-no-history">
          No duration history yet — cost projects after the first run.
        </p>
      </div>
    );
  }

  const valid = intervalSeconds > 0 && regionCount > 0;
  const projected = valid ? projectedMonthlyCost(avg, intervalSeconds, regionCount, data.rate_used) : 0;
  const runsPerMonth = intervalSeconds > 0 ? Math.round(SECONDS_PER_MONTH / intervalSeconds) : 0;

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2" data-testid="modal-cost-estimate">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">Projected monthly cost</span>
        <span className="sw-mono text-lg font-semibold text-[var(--color-ink)]" data-testid="modal-cost-projected">
          {valid ? `~${money(projected)}/mo` : "—"}
        </span>
      </div>
      {valid && (
        <p className="mt-1 sw-mono text-[10px] text-[var(--color-ink-dim)]" data-testid="modal-cost-breakdown">
          {avg.toFixed(2)}s avg × {runsPerMonth.toLocaleString()} runs/mo × {regionCount} region
          {regionCount === 1 ? "" : "s"} × ${data.rate_used}/active-s
        </p>
      )}
      <p className="mt-1 text-[10px] text-[var(--color-ink-faint)]">
        Projected from the <strong>recent avg duration</strong> ({avg.toFixed(2)}s, measured) × your frequency &amp;
        regions. A spec change that alters duration isn&apos;t predicted here — it re-measures after new runs.
      </p>
    </div>
  );
}
