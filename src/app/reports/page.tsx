"use client";

import { useMemo, useState } from "react";

import { useAvailabilityReport, usePerformanceReport, useChecks, useSla, useTags } from "@/lib/client";
import { EmptyState, Spinner } from "@/components/states";
import { TagFilter, useTagFilter, matchesTags } from "@/components/tag-filter";
import { NarrativeCard } from "@/components/narrative-card";
import { IncidentBreakdownCard } from "@/components/incident-breakdown-card";
import { MonitorReportCard, type ReportRow } from "@/components/monitor-report-card";
import { ReportWebVitals, ReportSeriesArea } from "@/components/charts";
import { formatDuration } from "@/lib/format";
import type { ReportWindow } from "@/lib/types";

const WINDOWS: ReportWindow[] = ["7d", "30d", "90d"];

type SortCol = "availability_pct" | "p95_ms" | "incidents" | "cert_days" | "name";
const SORTS: { col: SortCol; label: string }[] = [
  { col: "availability_pct", label: "Availability" },
  { col: "p95_ms", label: "p95" },
  { col: "incidents", label: "Incidents" },
  { col: "cert_days", label: "Cert expiry" },
  { col: "name", label: "Name" },
];

function incidentsOf(r: ReportRow): number {
  return r.incident_window_count ?? r.open_incident_count;
}

function compare(a: ReportRow, b: ReportRow, col: SortCol, dir: "asc" | "desc"): number {
  const s = dir === "asc" ? 1 : -1;
  if (col === "name") return a.name.localeCompare(b.name) * s;
  // cert_days: non-cert checks are null → nulls-last (below), so "Cert expiry · asc" = expiring soonest first
  // with non-cert monitors sorted out of the way.
  const av = col === "incidents" ? incidentsOf(a) : col === "cert_days" ? a.last_cert_days_remaining : a[col];
  const bv = col === "incidents" ? incidentsOf(b) : col === "cert_days" ? b.last_cert_days_remaining : b[col];
  if (av == null && bv == null) return 0;
  if (av == null) return 1; // nulls last, regardless of dir
  if (bv == null) return -1;
  return (av - bv) * s;
}

export default function ReportsPage() {
  // Default to 7d: the AI narratives (fleet + per-monitor, Layer 3) are generated for the 7d window
  // (the runner currently hardcodes 7d), so 7d shows the richest report. Availability/latency/incidents
  // come from the live checks + SLA endpoints and work for any window.
  const [window, setWindow] = useState<ReportWindow>("7d");
  const { selected, toggle, clear } = useTagFilter();
  const [sort, setSort] = useState<{ col: SortCol; dir: "asc" | "desc" }>({ col: "availability_pct", dir: "asc" });
  const [expanded, setExpanded] = useState<number | null>(null);

  // ★ The monitor SET comes from the live checks list — the proven, always-populated source (the same one
  // the status/monitors pages use). The old reports list bound only to /reports/availability, which returns
  // empty even when monitors exist → the misleading "No monitors to report on". SLA supplies windowed
  // availability (computed from up/down counts). The rollup reports, when present, ENRICH each row with
  // windowed latency percentiles + downtime/incident counts; when empty they simply don't override.
  const { data: checks, isLoading } = useChecks();
  const { data: sla } = useSla(window);
  const { data: avail } = useAvailabilityReport(window, "none");
  const { data: perf } = usePerformanceReport(window, "none");
  const { data: inUseTags } = useTags();

  const rows = useMemo<ReportRow[]>(() => {
    if (!checks) return [];
    const slaByCheck = new Map((sla?.items ?? []).map((r) => [r.check_id, r]));
    const availByCheck = new Map((avail?.groups[0]?.checks ?? []).map((c) => [c.check_id, c]));
    const perfByCheck = new Map((perf?.groups[0]?.checks ?? []).map((c) => [c.check_id, c]));

    return checks.map((c) => {
      const s = slaByCheck.get(c.id);
      const a = availByCheck.get(c.id);
      const p = perfByCheck.get(c.id);
      const up = s?.up_runs ?? 0;
      const down = s?.down_runs ?? 0;
      // Prefer the rollup report's downtime-accurate %; else compute from SLA up/down (matches the
      // narrative's figure). availability_pct on /sla is often null even with runs, so don't rely on it.
      const computedPct = up + down > 0 ? Math.round((10000 * up) / (up + down)) / 100 : null;
      return {
        check_id: c.id,
        last_cert_days_remaining: c.last_cert_days_remaining,
        name: c.name,
        kind: c.kind,
        current_status: c.current_status,
        tags: c.tags,
        availability_pct: a?.availability_pct ?? computedPct,
        up_runs: up,
        down_runs: down,
        completed_runs: s?.completed_runs ?? 0,
        // Windowed latency from the perf rollup when served; else the live 24h metrics (labelled "24h").
        p50_ms: p?.p50_ms ?? c.p50_ms,
        p95_ms: p?.p95_ms ?? c.p95_ms,
        p99_ms: p?.p99_ms ?? null,
        latency_windowed: p != null,
        open_incident_count: c.open_incident_count,
        max_open_severity: c.max_open_severity,
        incident_window_count: a?.incident_count ?? null,
        spark: c.spark,
      };
    });
  }, [checks, sla, avail, perf]);

  const filtered = rows.filter((r) => matchesTags(r.tags, selected));
  const sorted = [...filtered].sort((a, b) => compare(a, b, sort.col, sort.dir));

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="sw-eyebrow">Reporting</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Reports</h1>
        </div>
        <div className="inline-flex rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] p-0.5" role="group" aria-label="window">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              aria-pressed={w === window}
              onClick={() => setWindow(w)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                w === window ? "bg-[var(--color-panel-2)] text-[var(--color-ink)]" : "text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
              }`}
            >
              {w}
            </button>
          ))}
        </div>
      </header>

      {/* AI narrative summary (Layer 3) — hides entirely until the endpoint serves one (currently 7d). */}
      <NarrativeCard scope="fleet" window={window} />

      {/* P6 — alert-quality breakdown: how many reds were real vs monitor-bug vs transient (leads with precision). */}
      <IncidentBreakdownCard window={window} />

      {/* ★ Fleet Core Web Vitals (p75) — the /reports/performance group web_vitals we already fetch; hides
          when there are no browser monitors / no vitals (honest absence, not a zero). */}
      <ReportWebVitals
        vitals={perf?.groups[0]?.web_vitals ?? null}
        browserCheckCount={perf?.groups[0]?.browser_check_count ?? 0}
      />

      {/* ★ Fleet trend over the window — the report `series` we already fetch (availability % from the
          availability report, AVG latency from the performance report) but previously dropped. These are
          GROUP/fleet-level (the report has no per-check series); the per-monitor drill-down keeps its raw-run
          latency chart (which shows p95 spikiness the fleet avg would smooth away). */}
      {((avail?.groups[0]?.series?.length ?? 0) > 0 || (perf?.groups[0]?.series?.length ?? 0) > 0) && (
        <div className="grid gap-4 sm:grid-cols-2" data-testid="report-fleet-trend">
          <ReportSeriesArea
            title="Fleet availability"
            unit="% per day"
            points={avail?.groups[0]?.series ?? []}
            fmt={(v) => (v == null ? "—" : `${v.toFixed(1)}%`)}
          />
          <ReportSeriesArea
            title="Fleet avg latency"
            unit="avg ms per day"
            points={perf?.groups[0]?.series ?? []}
            fmt={formatDuration}
          />
        </div>
      )}

      {/* Tags FILTER the list (multi-tag AND); only real in-use tags are offered. */}
      {(inUseTags?.length ?? 0) > 0 && (
        <TagFilter
          available={inUseTags ?? []}
          selected={selected}
          onToggle={toggle}
          onClear={clear}
          resultLabel={`${filtered.length} of ${rows.length} monitors`}
        />
      )}

      {isLoading && !checks ? (
        <div className="py-16"><Spinner label="Building report…" /></div>
      ) : sorted.length === 0 ? (
        <EmptyState
          title={
            selected.length > 0
              ? "No monitors match this filter."
              : (checks?.length ?? 0) === 0
                ? "No monitors yet."
                : "No monitors to report on."
          }
          hint={selected.length > 0 ? "No monitor carries all the selected tags." : "Create a monitor to start collecting report data."}
          action={selected.length > 0 ? <button onClick={clear} className="sw-btn">Clear filter</button> : undefined}
        />
      ) : (
        <div className="space-y-4" data-testid="monitor-list">
          {/* sort control (cards have no header row to click) */}
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-ink-faint)]">
            <span className="uppercase tracking-wider">Sort</span>
            {SORTS.map((s) => {
              const active = sort.col === s.col;
              return (
                <button
                  key={s.col}
                  type="button"
                  data-testid={`sort-${s.col}`}
                  onClick={() =>
                    setSort((cur) => (cur.col === s.col ? { col: s.col, dir: cur.dir === "asc" ? "desc" : "asc" } : { col: s.col, dir: s.col === "name" || s.col === "cert_days" ? "asc" : "desc" }))
                  }
                  className={`rounded-md border px-2 py-0.5 transition ${
                    active
                      ? "border-[var(--color-border-strong)] bg-[var(--color-panel-2)] text-[var(--color-ink)]"
                      : "border-transparent hover:text-[var(--color-ink)]"
                  }`}
                >
                  {s.label}
                  {active && <span aria-hidden> {sort.dir === "asc" ? "▲" : "▼"}</span>}
                </button>
              );
            })}
          </div>

          {sorted.map((r) => (
            <MonitorReportCard
              key={r.check_id}
              row={r}
              window={window}
              open={expanded === r.check_id}
              onToggle={() => setExpanded((cur) => (cur === r.check_id ? null : r.check_id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
