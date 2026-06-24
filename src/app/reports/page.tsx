"use client";

import { useMemo, useState } from "react";

import { useAvailabilityReport, usePerformanceReport, useChecks, useTags } from "@/lib/client";
import { EmptyState, Spinner } from "@/components/states";
import { TagFilter, useTagFilter, matchesTags } from "@/components/tag-filter";
import { TagChips } from "@/components/tag-chips";
import { StatusDot } from "@/components/status-badge";
import { MonitorReportDetail } from "@/components/monitor-report-detail";
import { formatDuration, formatPct } from "@/lib/format";
import type { CheckKind, ReportWindow, RunStatus, Tag } from "@/lib/types";

const WINDOWS: ReportWindow[] = ["7d", "30d", "90d"];

interface Row {
  check_id: number;
  name: string;
  kind: CheckKind;
  current_status: RunStatus | null;
  tags: Tag[];
  availability_pct: number | null;
  downtime_minutes: number;
  incident_count: number;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
}

type SortCol = "name" | "availability_pct" | "p50_ms" | "p95_ms" | "p99_ms" | "incident_count";

const COLUMNS: { col: SortCol; label: string; numeric: boolean }[] = [
  { col: "name", label: "Monitor", numeric: false },
  { col: "availability_pct", label: "Availability", numeric: true },
  { col: "p50_ms", label: "p50", numeric: true },
  { col: "p95_ms", label: "p95", numeric: true },
  { col: "p99_ms", label: "p99", numeric: true },
  { col: "incident_count", label: "Incidents", numeric: true },
];

function compare(a: Row, b: Row, col: SortCol, dir: "asc" | "desc"): number {
  const s = dir === "asc" ? 1 : -1;
  if (col === "name") return a.name.localeCompare(b.name) * s;
  const av = a[col] as number | null;
  const bv = b[col] as number | null;
  if (av == null && bv == null) return 0;
  if (av == null) return 1; // nulls always sort last
  if (bv == null) return -1;
  return (av - bv) * s;
}

function availTone(pct: number | null): string {
  if (pct == null) return "var(--color-ink-dim)";
  if (pct >= 99) return "var(--color-pass)";
  if (pct >= 95) return "var(--color-warn)";
  return "var(--color-fail)";
}

export default function ReportsPage() {
  const [window, setWindow] = useState<ReportWindow>("30d");
  const { selected, toggle, clear } = useTagFilter();
  const [sort, setSort] = useState<{ col: SortCol; dir: "asc" | "desc" }>({ col: "availability_pct", dir: "asc" });
  const [expanded, setExpanded] = useState<number | null>(null);

  // Detail-first: ALWAYS ungrouped (per-check breakdown). Tags filter; they don't group.
  const { data: avail, isLoading } = useAvailabilityReport(window, "none");
  const { data: perf } = usePerformanceReport(window, "none");
  const { data: checks } = useChecks();
  const { data: inUseTags } = useTags();

  // Live tag lens: tags come from the check data at render time, never baked into structure.
  const checkMeta = useMemo(
    () => new Map((checks ?? []).map((c) => [c.id, { tags: c.tags, status: c.current_status }])),
    [checks],
  );

  const rows = useMemo<Row[]>(() => {
    if (!avail) return [];
    const perfById = new Map((perf?.groups[0]?.checks ?? []).map((c) => [c.check_id, c]));
    return (avail.groups[0]?.checks ?? []).map((a) => {
      const p = perfById.get(a.check_id);
      const meta = checkMeta.get(a.check_id);
      return {
        check_id: a.check_id,
        name: a.name,
        kind: a.kind,
        current_status: meta?.status ?? null,
        tags: meta?.tags ?? [],
        availability_pct: a.availability_pct,
        downtime_minutes: a.downtime_minutes,
        incident_count: a.incident_count,
        p50_ms: p?.p50_ms ?? null,
        p95_ms: p?.p95_ms ?? null,
        p99_ms: p?.p99_ms ?? null,
      };
    });
  }, [avail, perf, checkMeta]);

  const filtered = rows.filter((r) => matchesTags(r.tags, selected));
  const sorted = [...filtered].sort((a, b) => compare(a, b, sort.col, sort.dir));

  const clickSort = (col: SortCol) =>
    setSort((s) => (s.col === col ? { col, dir: s.dir === "asc" ? "desc" : "asc" } : { col, dir: col === "name" ? "asc" : "asc" }));

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

      {avail === undefined ? (
        isLoading ? <div className="py-16"><Spinner label="Building report…" /></div> : null
      ) : avail === null ? (
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
      ) : sorted.length === 0 ? (
        <EmptyState
          title={selected.length > 0 ? "No monitors match this filter." : "No monitors to report on."}
          hint={selected.length > 0 ? "No monitor carries all the selected tags." : undefined}
          action={selected.length > 0 ? <button onClick={clear} className="sw-btn">Clear filter</button> : undefined}
        />
      ) : (
        <div className="sw-panel overflow-hidden" data-testid="monitor-list">
          {/* sortable header */}
          <div className="hidden grid-cols-[1fr_110px_90px_90px_90px_90px] gap-3 border-b border-[var(--color-border)] px-4 py-2.5 sm:grid">
            {COLUMNS.map((c) => (
              <button
                key={c.col}
                type="button"
                onClick={() => clickSort(c.col)}
                data-testid={`sort-${c.col}`}
                className={`flex items-center gap-1 text-[10px] uppercase tracking-wider transition hover:text-[var(--color-ink)] ${
                  sort.col === c.col ? "text-[var(--color-ink)]" : "text-[var(--color-ink-faint)]"
                } ${c.numeric ? "justify-end" : ""}`}
              >
                {c.label}
                {sort.col === c.col && <span aria-hidden>{sort.dir === "asc" ? "▲" : "▼"}</span>}
              </button>
            ))}
          </div>

          <div className="divide-y divide-[var(--color-border)]">
            {sorted.map((r) => {
              const open = expanded === r.check_id;
              return (
                <div key={r.check_id} data-testid={`row-${r.check_id}`}>
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? null : r.check_id)}
                    aria-expanded={open}
                    className="grid w-full grid-cols-1 items-center gap-2 px-4 py-3 text-left transition hover:bg-[var(--color-panel-2)] sm:grid-cols-[1fr_110px_90px_90px_90px_90px] sm:gap-3"
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span aria-hidden className="text-[10px] text-[var(--color-ink-faint)]">{open ? "▾" : "▸"}</span>
                      <StatusDot status={r.current_status} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-[var(--color-ink)]">{r.name}</span>
                        <TagChips tags={r.tags} className="mt-0.5" />
                      </span>
                    </span>
                    <span className="sw-mono text-sm sm:text-right" style={{ color: availTone(r.availability_pct) }}>
                      {formatPct(r.availability_pct)}
                    </span>
                    <span className="sw-mono text-[13px] text-[var(--color-ink-dim)] sm:text-right">{formatDuration(r.p50_ms)}</span>
                    <span className="sw-mono text-[13px] text-[var(--color-ink-dim)] sm:text-right">{formatDuration(r.p95_ms)}</span>
                    <span className="sw-mono text-[13px] text-[var(--color-ink-dim)] sm:text-right">{formatDuration(r.p99_ms)}</span>
                    <span className="sw-mono text-[13px] sm:text-right" style={{ color: r.incident_count ? "var(--color-fail)" : "var(--color-ink-dim)" }}>
                      {r.incident_count}
                    </span>
                  </button>
                  {open && <MonitorReportDetail checkId={r.check_id} kind={r.kind} />}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
