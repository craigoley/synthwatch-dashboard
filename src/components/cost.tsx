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

const SECONDS_PER_MONTH = 2_592_000; // 30d × 86400 — matches the API's runs/month divisor.

/** $ with honest small-value handling — never a fake $0.00 for a real-but-tiny cost. */
function money(n: number): string {
  if (n <= 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/** The estimate provenance line, read from the endpoint's echoed rate (never hardcoded). */
function estimateLabel(r: CostReport): string {
  return `Estimate · rate $${r.rate_used}/vCPU-s (${r.rate_source}, set ${r.rate_set_date}). The Azure bill is ground truth.`;
}

function DivergenceFlag({ c }: { c: CostCheck }) {
  if (!c.divergence_flag) return null;
  const x = c.divergence_ratio != null ? `${c.divergence_ratio.toFixed(1)}×` : "";
  return (
    <span
      data-testid={`cost-divergence-${c.check_id}`}
      className="sw-mono text-[10px]"
      style={{ color: "var(--color-warn)" }}
      title={`Measured 7d cost is ${x} the projection — retries or failing runs are costing more than the config implies.`}
    >
      ⚠ costing {x} projected — check for retries/failures
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
  const drivers = data.top_cost_drivers.length > 0 ? data.top_cost_drivers : data.checks.slice(0, 5);

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
        {estimateLabel(data)}
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
  if (error || !data) return null; // additive panel — self-hide when unavailable
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
          title={estimateLabel(data)}
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
            {c.region_count === 1 ? "" : "s"} × ${data.rate_used}/vCPU-s
          </p>

          {c.divergence_flag && (
            <p className="mt-2 text-[11px]" style={{ color: "var(--color-warn)" }} data-testid="monitor-cost-divergence">
              ⚠ Measured cost is {c.divergence_ratio != null ? `${c.divergence_ratio.toFixed(1)}× ` : ""}the projection
              — check for retries / failing runs.
            </p>
          )}
        </>
      )}
    </div>
  );
}
