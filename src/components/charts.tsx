"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { MetricPoint, Run } from "@/lib/types";
import { formatBytes, formatCount, formatDuration } from "@/lib/format";
import { TONE_VAR } from "@/components/status-badge";
import { cwvTone } from "@/lib/status";

const AXIS = "#5d6b77";
const GRID = "rgba(255,255,255,0.05)";

function timeTick(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

function ChartTooltip({
  active,
  payload,
  label,
  fmt,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string; stroke?: string }>;
  label?: number;
  fmt: (v: number | null) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="sw-panel px-3 py-2 text-xs shadow-xl">
      <div className="sw-mono mb-1 text-[10px] text-[var(--color-ink-faint)]">
        {label ? new Date(label).toLocaleString(undefined, { hour12: false }) : ""}
      </div>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-[var(--color-ink-dim)]">
            <span className="sw-dot" style={{ background: p.color ?? p.stroke }} />
            {p.name}
          </span>
          <span className="sw-mono text-[var(--color-ink)]">
            {fmt(typeof p.value === "number" ? p.value : null)}
          </span>
        </div>
      ))}
    </div>
  );
}

function ChartCard({
  title,
  unit,
  children,
  legend,
}: {
  title: string;
  unit?: string;
  children: React.ReactNode;
  legend?: React.ReactNode;
}) {
  return (
    <div className="sw-panel p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-[var(--color-ink)]">{title}</h3>
        {unit && <span className="sw-mono text-[10px] text-[var(--color-ink-faint)]">{unit}</span>}
      </div>
      {/* The plot occupies a FIXED-height box; the legend sits BELOW it, inside the
          card padding (not inside the 180px box, where it used to overflow). */}
      <div style={{ height: 180 }}>{children}</div>
      {legend && <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">{legend}</div>}
    </div>
  );
}

/** Latency-over-time area chart from run durations. */
export function LatencyChart({ runs }: { runs: Run[] }) {
  const data = runs
    .filter((r) => r.duration_ms !== null)
    .map((r) => ({ ts: new Date(r.started_at).getTime(), duration: r.duration_ms as number }))
    .sort((a, b) => a.ts - b.ts);

  if (data.length === 0) {
    return (
      <ChartCard title="Latency" unit="duration_ms">
        <div className="flex h-full items-center justify-center text-xs text-[var(--color-ink-faint)]">
          no completed runs yet
        </div>
      </ChartCard>
    );
  }

  return (
    <ChartCard title="Latency over time" unit="duration_ms">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
          <defs>
            <linearGradient id="lat" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#45e3c2" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#45e3c2" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="ts"
            type="number"
            domain={["dataMin", "dataMax"]}
            scale="time"
            tickFormatter={timeTick}
            stroke={AXIS}
            tick={{ fontSize: 10 }}
            minTickGap={36}
          />
          <YAxis stroke={AXIS} tick={{ fontSize: 10 }} tickFormatter={(v) => formatDuration(v)} width={56} />
          <Tooltip content={<ChartTooltip fmt={formatDuration} />} />
          <Area
            type="monotone"
            dataKey="duration"
            name="duration"
            stroke="#45e3c2"
            strokeWidth={1.6}
            fill="url(#lat)"
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

interface LineSeries {
  key: keyof MetricPoint;
  label: string;
  color: string;
}

function hasData(data: MetricPoint[], key: keyof MetricPoint): boolean {
  return data.some((d) => typeof d[key] === "number");
}

function MultiLineChart({
  title,
  unit,
  data,
  series,
  fmt,
}: {
  title: string;
  unit: string;
  data: MetricPoint[];
  series: LineSeries[];
  fmt: (v: number | null) => string;
}) {
  const rows = data.map((d) => ({ ts: new Date(d.started_at).getTime(), ...d }));
  const legend = series.map((s) => (
    <span key={String(s.key)} className="flex items-center gap-1.5 text-[11px] text-[var(--color-ink-dim)]">
      <span className="sw-dot" style={{ background: s.color }} />
      {s.label}
    </span>
  ));
  return (
    <ChartCard title={title} unit={unit} legend={legend}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="ts"
            type="number"
            domain={["dataMin", "dataMax"]}
            scale="time"
            tickFormatter={timeTick}
            stroke={AXIS}
            tick={{ fontSize: 10 }}
            minTickGap={36}
          />
          <YAxis stroke={AXIS} tick={{ fontSize: 10 }} tickFormatter={(v) => fmt(v)} width={56} />
          <Tooltip content={<ChartTooltip fmt={fmt} />} />
          {series.map((s) => (
            <Line
              key={String(s.key)}
              type="monotone"
              dataKey={String(s.key)}
              name={s.label}
              stroke={s.color}
              strokeWidth={1.6}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/** A single Core Web Vital, colored by its standard threshold. */
function Vital({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone: ReturnType<typeof cwvTone>;
  hint: string;
}) {
  const color =
    value === "—" ? "var(--color-ink-faint)" : tone === "idle" ? "var(--color-ink)" : TONE_VAR[tone];
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">{label}</div>
      <div className="sw-mono mt-0.5 text-lg font-medium" style={{ color }}>
        {value}
      </div>
      <div className="text-[10px] text-[var(--color-ink-faint)]">{hint}</div>
    </div>
  );
}

/** Latest Core Web Vitals with standard threshold coloring (LCP/CLS/INP). */
function CoreWebVitals({ latest }: { latest: MetricPoint }) {
  const cls = latest.cls != null ? latest.cls.toFixed(3) : "—";
  const inp = latest.inp_ms != null ? formatDuration(latest.inp_ms) : "—";
  return (
    <div className="sw-panel p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-[var(--color-ink)]">Core Web Vitals</h3>
        <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">latest</span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Vital label="LCP" value={formatDuration(latest.lcp_ms)} tone={cwvTone("lcp", latest.lcp_ms)} hint="good ≤ 2.5s" />
        <Vital label="CLS" value={cls} tone={cwvTone("cls", latest.cls)} hint="good ≤ 0.1" />
        <Vital
          label="INP"
          value={inp}
          tone={latest.inp_ms != null ? cwvTone("inp", latest.inp_ms) : "idle"}
          hint={latest.inp_ms != null ? "good ≤ 200ms" : "no interaction"}
        />
        <Vital label="FCP" value={formatDuration(latest.fcp_ms)} tone="idle" hint="for context" />
      </div>
    </div>
  );
}

/**
 * Tier-1 telemetry from run_metrics: a Core Web Vitals summary (fed by the
 * latest row) plus the time-series that actually have data. `hasAny` is driven
 * by whether any metric row exists; HTTP checks have no run_metrics rows, so the
 * parent shows the "browser checks only" message instead.
 */
export function MetricsCharts({ data }: { data: MetricPoint[] }) {
  const vitals: LineSeries[] = (
    [
      { key: "lcp_ms", label: "LCP", color: "#45e3c2" },
      { key: "inp_ms", label: "INP", color: "#e07bb8" },
      { key: "fcp_ms", label: "FCP", color: "#5aa6f2" },
      { key: "ttfb_ms", label: "TTFB", color: "#c08cf0" },
    ] satisfies LineSeries[]
  ).filter((s) => hasData(data, s.key));

  const showCls = hasData(data, "cls");
  const showTransfer = hasData(data, "transfer_bytes");
  const showRequests = hasData(data, "resource_count");
  const showHeap = hasData(data, "js_heap_bytes");
  const showCpu = hasData(data, "cpu_time_ms");

  // Latest reading (by capture time) drives the CWV summary tiles.
  const latest = data.length
    ? data.reduce((a, b) => (new Date(b.captured_at) > new Date(a.captured_at) ? b : a))
    : null;

  const hasAny = latest !== null;

  if (!hasAny) {
    return (
      <div className="sw-panel flex items-center justify-center px-6 py-12 text-sm text-[var(--color-ink-dim)]">
        No telemetry — <span className="sw-mono mx-1 text-[var(--color-ink-faint)]">run_metrics</span> is browser
        checks only.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {latest && <CoreWebVitals latest={latest} />}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {vitals.length > 0 && (
          <MultiLineChart title="Web vitals" unit="ms" data={data} series={vitals} fmt={formatDuration} />
        )}
        {showCls && (
          <MultiLineChart
            title="Layout shift (CLS)"
            unit="score"
            data={data}
            series={[{ key: "cls", label: "CLS", color: "#f3b13c" }]}
            fmt={(v) => (v == null ? "—" : v.toFixed(2))}
          />
        )}
      {showCpu && (
        <MultiLineChart
          title="CPU time"
          unit="ms"
          data={data}
          series={[{ key: "cpu_time_ms", label: "CPU", color: "#f3b13c" }]}
          fmt={formatDuration}
        />
      )}
      {showTransfer && (
        <MultiLineChart
          title="Transfer size"
          unit="bytes"
          data={data}
          series={[{ key: "transfer_bytes", label: "Transfer", color: "#45e3c2" }]}
          fmt={formatBytes}
        />
      )}
      {showHeap && (
        <MultiLineChart
          title="JS heap"
          unit="bytes"
          data={data}
          series={[{ key: "js_heap_bytes", label: "JS heap", color: "#c08cf0" }]}
          fmt={formatBytes}
        />
      )}
      {showRequests && (
        <MultiLineChart
          title="Request count"
          unit="resources"
          data={data}
          series={[{ key: "resource_count", label: "Requests", color: "#5aa6f2" }]}
          fmt={formatCount}
        />
      )}
      </div>
    </div>
  );
}
