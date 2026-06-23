"use client";

import { useState } from "react";

import { useSla } from "@/lib/client";
import { TONE_VAR } from "@/components/status-badge";
import { availabilityTone } from "@/lib/status";
import { formatCount, formatPct } from "@/lib/format";
import type { SlaFleet, SlaWindow, Slo } from "@/lib/types";

const WINDOWS: SlaWindow[] = ["24h", "7d", "30d", "90d"];

/** Calm, color-coded availability percentage. */
export function SlaPercent({
  pct,
  className = "",
}: {
  pct: number | null;
  className?: string;
}) {
  const tone = availabilityTone(pct);
  return (
    <span className={`sw-mono tabular-nums ${className}`} style={{ color: TONE_VAR[tone] }}>
      {formatPct(pct)}
    </span>
  );
}

/**
 * Renders availability for a window. When the API marks the window
 * `insufficient_data` (not enough completed runs yet), show a calm
 * "building baseline" label — neutral, NOT a red breach and NOT a number.
 * Otherwise show the real percentage.
 */
export function AvailabilityValue({
  pct,
  insufficient,
  className = "",
  compact = false,
}: {
  pct: number | null;
  insufficient: boolean;
  className?: string;
  compact?: boolean;
}) {
  if (insufficient) {
    return (
      <span
        className={`sw-mono ${className} text-[var(--color-ink-faint)]`}
        title="Building baseline — not enough completed runs in this window yet"
      >
        {compact ? "building…" : "building baseline"}
      </span>
    );
  }
  return <SlaPercent pct={pct} className={className} />;
}

/**
 * Top-line fleet availability per window. Consumes the API's server-computed
 * (run-weighted) `fleet` object — no client-side count summation — so windows
 * without enough history read "building baseline" instead of a misleading %.
 */
export function FleetSlaSummary() {
  const w24 = useSla("24h");
  const w7 = useSla("7d");
  const w30 = useSla("30d");
  const w90 = useSla("90d");
  const fleetByWindow: Record<SlaWindow, SlaFleet | null | undefined> = {
    "24h": w24.data?.fleet,
    "7d": w7.data?.fleet,
    "30d": w30.data?.fleet,
    "90d": w90.data?.fleet,
  };

  return (
    <div className="sw-panel grid grid-cols-4 divide-x divide-[var(--color-border)] overflow-hidden">
      {WINDOWS.map((win) => {
        const fleet = fleetByWindow[win];
        return (
          <div key={win} className="px-3 py-3 sm:px-4">
            <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
              Availability · {win}
            </div>
            <AvailabilityValue
              pct={fleet?.availability_pct ?? null}
              insufficient={fleet?.insufficient_data ?? false}
              compact
              className="mt-1 text-xl font-medium sm:text-2xl"
            />
          </div>
        );
      })}
    </div>
  );
}

/** Per-check availability panel with a window toggle (check detail page). */
export function CheckSlaPanel({ checkId }: { checkId: number }) {
  const [active, setActive] = useState<SlaWindow>("24h");
  const w24 = useSla("24h");
  const w7 = useSla("7d");
  const w30 = useSla("30d");
  const w90 = useSla("90d");

  const find = (resp: typeof w24.data) => resp?.items.find((r) => r.check_id === checkId);
  const byWindow: Record<SlaWindow, ReturnType<typeof find>> = {
    "24h": find(w24.data),
    "7d": find(w7.data),
    "30d": find(w30.data),
    "90d": find(w90.data),
  };
  const loading = w24.isLoading && w7.isLoading && w30.isLoading && w90.isLoading;
  const selected = byWindow[active];

  return (
    <div className="sw-panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--color-ink)]">Availability (SLA)</h3>
        <div className="inline-flex rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] p-0.5">
          {WINDOWS.map((win) => (
            <button
              key={win}
              type="button"
              onClick={() => setActive(win)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                active === win
                  ? "bg-[var(--color-panel-2)] text-[var(--color-ink)]"
                  : "text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
              }`}
            >
              {win}
            </button>
          ))}
        </div>
      </div>

      {/* the windows side by side; the active one is highlighted */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {WINDOWS.map((win) => {
          const row = byWindow[win];
          const isActive = win === active;
          return (
            <button
              key={win}
              type="button"
              onClick={() => setActive(win)}
              className="rounded-lg border px-3 py-2.5 text-left transition"
              style={{
                borderColor: isActive ? "var(--color-border-strong)" : "var(--color-border)",
                background: isActive ? "var(--color-bg)" : "transparent",
              }}
            >
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">{win}</div>
              <AvailabilityValue
                pct={row?.availability_pct ?? null}
                insufficient={row?.insufficient_data ?? false}
                className="mt-0.5 text-lg font-medium"
              />
            </button>
          );
        })}
      </div>

      {/* up / down / total for the selected window (counts exist even when the
          percentage is still building a baseline) */}
      <div className="mt-3 grid grid-cols-3 gap-3 border-t border-[var(--color-border)] pt-3">
        <Stat label="Up" value={formatCount(selected?.up_runs)} tone="pass" />
        <Stat label="Down" value={formatCount(selected?.down_runs)} tone={selected && selected.down_runs > 0 ? "fail" : "idle"} />
        <Stat label="Completed" value={formatCount(selected?.completed_runs)} tone="idle" />
      </div>

      {!loading && !selected && (
        <p className="mt-3 text-xs text-[var(--color-ink-faint)]">No completed runs in this window.</p>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "pass" | "fail" | "idle";
}) {
  return (
    <div>
      <div className="sw-mono text-lg" style={{ color: tone === "idle" ? "var(--color-ink)" : TONE_VAR[tone] }}>
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">{label}</div>
    </div>
  );
}

function fmtBudget(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Number(n.toFixed(1)).toLocaleString();
}

function BurnPill({
  label,
  firing,
  firingTone,
}: {
  label: string;
  firing: boolean;
  firingTone: "fail" | "warn";
}) {
  return (
    <span
      className="sw-mono rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider"
      style={
        firing
          ? { borderColor: TONE_VAR[firingTone], color: TONE_VAR[firingTone] }
          : { borderColor: "var(--color-border-strong)", color: "var(--color-ink-faint)" }
      }
    >
      {label}: {firing ? "firing ⚠" : "ok"}
    </span>
  );
}

/**
 * SLO error-budget + burn-rate panel (check detail). Complements the SLA panel
 * (availability %) — this adds the target, budget-remaining gauge, and multi-window
 * burn state. Only rendered when the check has an SLO (opt-in); see the detail page.
 *   green = plenty · amber = ≤20% left · red = exhausted/blown (remaining < 0).
 */
export function SloPanel({ slo }: { slo: Slo }) {
  const targetPct = Number.isFinite(slo.target) ? slo.target * 100 : null;
  const hasBudget = Number.isFinite(slo.budget) && slo.budget > 0;
  const remainingFraction = hasBudget ? slo.remaining / slo.budget : null;
  const blown = Number.isFinite(slo.remaining) && slo.remaining < 0;
  const tone: "pass" | "warn" | "fail" = blown
    ? "fail"
    : remainingFraction !== null && remainingFraction <= 0.2
      ? "warn"
      : "pass";
  const barPct = remainingFraction === null ? 0 : Math.max(0, Math.min(100, remainingFraction * 100));
  const burnRate = Number.isFinite(slo.burnRate) ? slo.burnRate : null;
  const burnTone: "pass" | "warn" | "fail" = slo.fastBurn ? "fail" : slo.slowBurn ? "warn" : "pass";

  return (
    <div className="sw-panel p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-[var(--color-ink)]">Error budget (SLO)</h3>
        <span className="sw-mono text-[11px] text-[var(--color-ink-dim)]">
          {targetPct === null ? "—" : formatPct(targetPct)} target
        </span>
      </div>

      {hasBudget ? (
        <>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="sw-mono text-2xl font-medium tabular-nums" style={{ color: TONE_VAR[tone] }}>
              {blown ? "Budget blown" : formatPct((remainingFraction as number) * 100, 1)}
            </span>
            <span className="text-[11px] uppercase tracking-wider text-[var(--color-ink-faint)]">
              {blown ? "over budget" : "budget remaining"}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full border border-[var(--color-border)] bg-[var(--color-bg)]">
            <div className="h-full rounded-full" style={{ width: `${barPct}%`, background: TONE_VAR[tone] }} />
          </div>
        </>
      ) : (
        <p className="text-sm text-[var(--color-ink-dim)]">
          Building budget — not enough completed runs in the window yet.
        </p>
      )}

      <div className="mt-3 grid grid-cols-3 gap-3 border-t border-[var(--color-border)] pt-3">
        <Stat label="Consumed" value={fmtBudget(slo.consumed)} tone={slo.consumed > 0 ? "fail" : "idle"} />
        <Stat label="Remaining" value={fmtBudget(slo.remaining)} tone={blown ? "fail" : "idle"} />
        <Stat label="Budget" value={fmtBudget(slo.budget)} tone="idle" />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-3">
        <span className="sw-mono text-sm font-medium" style={{ color: TONE_VAR[burnTone] }}>
          {burnRate === null ? "—" : `${burnRate.toFixed(1)}×`} burn rate
        </span>
        <BurnPill label="Fast burn (1h)" firing={slo.fastBurn} firingTone="fail" />
        <BurnPill label="Slow burn (6h)" firing={slo.slowBurn} firingTone="warn" />
      </div>
    </div>
  );
}
