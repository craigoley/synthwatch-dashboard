"use client";

import { useState } from "react";

import { useSla } from "@/lib/client";
import { TONE_VAR } from "@/components/status-badge";
import { availabilityTone } from "@/lib/status";
import { formatCount, formatPct } from "@/lib/format";
import type { SlaRow, SlaWindow } from "@/lib/types";

const WINDOWS: SlaWindow[] = ["24h", "7d", "30d"];

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

/** Run-weighted availability across a set of SLA rows (null if no runs). */
function fleetPct(rows: SlaRow[] | undefined): number | null {
  if (!rows || rows.length === 0) return null;
  let up = 0;
  let total = 0;
  for (const r of rows) {
    up += r.up_runs;
    total += r.completed_runs;
  }
  if (total === 0) return null;
  return (up / total) * 100;
}

/** Top-line rolled-up fleet availability for each window (status grid header). */
export function FleetSlaSummary() {
  const w24 = useSla("24h");
  const w7 = useSla("7d");
  const w30 = useSla("30d");
  const byWindow: Record<SlaWindow, SlaRow[] | undefined> = {
    "24h": w24.data,
    "7d": w7.data,
    "30d": w30.data,
  };

  return (
    <div className="sw-panel grid grid-cols-3 divide-x divide-[var(--color-border)] overflow-hidden">
      {WINDOWS.map((win) => {
        const pct = fleetPct(byWindow[win]);
        return (
          <div key={win} className="px-4 py-3">
            <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
              Availability · {win}
            </div>
            <SlaPercent pct={pct} className="mt-1 text-2xl font-medium" />
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

  const rowFor = (rows: SlaRow[] | undefined): SlaRow | undefined =>
    rows?.find((r) => r.check_id === checkId);
  const byWindow: Record<SlaWindow, SlaRow | undefined> = {
    "24h": rowFor(w24.data),
    "7d": rowFor(w7.data),
    "30d": rowFor(w30.data),
  };
  const loading = w24.isLoading && w7.isLoading && w30.isLoading;
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

      {/* the three windows side by side; the active one is highlighted */}
      <div className="grid grid-cols-3 gap-3">
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
              <SlaPercent pct={row?.availability_pct ?? null} className="mt-0.5 text-lg font-medium" />
            </button>
          );
        })}
      </div>

      {/* up / down / total for the selected window */}
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
