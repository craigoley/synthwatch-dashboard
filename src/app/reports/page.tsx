"use client";

import { useState } from "react";

import { useAvailabilityReport, usePerformanceReport } from "@/lib/client";
import { EmptyState, Spinner } from "@/components/states";
import { TrendChart } from "@/components/report-charts";
import { formatDuration, formatPct } from "@/lib/format";
import type {
  AvailabilityGroup,
  AvailabilityReport,
  PerformanceGroup,
  PerformanceReport,
  ReportWindow,
  WebVitals,
} from "@/lib/types";

const WINDOWS: ReportWindow[] = ["7d", "30d", "90d"];
const GROUP_BYS = ["none", "team", "service", "env", "criticality"];
type ReportKind = "availability" | "performance";

function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex flex-wrap gap-0.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition ${
            value === o.value
              ? "bg-[var(--color-panel-2)] text-[var(--color-ink)]"
              : "text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const groupLabel = (groupBy: string, group: string) =>
  groupBy === "none" || group === "ungrouped" || group === "all" ? "All checks" : `${groupBy}: ${group}`;

function fmtMinutes(m: number): string {
  if (!m) return "none";
  if (m < 60) return `${Math.round(m)}m`;
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  return r ? `${h}h ${r}m` : `${h}h`;
}

function availTone(pct: number | null): string {
  if (pct == null) return "var(--color-idle)";
  if (pct >= 99) return "var(--color-pass)";
  if (pct >= 95) return "var(--color-warn)";
  return "var(--color-fail)";
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="sw-mono text-lg font-semibold" style={{ color: tone ?? "var(--color-ink)" }}>
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">{label}</div>
    </div>
  );
}

export default function ReportsPage() {
  const [kind, setKind] = useState<ReportKind>("availability");
  const [window, setWindow] = useState<ReportWindow>("30d");
  const [groupBy, setGroupBy] = useState("team");

  const { data: avail, isLoading: availLoading } = useAvailabilityReport(window, groupBy);
  const { data: perf, isLoading: perfLoading } = usePerformanceReport(window, groupBy);

  const report = kind === "availability" ? avail : perf;
  const loading = kind === "availability" ? availLoading : perfLoading;

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <div>
          <p className="sw-eyebrow">Reporting</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Reports</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            ariaLabel="report"
            value={kind}
            onChange={setKind}
            options={[
              { value: "availability", label: "Availability" },
              { value: "performance", label: "Performance" },
            ]}
          />
          <Segmented
            ariaLabel="window"
            value={window}
            onChange={setWindow}
            options={WINDOWS.map((w) => ({ value: w, label: w }))}
          />
          <label className="flex items-center gap-2 text-[11px] text-[var(--color-ink-faint)]">
            group by
            <Segmented
              ariaLabel="group by"
              value={groupBy}
              onChange={setGroupBy}
              options={GROUP_BYS.map((g) => ({ value: g, label: g }))}
            />
          </label>
        </div>
      </header>

      {report === undefined ? (
        loading ? (
          <div className="py-16"><Spinner label="Building report…" /></div>
        ) : null
      ) : report === null ? (
        <div
          className="rounded-lg px-4 py-3 text-sm"
          style={{
            background: "color-mix(in srgb, var(--color-warn) 12%, transparent)",
            border: "1px solid color-mix(in srgb, var(--color-warn) 40%, transparent)",
            color: "var(--color-warn)",
          }}
          data-testid="reports-pending"
        >
          <strong>Reports aren&apos;t available yet.</strong> The reporting service isn&apos;t deployed —
          this view will populate once it serves data.
        </div>
      ) : report.groups.length === 0 ? (
        <EmptyState title="No data for this window." hint="Try a wider window, or a different grouping." />
      ) : kind === "availability" ? (
        <AvailabilityView report={report as AvailabilityReport} />
      ) : (
        <PerformanceView report={report as PerformanceReport} />
      )}
    </div>
  );
}

function AvailabilityView({ report }: { report: AvailabilityReport }) {
  return (
    <div className="space-y-4" data-testid="availability-report">
      {report.groups.map((g) => (
        <AvailabilityGroupCard key={g.group} groupBy={report.group_by} g={g} />
      ))}
    </div>
  );
}

function AvailabilityGroupCard({ groupBy, g }: { groupBy: string; g: AvailabilityGroup }) {
  const vals = g.series.map((p) => p.value).filter((v): v is number => v != null);
  const lo = vals.length ? Math.min(...vals) : 100;
  const domainMin = Math.max(0, Math.min(99, Math.floor(lo) - 1));
  return (
    <div className="sw-panel p-4" data-testid={`group-${g.group}`}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">{groupLabel(groupBy, g.group)}</h2>
        <span className="sw-mono text-[11px] text-[var(--color-ink-faint)]">
          {g.check_count} check{g.check_count === 1 ? "" : "s"}
        </span>
      </div>
      <div className="mb-4 flex flex-wrap gap-x-8 gap-y-3">
        <Stat label="availability" value={formatPct(g.availability_pct)} tone={availTone(g.availability_pct)} />
        <Stat label="downtime" value={fmtMinutes(g.downtime_minutes)} />
        <Stat label="incidents" value={String(g.incident_count)} />
      </div>
      <TrendChart
        series={g.series}
        unit="availability"
        color="#45e3c2"
        fmt={(v) => formatPct(v, 1)}
        domain={[domainMin, 100]}
      />
      <CheckBreakdown
        count={g.checks.length}
        headers={["Check", "Avail", "Downtime", "Incidents"]}
        rows={g.checks.map((c) => [
          c.name,
          formatPct(c.availability_pct),
          fmtMinutes(c.downtime_minutes),
          String(c.incident_count),
        ])}
      />
    </div>
  );
}

function PerformanceView({ report }: { report: PerformanceReport }) {
  return (
    <div className="space-y-4" data-testid="performance-report">
      {report.groups.map((g) => (
        <PerformanceGroupCard key={g.group} groupBy={report.group_by} g={g} />
      ))}
    </div>
  );
}

function PerformanceGroupCard({ groupBy, g }: { groupBy: string; g: PerformanceGroup }) {
  return (
    <div className="sw-panel p-4" data-testid={`group-${g.group}`}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">{groupLabel(groupBy, g.group)}</h2>
        <span className="sw-mono text-[11px] text-[var(--color-ink-faint)]">
          {g.check_count} check{g.check_count === 1 ? "" : "s"}
        </span>
      </div>
      <div className="mb-4 flex flex-wrap gap-x-8 gap-y-3">
        <Stat label="p95" value={formatDuration(g.p95_ms)} />
        <Stat label="avg" value={formatDuration(g.avg_ms)} />
        <Stat label="p50" value={formatDuration(g.p50_ms)} />
        <Stat label="p99" value={formatDuration(g.p99_ms)} />
      </div>
      <TrendChart series={g.series} unit="p95 latency" color="#5aa6f2" fmt={(v) => formatDuration(v)} />

      {/* ★ Web vitals — browser checks ONLY. Rendered only when the group HAS browser
          data; never an empty card for http/ssl. INP is intentionally absent. */}
      {g.web_vitals ? (
        <WebVitalsPanel
          vitals={g.web_vitals}
          browserCount={g.browser_check_count}
          mixed={g.browser_check_count < g.check_count}
        />
      ) : (
        <p className="mt-3 text-[11px] text-[var(--color-ink-faint)]" data-testid="no-vitals-note">
          Web vitals apply to browser checks only — none in this group.
        </p>
      )}

      <CheckBreakdown
        count={g.checks.length}
        headers={["Check", "Kind", "p50", "p95", "p99"]}
        rows={g.checks.map((c) => [
          c.name,
          c.kind,
          formatDuration(c.p50_ms),
          formatDuration(c.p95_ms),
          formatDuration(c.p99_ms),
        ])}
      />
    </div>
  );
}

function WebVitalsPanel({
  vitals,
  browserCount,
  mixed,
}: {
  vitals: WebVitals;
  browserCount: number;
  mixed: boolean;
}) {
  // LCP/FCP/TTFB are ms; CLS is unitless. ★ No INP.
  const cells: { label: string; value: string }[] = [
    { label: "LCP", value: formatDuration(vitals.lcp_ms) },
    { label: "FCP", value: formatDuration(vitals.fcp_ms) },
    { label: "TTFB", value: formatDuration(vitals.ttfb_ms) },
    { label: "CLS", value: vitals.cls == null ? "—" : vitals.cls.toFixed(2) },
  ];
  return (
    <div className="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3" data-testid="web-vitals">
      <div className="mb-2 flex items-center gap-2">
        <span className="sw-eyebrow">Web vitals</span>
        <span className="sw-mono text-[10px] text-[var(--color-ink-faint)]">
          {mixed
            ? `browser checks only (${browserCount} of this group)`
            : `${browserCount} browser check${browserCount === 1 ? "" : "s"}`}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {cells.map((c) => (
          <div key={c.label} className="rounded-md border border-[var(--color-border)] px-2.5 py-1.5">
            <div className="sw-mono text-sm font-medium text-[var(--color-ink)]">{c.value}</div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">{c.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CheckBreakdown({ count, headers, rows }: { count: number; headers: string[]; rows: string[][] }) {
  if (count === 0) return null;
  return (
    <details className="mt-3 group">
      <summary className="cursor-pointer list-none text-[11px] text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]">
        ▸ {count} check{count === 1 ? "" : "s"} — per-check breakdown
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-collapse text-left text-[12px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
              {headers.map((h, i) => (
                <th key={h} className={`px-2 py-1 ${i === 0 ? "" : "text-right"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} className="border-t border-[var(--color-border)]">
                {r.map((cell, ci) => (
                  <td
                    key={ci}
                    className={`px-2 py-1.5 ${ci === 0 ? "text-[var(--color-ink)]" : "sw-mono text-right text-[var(--color-ink-dim)]"}`}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
