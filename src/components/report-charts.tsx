"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { ReportSeriesPoint } from "@/lib/types";

const AXIS = "#5d6b77";
const GRID = "rgba(255,255,255,0.05)";

const dayTick = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "numeric", day: "numeric" });

function TrendTip({
  active,
  payload,
  label,
  unit,
  fmt,
}: {
  active?: boolean;
  payload?: Array<{ value?: number; stroke?: string }>;
  label?: string;
  unit: string;
  fmt: (v: number | null) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="sw-panel px-3 py-2 text-xs shadow-xl">
      <div className="sw-mono mb-1 text-[10px] text-[var(--color-ink-faint)]">{label}</div>
      <div className="flex items-center justify-between gap-4">
        <span className="flex items-center gap-1.5 text-[var(--color-ink-dim)]">
          <span className="sw-dot" style={{ background: payload[0]?.stroke }} />
          {unit}
        </span>
        <span className="sw-mono text-[var(--color-ink)]">
          {fmt(typeof payload[0]?.value === "number" ? (payload[0]!.value as number) : null)}
        </span>
      </div>
    </div>
  );
}

/** A daily trend line for a report metric (availability% or latency). Null points are gaps. */
export function TrendChart({
  series,
  unit,
  color,
  fmt,
  domain,
}: {
  series: ReportSeriesPoint[];
  unit: string;
  color: string;
  fmt: (v: number | null) => string;
  domain?: [number | "auto", number | "auto"];
}) {
  const rows = series.map((p) => ({ date: p.date, value: p.value }));
  if (rows.length === 0) {
    return (
      <div className="flex h-[120px] items-center justify-center text-xs text-[var(--color-ink-faint)]">
        no data in this window
      </div>
    );
  }
  return (
    <div style={{ height: 120 }} data-testid="trend-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="date" tickFormatter={dayTick} stroke={AXIS} tick={{ fontSize: 10 }} minTickGap={28} />
          <YAxis
            domain={domain ?? ["auto", "auto"]}
            stroke={AXIS}
            tick={{ fontSize: 10 }}
            tickFormatter={(v) => fmt(v as number)}
            width={44}
          />
          <Tooltip content={<TrendTip unit={unit} fmt={fmt} />} />
          <Line
            type="monotone"
            dataKey="value"
            name={unit}
            stroke={color}
            strokeWidth={1.6}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
