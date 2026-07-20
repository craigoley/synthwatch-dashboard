"use client";

import Link from "next/link";

import { useCostReport } from "@/lib/client";
import { AZURE_STALE_AFTER_MS, asOf } from "@/lib/staleness";
import type { CostCheck, CostReport } from "@/lib/types";

/**
 * The cost panel (runner 0089/0090/0091, api #263/#264):
 *   1. HEADLINE = Azure's ACTUAL bill (the `azure` block: MTD + forecast, pulled not modeled). Absent →
 *      a "see Azure Cost Management" deep-link fallback, NEVER a fabricated $0 (absent ≠ zero ≠ small).
 *   2. BREAKDOWN = per-monitor DOLLAR estimate (PRIMARY, `estimated_monthly`) + compute share (SECONDARY,
 *      `active_seconds_pct`) beside it, for EVERY active monitor (no truncation). The dollar is free-grant-
 *      aware and reconciled to the fleet total — an "est." with real math, not false precision. The dollars
 *      stand alone regardless of whether the Azure block is live.
 *   3. The fleet modeled estimate (grant-corrected total) is a labeled secondary beside Azure's number, and
 *      doubles as a drift check ("is our estimate tracking reality?").
 */

export const SECONDS_PER_MONTH = 2_592_000; // 30d × 86400 — matches the API's runs/month divisor.

// The generic Cost Management deep link for the absent-headline fallback (the scoped portal_url lives INSIDE
// the azure block, so it's unavailable exactly when we need the fallback — this always resolves).
const PORTAL_COST_MGMT = "https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/costanalysis";

/** $ with honest small-value handling — never a fake $0.00 for a real-but-tiny cost. */
export function money(n: number): string {
  if (n <= 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/** Azure figures WITH their reported currency — never assume $ (the RG could bill in another currency). */
export function azureMoney(n: number, currency: string): string {
  return currency === "USD" || currency === "" ? `$${n.toFixed(2)}` : `${n.toFixed(2)} ${currency}`;
}

/** Compute-share %, honest at the small end — a real-but-tiny share is "<0.1%", a null (no runs) is "—". */
export function sharePct(pct: number | null): string {
  if (pct == null) return "—";
  if (pct > 0 && pct < 0.1) return "<0.1%";
  return `${pct.toFixed(pct < 10 ? 1 : 0)}%`;
}

/** The per-monitor estimate label — the absent-vs-zero distinction, honestly:
 *   null  = the monitor DIDN'T run → "—" (honest-absent).
 *   0     = it RAN but the estimate rounds below a cent → "<$0.01/mo" (NOT free — the API sends null, not 0,
 *           when there are no runs, so an exact 0 means it ran and its share is sub-cent).
 *   else  = its dollar. */
export function estimatedLabel(est: number | null): string {
  if (est == null) return "—";
  if (est === 0) return "<$0.01/mo";
  return `${money(est)}/mo`;
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
 * The DEMOTED modeled estimate — shown ONLY as a labeled secondary beside Azure's actual number, never as the
 * headline. When Azure is present it doubles as a DRIFT check (modeled vs actual: "is our estimate tracking
 * reality?"). ★ "steady-state estimate" not "projected monthly": it annualizes the current 7d, so it answers
 * "what a full month at today's rate costs", a different question from "what Azure says I've spent".
 */
function ModeledEstimate({ report, azureForecast }: { report: CostReport; azureForecast: number | null }) {
  // ★ 0091: the fleet estimate is the free-grant-corrected total (estimated_monthly_total = Σ per-monitor),
  // NOT the from-zero total — the grant pulls it closer to Azure. Drift is that estimate ÷ Azure's forecast.
  const drift =
    azureForecast != null && azureForecast > 0
      ? report.estimated_monthly_total / azureForecast
      : null;
  return (
    <div className="text-right" data-testid="fleet-cost-estimate">
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
        Steady-state estimate <span className="normal-case">(modeled, 7d)</span>
      </div>
      <div className="sw-mono text-sm text-[var(--color-ink-dim)]" data-testid="fleet-cost-estimate-value">
        {money(report.estimated_monthly_total)}
        <span className="ml-1 text-[10px] font-normal text-[var(--color-ink-faint)]">/mo</span>
      </div>
      {drift != null && (
        <div
          className="sw-mono text-[10px]"
          style={{ color: drift > 1.25 || drift < 0.8 ? "var(--color-warn)" : "var(--color-ink-faint)" }}
          data-testid="fleet-cost-drift"
          title="Modeled steady-state ÷ Azure's forecast. Near 1.0 = the estimate tracks reality; far = the model is drifting (ramp, fleet growth, or a non-ACA line item Azure sees and the model doesn't)."
        >
          {drift.toFixed(2)}× vs Azure forecast
        </div>
      )}
    </div>
  );
}

/** HEADLINE when the pull is present — Azure's ACTUAL number, with "as of" + a staleness flag. */
function AzureHeadline({ azure, report }: { azure: NonNullable<CostReport["azure"]>; report: CostReport }) {
  const { label, stale } = asOf(azure.fetched_at, AZURE_STALE_AFTER_MS);
  return (
    <div data-testid="fleet-cost-azure">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
            Azure month-to-date <span className="normal-case text-[var(--color-ink-faint)]">({azure.mtd_days}d)</span>
          </div>
          <div className="sw-mono text-2xl font-semibold text-[var(--color-ink)]" data-testid="fleet-cost-azure-mtd">
            {azureMoney(azure.mtd_actual, azure.currency)}
          </div>
          <div className="mt-0.5 text-[11px] text-[var(--color-ink-dim)]" data-testid="fleet-cost-azure-forecast">
            {azure.forecast_month != null
              ? <>Azure forecast <span className="sw-mono text-[var(--color-ink)]">{azureMoney(azure.forecast_month, azure.currency)}</span>/mo</>
              : "Azure forecast unavailable"}
          </div>
        </div>
        <ModeledEstimate report={report} azureForecast={azure.forecast_month} />
      </div>
      <p
        className="mt-1.5 text-[10px]"
        style={{ color: stale ? "var(--color-warn)" : "var(--color-ink-faint)" }}
        data-testid="fleet-cost-azure-asof"
      >
        {stale ? "⚠ " : ""}Azure Cost Management, as of {label}
        {stale ? " — may be stale" : ""} · the actual bill (not modeled)
      </p>
    </div>
  );
}

/**
 * HEADLINE when the pull is ABSENT/stale (azure == null on the wire — the API's honest-absence). ★ The #280/#286
 * standard: this state is VISUALLY DISTINCT from a real $0 and from a low number — a muted, dashed, no-figure
 * card with a deep link, never a "$0.00". Absent ≠ zero ≠ small.
 */
function AzureUnavailable({ report }: { report: CostReport }) {
  return (
    <div data-testid="fleet-cost-azure-unavailable">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div
          className="rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2"
          style={{ borderLeft: "3px solid var(--color-warn)" }}
        >
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">Azure cost</div>
          <div className="text-[13px] text-[var(--color-ink-dim)]" data-testid="fleet-cost-azure-absent-msg">
            Cost data unavailable
          </div>
          <a
            href={PORTAL_COST_MGMT}
            target="_blank"
            rel="noopener noreferrer"
            className="sw-mono text-[11px] text-[var(--color-brand)] hover:underline"
            data-testid="fleet-cost-azure-portal-link"
          >
            see Azure Cost Management ↗
          </a>
        </div>
        <ModeledEstimate report={report} azureForecast={null} />
      </div>
      <p className="mt-1.5 text-[10px] text-[var(--color-ink-faint)]" data-testid="fleet-cost-azure-asof">
        No pulled figure yet — the runner refreshes it on the daily rollup. Showing the modeled estimate only.
      </p>
    </div>
  );
}

/**
 * The fleet cost panel: Azure's actual number as the headline (or an honest deep-link fallback), then the
 * per-monitor COMPUTE SHARE breakdown. Self-hides on 404 (endpoint not deployed); a loud error on 500.
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
  // ★ Rank by the DOLLAR estimate (primary), null last. ★ NO .slice — render EVERY active monitor (the
  // truncation-to-8 bug). The API already excludes archived (#313) and returns the full list.
  const ranked = [...data.checks].sort(
    (a, b) => (b.estimated_monthly ?? -1) - (a.estimated_monthly ?? -1),
  );

  return (
    <div className="sw-panel p-4" data-testid="fleet-cost-summary">
      {/* 1 — THE HEADLINE: Azure's actual number, or the honest-absent fallback (keyed on azure == null). */}
      {data.azure ? <AzureHeadline azure={data.azure} report={data} /> : <AzureUnavailable report={data} />}

      {/* 2 — THE BREAKDOWN: per-monitor DOLLAR (primary) + compute share (secondary), ALL monitors. */}
      <div className="mt-4">
        <div className="mb-1.5 flex items-baseline justify-between text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
          <span>Estimated cost by monitor</span>
          <span data-testid="fleet-cost-monitor-count">{ranked.length} monitors</span>
        </div>
        <ul className="space-y-1" data-testid="fleet-cost-drivers">
          {ranked.map((c) => (
            <li key={c.check_id} className="flex items-center justify-between gap-3 text-[13px]" data-testid={`cost-driver-${c.check_id}`}>
              <Link href={`/checks/${c.check_id}`} className="min-w-0 flex items-center gap-2 hover:underline">
                <span className="sw-mono text-[9px] uppercase text-[var(--color-ink-faint)]">{c.kind}</span>
                <span className="truncate text-[var(--color-ink)]">{c.name}</span>
                <DivergenceFlag c={c} />
              </Link>
              <span className="flex shrink-0 items-baseline gap-2">
                {/* PRIMARY: the dollar estimate */}
                <span className="sw-mono text-[var(--color-ink)]" data-testid={`fleet-cost-dollar-${c.check_id}`}>
                  {estimatedLabel(c.estimated_monthly)}
                </span>
                {/* SECONDARY: compute share, beside the dollar */}
                <span
                  className="sw-mono text-[10px] text-[var(--color-ink-faint)]"
                  data-testid={`fleet-cost-share-${c.check_id}`}
                  title="Share of fleet compute (active-seconds). The dollar is an estimate reconciled to the fleet total; share is the attributable proportion."
                >
                  {sharePct(c.active_seconds_pct)}
                </span>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[10px] text-[var(--color-ink-faint)]" data-testid="fleet-cost-share-note">
          Per-monitor <strong>estimate</strong> (labeled est.) — the free-grant-corrected fleet total allocated by
          compute share; Σ reconciles to the fleet estimate, not a billed per-monitor amount. Rate:{" "}
          <span className="sw-mono">${data.rate_used}/active-s</span> ({data.rate_source}).
        </p>
      </div>
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
