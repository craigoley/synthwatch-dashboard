"use client";

import { useMemo, useState } from "react";

import { lookbackRange } from "@/lib/format";
import type { CursorRangePreset } from "@/lib/types";

/** The resolved ISO window a cursor list sends to the API (both ends optional → API defaults). */
export interface DateRange {
  from?: string;
  to?: string;
}

const PRESETS: { key: CursorRangePreset; label: string; days: number }[] = [
  { key: "7d", label: "Last 7d", days: 7 },
  { key: "30d", label: "30d", days: 30 },
  { key: "90d", label: "90d", days: 90 },
];

type Mode = CursorRangePreset | "custom";

/** "YYYY-MM-DD" (from <input type=date>) → an ISO instant at the day's UTC start/end. */
const dayStart = (d: string): string | undefined => (d ? `${d}T00:00:00.000Z` : undefined);
const dayEnd = (d: string): string | undefined => (d ? `${d}T23:59:59.999Z` : undefined);

/**
 * Owns the date-range state shared by every cursor list (runs, incidents). Returns the current
 * mode + the resolved {from,to} window. `defaultPreset` lets a sparser list (incidents) open on a
 * wider default than runs. Pair with <DateRangeControl> for the segmented UX.
 */
export function useDateRange(defaultPreset: CursorRangePreset = "7d") {
  const [mode, setMode] = useState<Mode>(defaultPreset);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const range = useMemo<DateRange>(() => {
    if (mode === "custom") return { from: dayStart(customFrom), to: dayEnd(customTo) };
    const days = PRESETS.find((p) => p.key === mode)?.days ?? 7;
    return lookbackRange(days);
  }, [mode, customFrom, customTo]);

  return { mode, setMode, customFrom, setCustomFrom, customTo, setCustomTo, range };
}

export type DateRangeState = ReturnType<typeof useDateRange>;

/**
 * Segmented date-range control (Last 7d / 30d / 90d / Custom) — the shared filter UX for cursor
 * lists. Presentational: it drives the `state` from useDateRange. `onModeChange` fires only on a
 * user pick (so the parent can reset its cursor walk). `testIdPrefix` scopes the custom inputs'
 * data-testids per surface (e.g. "run-history" → run-history-from/-to).
 */
export function DateRangeControl({
  state,
  onModeChange,
  ariaLabel,
  testIdPrefix,
}: {
  state: DateRangeState;
  onModeChange?: (mode: Mode) => void;
  ariaLabel: string;
  testIdPrefix: string;
}) {
  const { mode, setMode, customFrom, setCustomFrom, customTo, setCustomTo } = state;

  function pick(next: Mode) {
    setMode(next);
    onModeChange?.(next);
  }

  const btn = (active: boolean) =>
    `rounded-md px-2.5 py-1 text-xs sw-mono transition ${
      active
        ? "bg-[var(--color-panel-2)] text-[var(--color-ink)]"
        : "text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
    }`;

  return (
    <div className="flex flex-col items-end gap-2">
      <div
        className="inline-flex rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] p-0.5"
        role="group"
        aria-label={ariaLabel}
      >
        {PRESETS.map((p) => (
          <button key={p.key} type="button" aria-pressed={mode === p.key} onClick={() => pick(p.key)} className={btn(mode === p.key)}>
            {p.label}
          </button>
        ))}
        <button type="button" aria-pressed={mode === "custom"} onClick={() => pick("custom")} className={btn(mode === "custom")}>
          Custom
        </button>
      </div>

      {mode === "custom" && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-ink-dim)]">
          <label className="flex items-center gap-1.5">
            From
            <input
              type="date"
              value={customFrom}
              max={customTo || undefined}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 sw-mono"
              data-testid={`${testIdPrefix}-from`}
            />
          </label>
          <label className="flex items-center gap-1.5">
            To
            <input
              type="date"
              value={customTo}
              min={customFrom || undefined}
              onChange={(e) => setCustomTo(e.target.value)}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 sw-mono"
              data-testid={`${testIdPrefix}-to`}
            />
          </label>
        </div>
      )}
    </div>
  );
}
