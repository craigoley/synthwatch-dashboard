"use client";

import { useEffect, useMemo, useState } from "react";

import { useAvailabilityReport, usePerformanceReport, useChecks, useSla, useTags } from "@/lib/client";
import { TagFilter, useTagFilter, matchesTags } from "@/components/tag-filter";
import { NarrativeCard } from "@/components/narrative-card";
import { IncidentBreakdownCard } from "@/components/incident-breakdown-card";
import { type ReportRow } from "@/components/monitor-report-card";
import { MonitorReportList } from "@/components/monitor-report-list";
import { ReportWebVitals, ReportSeriesArea } from "@/components/charts";
import { FleetSloReport } from "@/components/fleet-slo";
import { FleetMttrReport } from "@/components/fleet-mttr";
import { TrustScorecard } from "@/components/trust";
import { TabBar, useTab, type TabDef } from "@/components/tabs";
import { formatDuration } from "@/lib/format";
import type { ReportWindow } from "@/lib/types";

const WINDOWS: ReportWindow[] = ["7d", "30d", "90d"];

// Sub-tabs organize the ~9 stacked report sections. Performance is the default (no ?tab= param). The
// self-fetching Reliability cards mount ONLY when that tab is active (lazy) — avail/perf stay page-level (below)
// and feed both Performance and Monitors, so switching between them never re-fetches.
const TABS: TabDef[] = [
  { id: "performance", label: "Performance" },
  { id: "reliability", label: "Reliability" },
  { id: "monitors", label: "Monitors" },
  { id: "trust", label: "Trust" },
];
const TAB_IDS = TABS.map((t) => t.id);

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
  const { tab, setTab } = useTab(TAB_IDS, "performance");

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

  // Group-by: distinct tag KEYS to offer. `grouped` also gates the fleet CWV/trend (groups[0] is the first tag
  // VALUE, not the fleet, when grouped) — the per-group tiles render inside <MonitorReportList> instead.
  const groupKeys = useMemo(() => [...new Set((inUseTags ?? []).map((t) => t.key))].sort(), [inUseTags]);
  const grouped = groupBy !== "none";

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="sw-eyebrow">Reporting</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Reports</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* Window is a GLOBAL control — it scopes every tab's reports (stays above the tabs). Group-by moved
              into the Monitors tab (it only reshapes the monitor list + suppresses fleet CWV/trend). */}
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

      {/* Tags FILTER the monitor list + scope every aggregate (multi-tag AND) — a GLOBAL control, above the
          tabs. Only real in-use tags are offered. */}
      {(inUseTags?.length ?? 0) > 0 && (
        <TagFilter
          available={inUseTags ?? []}
          selected={selected}
          onToggle={toggle}
          onClear={clear}
          resultLabel={`${filtered.length} of ${rows.length} monitors`}
        />
      )}

      {/* Sub-tabs: only the ACTIVE tab's cards mount → the self-fetching Reliability cards (breakdown/SLO/MTTR)
          fire their hooks only when Reliability is opened, not on page load. */}
      <TabBar tabs={TABS} active={tab} onSelect={setTab} label="Report sections" />

      {tab === "performance" && (
        /* ★ Fleet Core Web Vitals (p75) + fleet trend — ONLY when ungrouped. When grouped, groups[0] is the
           first tag VALUE (not the fleet), so a fleet-labelled tile would mislead — the per-group tiles live in
           the Monitors tab instead. Both hide on honest-empty (no browser monitors / no series). */
        !grouped ? (
          <div className="space-y-5" data-testid="reports-panel-performance">
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
          </div>
        ) : (
          <p className="sw-panel p-4 text-sm text-[var(--color-ink-dim)]" data-testid="reports-panel-performance">
            Fleet Core Web Vitals + trend are hidden while grouped by <span className="sw-mono">{groupBy}</span> —
            see per-group tiles in the Monitors tab. Set Group by → None to show the fleet aggregate.
          </p>
        )
      )}

      {tab === "reliability" && (
        <div className="space-y-5" data-testid="reports-panel-reliability">
          {/* P6 — alert-quality breakdown: how many reds were real vs monitor-bug vs transient. */}
          <IncidentBreakdownCard window={window} tags={selected} />
          {/* ★ Fleet error budget (P5 v1) — per-check budget rows + a fleet rollup, tag-scoped. */}
          <FleetSloReport window={window} tags={selected} />
          {/* ★ Fleet MTTR / incident analytics (§A5) — mean+median time-to-resolve, classification, trend. */}
          <FleetMttrReport window={window} tags={selected} />
        </div>
      )}

      {tab === "monitors" && (
        <div className="space-y-4" data-testid="reports-panel-monitors">
          {/* ★ Group-by a tag KEY (per-team / per-application reporting) — a Monitors-tab control: it buckets the
              list into one section per tag value and suppresses the fleet CWV/trend on the Performance tab. */}
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
          <MonitorReportList
            filtered={filtered}
            checks={checks}
            isLoading={isLoading}
            window={window}
            selected={selected}
            clear={clear}
            avail={avail}
            perf={perf}
            groupBy={groupBy}
          />
        </div>
      )}

      {/* §D1 monitor-trust scorecard — relocated from a top-level /trust route to a Reports sub-tab (v2). Uses
          the page's shared window. Fleet-wide (no tag scoping — the trust API is not tag-filtered). */}
      {tab === "trust" && (
        <div data-testid="reports-panel-trust">
          <TrustScorecard window={window} />
        </div>
      )}
    </div>
  );
}
