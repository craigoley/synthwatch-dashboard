"use client";

import { useSloReport } from "@/lib/client";
import { TONE_VAR } from "@/components/status-badge";
import { formatPct } from "@/lib/format";
import type { ReportWindow, Tag, SloReportRow, SloReportFleet } from "@/lib/types";

// ★ Fleet error-budget view (P5 v1). Budget ACCOUNTING only — visually consistent with the check-detail
// SloPanel (same tone thresholds + budget-remaining bar) but at fleet scope. burn_rate is INFORMATIONAL
// (pooled), never a page-grade pill here — the fast/slow-burn pills stay on the monitor (they need
// location-aware burn: the follow-up PR). insufficient_data → "building baseline", never a fake %.

type Tone = "pass" | "warn" | "fail" | "idle";

/** Mirror SloPanel: blown (remaining<0) → fail, ≤20% remaining → warn, else pass; idle while building. */
function budgetTone(remaining: number, budget: number, insufficient: boolean): Tone {
  if (insufficient || budget <= 0) return "idle";
  if (remaining < 0) return "fail";
  return remaining / budget <= 0.2 ? "warn" : "pass";
}
/** remaining/budget as a fraction (null while building / no budget), like SloPanel's remainingFraction. */
function remainingFraction(r: { remaining: number; budget: number; insufficient_data: boolean }): number | null {
  return r.insufficient_data || r.budget <= 0 ? null : r.remaining / r.budget;
}
const barWidth = (frac: number | null) => (frac === null ? 0 : Math.max(0, Math.min(100, frac * 100)));

function BudgetBar({ frac, tone }: { frac: number | null; tone: Tone }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-bg)]">
      <div className="h-full rounded-full" style={{ width: `${barWidth(frac)}%`, background: TONE_VAR[tone] }} />
    </div>
  );
}

function FleetRollup({ fleet }: { fleet: SloReportFleet }) {
  const tone = budgetTone(fleet.remaining, fleet.budget, fleet.insufficient_data);
  const frac = remainingFraction(fleet);
  const blown = !fleet.insufficient_data && fleet.remaining < 0;
  return (
    <div className="sw-panel p-4" data-testid="fleet-slo-rollup">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--color-ink)]">Error budget · fleet</h3>
        <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
          {fleet.consumed.toLocaleString()} / {fleet.budget.toLocaleString()} down-runs
        </span>
      </div>
      {fleet.insufficient_data ? (
        <p className="text-[13px] text-[var(--color-ink-dim)]" data-testid="fleet-slo-building">
          Building baseline — not enough completed runs in the window yet.
        </p>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className="sw-mono text-2xl font-medium tabular-nums" style={{ color: TONE_VAR[tone] }}>
              {blown ? "Budget blown" : formatPct((frac as number) * 100, 1)}
            </span>
            <span className="text-[12px] text-[var(--color-ink-dim)]">{blown ? "over budget" : "budget remaining"}</span>
          </div>
          <div className="mt-2">
            <BudgetBar frac={frac} tone={tone} />
          </div>
        </>
      )}
    </div>
  );
}

function SloRow({ row, window }: { row: SloReportRow; window: ReportWindow }) {
  const tone = budgetTone(row.remaining, row.budget, row.insufficient_data);
  const frac = remainingFraction(row);
  const blown = !row.insufficient_data && row.remaining < 0;
  return (
    <div
      data-testid={`slo-row-${row.check_id}`}
      className="grid grid-cols-1 gap-2 px-4 py-3 sm:grid-cols-[1fr_70px_1fr_90px] sm:items-center sm:gap-3"
    >
      <div className="min-w-0">
        <span className="block truncate text-sm text-[var(--color-ink)]">{row.check_name}</span>
        <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">{row.kind}</span>
      </div>
      <span className="sw-mono text-[12px] text-[var(--color-ink-dim)]" title="SLO target">
        {formatPct(row.target * 100, row.target * 100 % 1 === 0 ? 0 : 1)}
      </span>
      {row.insufficient_data ? (
        <span className="text-[12px] text-[var(--color-ink-faint)]" data-testid="slo-building">
          building baseline
        </span>
      ) : (
        <div className="flex items-center gap-2">
          <BudgetBar frac={frac} tone={tone} />
          <span className="sw-mono shrink-0 text-[12px] tabular-nums" style={{ color: TONE_VAR[tone] }}>
            {blown ? "blown" : formatPct((frac as number) * 100, 0)}
          </span>
        </div>
      )}
      {/* Informational, pooled — NOT a burn pill. */}
      <span
        className="sw-mono text-right text-[12px] text-[var(--color-ink-faint)]"
        title="Pooled burn rate over the window — informational, not a page-grade alert (burn alerts live on the monitor)."
      >
        {row.burn_rate == null ? "—" : `${row.burn_rate.toFixed(1)}×`}
      </span>
    </div>
  );
}

export function FleetSloReport({ window, tags = [] }: { window: ReportWindow; tags?: Tag[] }) {
  const { data } = useSloReport(window, tags);
  // Endpoint absent (companion API not deployed) OR loading → hide quietly (data is null on 404).
  if (!data) return null;

  if (data.items.length === 0) {
    // Scoped-empty is honest; globally-empty (no SLO targets set) just hides — discoverable on check-detail.
    if (tags.length === 0) return null;
    return (
      <section className="sw-panel p-4" data-testid="fleet-slo">
        <h3 className="mb-1 text-sm font-semibold text-[var(--color-ink)]">Error budget</h3>
        <p className="text-[13px] text-[var(--color-ink-dim)]">No SLO monitors match this filter.</p>
      </section>
    );
  }

  // Most-at-risk first: lowest remaining fraction (blown = negative sorts first); building (null) last.
  const sorted = [...data.items].sort((a, b) => {
    const av = remainingFraction(a);
    const bv = remainingFraction(b);
    if (av === null && bv === null) return a.check_name.localeCompare(b.check_name);
    if (av === null) return 1;
    if (bv === null) return -1;
    return av - bv || a.check_name.localeCompare(b.check_name);
  });

  return (
    <section className="space-y-3" data-testid="fleet-slo">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">Error budget</h2>
        <span className="text-[11px] text-[var(--color-ink-faint)]">
          budget accounting over {window} · burn alerts live on each monitor
        </span>
      </div>
      {data.fleet && <FleetRollup fleet={data.fleet} />}
      <div className="sw-panel overflow-hidden">
        <div className="hidden grid-cols-[1fr_70px_1fr_90px] gap-3 border-b border-[var(--color-border)] px-4 py-2.5 text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)] sm:grid">
          <span>Monitor</span>
          <span>Target</span>
          <span>Budget remaining</span>
          <span className="text-right">Burn (pooled)</span>
        </div>
        <div className="divide-y divide-[var(--color-border)]">
          {sorted.map((row) => (
            <SloRow key={row.check_id} row={row} window={window} />
          ))}
        </div>
      </div>
    </section>
  );
}
