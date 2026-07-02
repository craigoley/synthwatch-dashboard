"use client";

import { useSloReport } from "@/lib/client";
import { TONE_VAR } from "@/components/status-badge";
import { ErrorState } from "@/components/states";
import { StalenessStamp, useFetchedAt } from "@/components/staleness";
import { formatPct } from "@/lib/format";
import type { ReportWindow, Tag, SloReportRow, SloReportFleet } from "@/lib/types";

// ★ Fleet error-budget view (P5 v1). Budget ACCOUNTING only — visually consistent with the check-detail
// SloPanel (same tone thresholds + budget-remaining bar) but at fleet scope. ★ P5 PR2: the fast/slow-burn
// pill is now REAL + page-worthy here — driven by burn_state from slo_burn_status (the SAME location-aware
// verdict the runner pages on: read == page), replacing PR1's informational pooled burn number.
// insufficient_data → "building baseline", never a fake %.

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

function SloRow({ row }: { row: SloReportRow }) {
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
      {/* ★ P5 PR2 — the page-worthy, location-aware burn pill (the SAME verdict the runner pages on). */}
      <BurnPill state={row.burn_state} burn={row.reported_burn} />
    </div>
  );
}

// Fast (1h ≥ 14.4× → critical) / slow (6h + 30m ≥ 6× → ticket) / none (within budget). Null-safe: a missing
// field (older API) degrades to 'none'/0, never a crash (the .tone-crash lesson) — the pill just shows "—".
function BurnPill({ state, burn }: { state?: SloReportRow["burn_state"] | null; burn?: number | null }) {
  const s = state ?? "none";
  const b = burn ?? 0;
  if (s === "none") {
    return (
      <span
        className="sw-mono text-right text-[12px] text-[var(--color-ink-faint)]"
        title="Within error budget — no burn page."
      >
        —
      </span>
    );
  }
  const critical = s === "fast";
  const color = critical ? "var(--color-fail)" : "var(--color-warn)";
  return (
    <span
      data-testid={`slo-burn-${s}`}
      className="sw-mono inline-flex shrink-0 items-center justify-end gap-1 justify-self-end rounded px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide"
      style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
      title={`${critical ? "Fast burn (1h ≥ 14.4×) — page-worthy" : "Slow burn (6h + 30m ≥ 6×) — ticket"}. Location-aware — the same verdict the runner pages on.`}
    >
      {critical ? "fast" : "slow"}
      {b > 0 ? ` ${b.toFixed(1)}×` : ""}
    </span>
  );
}

export function FleetSloReport({ window, tags = [] }: { window: ReportWindow; tags?: Tag[] }) {
  const { data, error, isValidating, mutate } = useSloReport(window, tags);
  const fetchedAt = useFetchedAt(isValidating, data != null); // called before early returns (hooks rule)
  // ★ Loud-not-silent: a real error (500/network/parse) shows a visible error state — a monitoring panel must
  // NEVER vanish on incident day looking like "not deployed". A 404 → data null → hide (feature absent, correct).
  if (error) return <ErrorState testId="fleet-slo-error" message="Error budget failed to load — retry." />;
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
        <span className="flex items-center gap-3 text-[11px] text-[var(--color-ink-faint)]">
          budget accounting over {window} · burn alerts live on each monitor
          <StalenessStamp fetchedAt={fetchedAt} onRefresh={() => mutate()} refreshing={isValidating} testId="fleet-slo" />
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
            <SloRow key={row.check_id} row={row} />
          ))}
        </div>
      </div>
    </section>
  );
}
