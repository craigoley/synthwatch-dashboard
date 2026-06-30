"use client";

import { useEffect, useMemo, useState } from "react";

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

/** URL-synced group-by tag KEY (?groupBy=team). "none" = no grouping (the no-querystring default). Mirrors the
 *  tag filter's history.replaceState approach (shareable/restorable, no Suspense needed). */
function useGroupBy() {
  const [groupBy, setGroupByState] = useState<string>("none");
  useEffect(() => {
    const g = new URLSearchParams(window.location.search).get("groupBy");
    if (g) setGroupByState(g);
  }, []);
  const setGroupBy = (g: string) => {
    setGroupByState(g);
    const url = new URL(window.location.href);
    if (g && g !== "none") url.searchParams.set("groupBy", g);
    else url.searchParams.delete("groupBy");
    window.history.replaceState(null, "", url.toString());
  };
  return { groupBy, setGroupBy };
}

export default function ReportsPage() {
  // Default to 7d: the AI narratives (fleet + per-monitor, Layer 3) are generated for the 7d window
  // (the runner currently hardcodes 7d), so 7d shows the richest report. Availability/latency/incidents
  // come from the live checks + SLA endpoints and work for any window.
  const [window, setWindow] = useState<ReportWindow>("7d");
  const { selected, toggle, clear } = useTagFilter();
  const { groupBy, setGroupBy } = useGroupBy();
  const [sort, setSort] = useState<{ col: SortCol; dir: "asc" | "desc" }>({ col: "availability_pct", dir: "asc" });
  const [expanded, setExpanded] = useState<number | null>(null);

  // ★ The monitor SET comes from the live checks list — the proven, always-populated source (the same one
  // the status/monitors pages use). The old reports list bound only to /reports/availability, which returns
  // empty even when monitors exist → the misleading "No monitors to report on". SLA supplies windowed
  // availability (computed from up/down counts). The rollup reports, when present, ENRICH each row with
  // windowed latency percentiles + downtime/incident counts; when empty they simply don't override.
  const { data: checks, isLoading } = useChecks();
  const { data: sla } = useSla(window);
  // ★ The aggregate tiles (CWV / trend / verdict-breakdown) take the SAME tag filter as the monitor list,
  // server-scoped via ?tag= — so a filtered view shows the SUBSET's numbers, never the fleet's. Empty → fleet.
  // ★ groupBy is forwarded to the report endpoints, which GROUP BY the tag key server-side (one group per tag
  // VALUE). "none" → a single fleet/filtered aggregate (today). Composes with the tag filter (?tag= scopes the
  // set, groupBy buckets it).
  const { data: avail } = useAvailabilityReport(window, groupBy, selected);
  const { data: perf } = usePerformanceReport(window, groupBy, selected);
  const { data: inUseTags } = useTags();

  const rows = useMemo<ReportRow[]>(() => {
    if (!checks) return [];
    const slaByCheck = new Map((sla?.items ?? []).map((r) => [r.check_id, r]));
    // Flatten per-check rows across ALL groups (each check is in exactly one group) so enrichment works for
    // both ungrouped (one group) and grouped (N groups) reports.
    const availByCheck = new Map((avail?.groups ?? []).flatMap((g) => g.checks).map((c) => [c.check_id, c]));
    const perfByCheck = new Map((perf?.groups ?? []).flatMap((g) => g.checks).map((c) => [c.check_id, c]));

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

  // Group-by: distinct tag KEYS to offer; when grouped, bucket the sorted rows by their value of that key and
  // pair each value with the server-computed group aggregate (web_vitals/series) for that value.
  const groupKeys = useMemo(() => [...new Set((inUseTags ?? []).map((t) => t.key))].sort(), [inUseTags]);
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

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="sw-eyebrow">Reporting</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Reports</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* ★ Group-by a tag KEY (per-team / per-application reporting) — one section per tag value. */}
          {groupKeys.length > 0 && (
            <label className="flex items-center gap-1.5 text-xs text-[var(--color-ink-dim)]">
              <span className="uppercase tracking-wider text-[var(--color-ink-faint)]">Group by</span>
              <select
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value)}
                aria-label="Group reports by tag key"
                data-testid="group-by-select"
                className="sw-input py-1 text-xs"
              >
                <option value="none">None</option>
                {groupKeys.map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
            </label>
          )}
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
        </div>
      </header>

      {/* AI narrative summary (Layer 3) — fleet-wide, runner-generated (no per-tag narrative). Hide it under an
          active tag filter so a FLEET narrative is never read as the tagged subset's story. */}
      {selected.length === 0 && <NarrativeCard scope="fleet" window={window} />}

      {/* ★ Scope obviousness: when a tag filter is active, every aggregate BELOW is the tagged subset — say so
          loudly so a scoped CWV/precision number is never mistaken for the fleet's. */}
      {selected.length > 0 && (
        <div
          className="sw-panel flex flex-wrap items-center gap-x-2 gap-y-1 p-3 text-[12px]"
          style={{ borderColor: "color-mix(in srgb, var(--color-brand) 40%, var(--color-border))" }}
          data-testid="report-scope-banner"
        >
          <span className="sw-eyebrow" style={{ color: "var(--color-brand)" }}>Scoped</span>
          <span className="text-[var(--color-ink-dim)]">All reports below cover only</span>
          {selected.map((t) => (
            <span key={`${t.key}:${t.value}`} className="sw-mono rounded bg-[var(--color-bg)] px-1.5 py-0.5 text-[var(--color-ink)]">
              {t.key}:{t.value}
            </span>
          ))}
          <span className="text-[var(--color-ink-faint)]">· {filtered.length} of {rows.length} monitors</span>
        </div>
      )}

      {/* P6 — alert-quality breakdown: how many reds were real vs monitor-bug vs transient (leads with precision). */}
      <IncidentBreakdownCard window={window} tags={selected} />

      {/* ★ Fleet Core Web Vitals (p75) + fleet trend — ONLY when ungrouped. When grouped, groups[0] is the first
          tag VALUE (not the fleet), so a fleet-labelled tile would mislead; the per-group sections below render
          each group's own CWV + trend instead. Both hide on honest-empty (no browser monitors / no series). */}
      {!grouped && (
        <>
          <ReportWebVitals
            vitals={perf?.groups[0]?.web_vitals ?? null}
            browserCheckCount={perf?.groups[0]?.browser_check_count ?? 0}
          />
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
        </>
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
                    <ReportWebVitals vitals={pg?.web_vitals ?? null} browserCheckCount={pg?.browser_check_count ?? 0} />
                    {(((ag?.series?.length ?? 0) > 0) || ((pg?.series?.length ?? 0) > 0)) && (
                      <div className="grid gap-4 sm:grid-cols-2">
                        <ReportSeriesArea title="Availability" unit="% per day" points={ag?.series ?? []} fmt={(v) => (v == null ? "—" : `${v.toFixed(1)}%`)} />
                        <ReportSeriesArea title="Avg latency" unit="avg ms per day" points={pg?.series ?? []} fmt={formatDuration} />
                      </div>
                    )}
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
      )}
    </div>
  );
}
