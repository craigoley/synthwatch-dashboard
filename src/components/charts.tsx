"use client";

import { useState } from "react";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { MetricPoint, Run, SlaWindow, WebVitals, ReportSeriesPoint } from "@/lib/types";
import { formatBytes, formatCount, formatDuration } from "@/lib/format";
import { TONE_VAR } from "@/components/status-badge";
import { cwvTone } from "@/lib/status";
import { useAvailabilitySeries, useIncidents } from "@/lib/client";

const AXIS = "#5d6b77";
const GRID = "rgba(255,255,255,0.05)";

function timeTick(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

function dateTick(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
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
  action,
}: {
  title: string;
  unit?: string;
  children: React.ReactNode;
  legend?: React.ReactNode;
  /** A header control (e.g. a window toggle), shown on the right instead of `unit`. */
  action?: React.ReactNode;
}) {
  return (
    <div className="sw-panel p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--color-ink)]">{title}</h3>
        {action ?? (unit && <span className="sw-mono text-[10px] text-[var(--color-ink-faint)]">{unit}</span>)}
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

const AVAIL_WINDOWS: SlaWindow[] = ["24h", "7d", "30d", "90d"];
const pctAxis = (v: number) => `${v}%`;
const pctTip = (v: number | null) => (v == null ? "no data" : `${v.toFixed(2)}%`);

/**
 * Availability (uptime) over time — complements the SLA panel (point-in-time % per
 * window) with the SHAPE over a window. Self-contained: own window toggle + fetch.
 *  • y-domain is zoomed (min−1 → 100) so small dips (99→100) are visible, with the
 *    100% baseline always shown; a real 0% dip still spans the full range.
 *  • null buckets are a GAP in the line (connectNulls=false), not a 0% drop.
 *  • the check's incidents are overlaid as red markers at their open time.
 */
export function AvailabilityChart({ checkId }: { checkId: number }) {
  const [win, setWin] = useState<SlaWindow>("24h");
  const { data, isLoading } = useAvailabilitySeries(checkId, win);
  const { data: incidents } = useIncidents();

  const rows = (data?.points ?? []).map((p) => ({ ts: new Date(p.ts).getTime(), pct: p.availability_pct }));
  const vals = rows.map((r) => r.pct).filter((v): v is number => v != null);
  const lo = vals.length ? Math.min(...vals) : 100;
  // Zoom so small dips are visible, but never hide the 100% baseline.
  const domainMin = Math.max(0, Math.min(99, Math.floor(lo) - 1));
  const tickFn = data?.bucket === "day" ? dateTick : timeTick;

  const tsMin = rows[0]?.ts;
  const tsMax = rows[rows.length - 1]?.ts;
  const marks =
    tsMin != null && tsMax != null
      ? [...(incidents?.open ?? []), ...(incidents?.resolved ?? [])]
          .filter((i) => i.check_id === checkId)
          .map((i) => ({ id: i.id, ts: new Date(i.opened_at).getTime() }))
          .filter((m) => m.ts >= tsMin && m.ts <= tsMax)
      : [];

  const toggle = (
    <div className="inline-flex rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] p-0.5">
      {AVAIL_WINDOWS.map((w) => (
        <button
          key={w}
          type="button"
          onClick={() => setWin(w)}
          className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition ${
            w === win
              ? "bg-[var(--color-panel-2)] text-[var(--color-ink)]"
              : "text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
          }`}
        >
          {w}
        </button>
      ))}
    </div>
  );

  return (
    <ChartCard title="Availability over time" action={toggle}>
      {rows.length === 0 ? (
        <div className="flex h-full items-center justify-center text-xs text-[var(--color-ink-faint)]">
          {isLoading ? "loading…" : "no availability data in this window yet"}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -4 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis
              dataKey="ts"
              type="number"
              domain={["dataMin", "dataMax"]}
              scale="time"
              tickFormatter={tickFn}
              stroke={AXIS}
              tick={{ fontSize: 10 }}
              minTickGap={36}
            />
            <YAxis domain={[domainMin, 100]} stroke={AXIS} tick={{ fontSize: 10 }} tickFormatter={pctAxis} width={44} />
            <Tooltip content={<ChartTooltip fmt={pctTip} />} />
            {marks.map((m) => (
              <ReferenceLine
                key={m.id}
                x={m.ts}
                stroke="var(--color-fail)"
                strokeDasharray="3 3"
                label={{ value: `#${m.id}`, fontSize: 9, fill: "var(--color-fail)", position: "insideTopRight" }}
              />
            ))}
            <Line
              type="monotone"
              dataKey="pct"
              name="availability"
              stroke="#45e3c2"
              strokeWidth={1.6}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
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
 * Fleet/group Core Web Vitals at p75 — fed by the /reports/performance group `web_vitals` the reports page
 * already fetches (and previously dropped). Reuses the Vital tile + cwvTone threshold authority (single
 * source). Gaps-not-zeros: a null vital renders "—", never a 0 or a false "good". INP is not yet captured
 * at the rollup (proposal P9) → shown as "—" with an explicit "not captured yet" hint, never faked.
 */
export function ReportWebVitals({
  vitals,
  browserCheckCount,
}: {
  vitals: WebVitals | null;
  browserCheckCount: number;
}) {
  if (!vitals || browserCheckCount === 0) return null; // no browser monitors → no vitals (honest absence)
  const ms = (v: number | null) => (v != null ? formatDuration(v) : "—");
  return (
    <div className="sw-panel p-4" data-testid="report-cwv">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--color-ink)]">Core Web Vitals · p75</h3>
        <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
          {browserCheckCount} browser monitor{browserCheckCount === 1 ? "" : "s"}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Vital label="LCP" value={ms(vitals.lcp_ms)} tone={cwvTone("lcp", vitals.lcp_ms)} hint="good ≤ 2.5s" />
        <Vital
          label="CLS"
          value={vitals.cls != null ? vitals.cls.toFixed(3) : "—"}
          tone={cwvTone("cls", vitals.cls)}
          hint="good ≤ 0.1"
        />
        <Vital label="FCP" value={ms(vitals.fcp_ms)} tone={cwvTone("fcp", vitals.fcp_ms)} hint="good ≤ 1.8s" />
        <Vital label="TTFB" value={ms(vitals.ttfb_ms)} tone={cwvTone("ttfb", vitals.ttfb_ms)} hint="good ≤ 0.8s" />
        {/* INP is a Core Web Vital but isn't aggregated into the rollup yet (P9) — honest placeholder, not a fake 0. */}
        <Vital label="INP" value="—" tone="idle" hint="not captured yet" />
      </div>
    </div>
  );
}

/**
 * Generic area trend over a report's daily `series` ({date, value}) — the FLEET availability + avg-latency
 * trends the reports page already fetches in groups[0].series but never rendered. null buckets are a GAP
 * (connectNulls=false), not a 0 (the gaps-not-zeros discipline). The line uses the brand token (decorative,
 * not a status encoding).
 */
export function ReportSeriesArea({
  title,
  unit,
  points,
  fmt,
}: {
  title: string;
  unit: string;
  points: ReportSeriesPoint[];
  fmt: (v: number | null) => string;
}) {
  const slug = title.replace(/\W+/g, "");
  const data = points.map((p) => ({ ts: new Date(p.date).getTime(), value: p.value }));
  if (data.length === 0) {
    return (
      <ChartCard title={title} unit={unit}>
        <div className="flex h-full items-center justify-center text-xs text-[var(--color-ink-faint)]">
          no data in this window
        </div>
      </ChartCard>
    );
  }
  return (
    <ChartCard title={title} unit={unit}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
          <defs>
            <linearGradient id={`rs-${slug}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-brand)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--color-brand)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="ts"
            type="number"
            domain={["dataMin", "dataMax"]}
            scale="time"
            tickFormatter={dateTick}
            stroke={AXIS}
            tick={{ fontSize: 10 }}
            minTickGap={36}
          />
          <YAxis stroke={AXIS} tick={{ fontSize: 10 }} tickFormatter={(v) => fmt(v)} width={56} />
          <Tooltip content={<ChartTooltip fmt={fmt} />} />
          <Area
            type="monotone"
            dataKey="value"
            name={title}
            stroke="var(--color-brand)"
            strokeWidth={1.6}
            fill={`url(#rs-${slug})`}
            connectNulls={false}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
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
