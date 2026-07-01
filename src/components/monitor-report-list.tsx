"use client";

import { useState } from "react";

import { EmptyState, Spinner } from "@/components/states";
import { MonitorReportCard, type ReportRow } from "@/components/monitor-report-card";
import { ReportWebVitals, ReportSeriesArea } from "@/components/charts";
import { formatDuration } from "@/lib/format";
import type { AvailabilityReport, CheckWithStatus, PerformanceReport, ReportWindow, Tag } from "@/lib/types";

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

/**
 * The per-monitor report list — sortable cards, or per-tag-value grouped sections when group-by is active.
 * Extracted verbatim from the old inline /reports block (same sort/grouping/empty-state behavior); it owns its
 * own sort + expanded state, and derives the grouped view from the page-level `groupBy` + report data.
 */
export function MonitorReportList({
  filtered,
  checks,
  isLoading,
  window,
  selected,
  clear,
  avail,
  perf,
  groupBy,
}: {
  filtered: ReportRow[];
  checks: CheckWithStatus[] | undefined;
  isLoading: boolean;
  window: ReportWindow;
  selected: Tag[];
  clear: () => void;
  avail: AvailabilityReport | null | undefined;
  perf: PerformanceReport | null | undefined;
  groupBy: string;
}) {
  const [sort, setSort] = useState<{ col: SortCol; dir: "asc" | "desc" }>({ col: "availability_pct", dir: "asc" });
  const [expanded, setExpanded] = useState<number | null>(null);

  const sorted = [...filtered].sort((a, b) => compare(a, b, sort.col, sort.dir));

  // Group-by: bucket the sorted rows by their value of that key and pair each value with the server-computed
  // group aggregate (web_vitals/series) for that value.
  const grouped = groupBy !== "none";
  const availByGroup = new Map((avail?.groups ?? []).map((g) => [g.group, g]));
  const perfByGroup = new Map((perf?.groups ?? []).map((g) => [g.group, g]));
  const rowsByValue = new Map<string, ReportRow[]>();
  const untagged: ReportRow[] = [];
  if (grouped)
    for (const r of sorted) {
      const v = r.tags.find((t) => t.key === groupBy)?.value ?? null;
      if (v == null) untagged.push(r);
      else (rowsByValue.get(v) ?? rowsByValue.set(v, []).get(v)!).push(r);
    }
  const groupValues = [...rowsByValue.keys()].sort();

  if (isLoading && !checks) {
    return (
      <div className="py-16">
        <Spinner label="Building report…" />
      </div>
    );
  }
  if (sorted.length === 0) {
    return (
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
    );
  }

  return (
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

      {!grouped ? (
        sorted.map((r) => (
          <MonitorReportCard
            key={r.check_id}
            row={r}
            window={window}
            open={expanded === r.check_id}
            onToggle={() => setExpanded((cur) => (cur === r.check_id ? null : r.check_id))}
          />
        ))
      ) : (
        <>
          {/* One section per tag VALUE: the group's own CWV + trend (server-computed) + its monitor cards. */}
          {groupValues.map((value) => {
            const pg = perfByGroup.get(value);
            const ag = availByGroup.get(value);
            const bucket = rowsByValue.get(value) ?? [];
            return (
              <section
                key={value}
                data-testid={`group-section-${value}`}
                className="space-y-3 rounded-lg border border-[var(--color-border)] p-3"
              >
                <h2 className="flex items-baseline gap-2 text-sm font-semibold text-[var(--color-ink)]">
                  <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">{groupBy}</span>
                  {value}
                  <span className="text-[11px] font-normal text-[var(--color-ink-faint)]">
                    · {bucket.length} monitor{bucket.length === 1 ? "" : "s"}
                  </span>
                </h2>
                <ReportGroupTiles ag={ag} pg={pg} />
                {bucket.map((r) => (
                  <MonitorReportCard
                    key={r.check_id}
                    row={r}
                    window={window}
                    open={expanded === r.check_id}
                    onToggle={() => setExpanded((cur) => (cur === r.check_id ? null : r.check_id))}
                  />
                ))}
              </section>
            );
          })}
          {/* Honest accounting: monitors lacking the group-by tag aren't dropped — shown in their own section
              (the server's INNER JOIN excludes them from the aggregates, so no group tiles here). */}
          {untagged.length > 0 && (
            <section
              data-testid="group-section-untagged"
              className="space-y-3 rounded-lg border border-dashed border-[var(--color-border)] p-3"
            >
              <h2 className="flex items-baseline gap-2 text-sm font-semibold text-[var(--color-ink-dim)]">
                No <span className="sw-mono">{groupBy}</span> tag
                <span className="text-[11px] font-normal text-[var(--color-ink-faint)]">
                  · {untagged.length} monitor{untagged.length === 1 ? "" : "s"}
                </span>
              </h2>
              {untagged.map((r) => (
                <MonitorReportCard
                  key={r.check_id}
                  row={r}
                  window={window}
                  open={expanded === r.check_id}
                  onToggle={() => setExpanded((cur) => (cur === r.check_id ? null : r.check_id))}
                />
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}

// The per-group availability/latency trend pair (rendered only when a group has series). Kept as a tiny local
// so the grouped-section markup stays readable; imports the shared chart from charts.tsx.
function ReportGroupTiles({
  ag,
  pg,
}: {
  ag: AvailabilityReport["groups"][number] | undefined;
  pg: PerformanceReport["groups"][number] | undefined;
}) {
  const hasSeries = ((ag?.series?.length ?? 0) > 0) || ((pg?.series?.length ?? 0) > 0);
  return (
    <>
      <ReportWebVitals vitals={pg?.web_vitals ?? null} browserCheckCount={pg?.browser_check_count ?? 0} />
      {hasSeries && (
        <div className="grid gap-4 sm:grid-cols-2">
          <ReportSeriesArea title="Availability" unit="% per day" points={ag?.series ?? []} fmt={(v) => (v == null ? "—" : `${v.toFixed(1)}%`)} />
          <ReportSeriesArea title="Avg latency" unit="avg ms per day" points={pg?.series ?? []} fmt={formatDuration} />
        </div>
      )}
    </>
  );
}
