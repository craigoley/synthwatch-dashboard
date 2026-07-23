"use client";

import { useMemo } from "react";
import Link from "next/link";

import { useIncidentHistory, useChecks, useTags } from "@/lib/client";
import { ToneBadge } from "@/components/status-badge";
import { DateRangeControl, useDateRange } from "@/components/date-range-control";
import { EmptyState, ErrorState, Spinner } from "@/components/states";
import { TagFilter, useTagFilter, matchesTags } from "@/components/tag-filter";
import { severityMeta, resolutionReasonLabel } from "@/lib/status";
import { formatLocalDateTime, formatRelative, formatSpan } from "@/lib/format";
import type { IncidentWithCheck, Tag } from "@/lib/types";
import { RcaPanel } from "@/components/rca-panel";

// Open incidents are count-bounded (≤1 open per check, server-enforced) and a long-running one must
// never be hidden by a date window — so the open list is fetched UNWINDOWED. Resolved incidents grow
// without bound over time, so they are the cursor-paginated + date-ranged list.
const NO_RANGE = {} as const;

function IncidentRow({ incident }: { incident: IncidentWithCheck }) {
  const meta = severityMeta(incident.severity);
  const open = incident.resolved_at === null;
  return (
    <div className="sw-rail relative grid grid-cols-1 gap-3 px-4 py-3.5 sm:grid-cols-[auto_1fr_auto] sm:items-center"
      data-testid="incident-row"
      style={{ ["--rail" as string]: incident.severity === "critical" ? "var(--color-fail)" : "var(--color-warn)" }}
    >
      {/* Stretched link: the whole row navigates to the investigation page. Valid
          HTML (a sibling overlay, not a nested <a>); the check-name link below is
          raised above it (relative z-10) so it still navigates to the check. */}
      <Link
        href={`/incidents/${incident.id}`}
        className="absolute inset-0 z-0"
        aria-label={`Investigate incident ${incident.id}`}
      />
      <ToneBadge label={meta.label} token={meta.token} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/checks/${incident.check_id}`}
            // min-h-6 + flex centering = a ≥24px pointer target (WCAG 2.5.8, new in 2.2 — axe SERIOUS on
            // these z-raised row links). Visual size is unchanged; only the hit area grows.
            className="relative z-10 inline-flex min-h-6 items-center truncate text-sm font-medium text-[var(--color-ink)] hover:text-[var(--color-brand)]"
          >
            {incident.check_name}
          </Link>
          <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
            {incident.check_kind}
          </span>
          <span className="sw-mono rounded-full border border-[var(--color-border-strong)] px-1.5 text-[10px] uppercase tracking-wider text-[var(--color-ink-dim)]">
            {incident.status}
          </span>
          {/* A resolved-without-recovery close (monitor stopped running) reads as an ordinary "resolved" in the
              list otherwise — indistinguishable from a genuine recovery. A neutral (idle, never green) chip marks
              it so an operator scanning the list isn't misled. null (genuine recovery) → no chip. */}
          {incident.resolution_reason && (
            <span className="relative z-10" data-testid="resolution-reason-chip">
              <ToneBadge label={resolutionReasonLabel(incident.resolution_reason)} token="idle" />
            </span>
          )}
        </div>
        {incident.summary && (
          // Historical snapshot captured at incident-open time — it may reference
          // the check's name/flow AS IT WAS THEN (which can differ from the
          // current name above). Framed as a quoted "at open" snapshot so the
          // difference reads as intentional history, not a mismatch. Not rewritten.
          <p className="mt-0.5 text-sm text-[var(--color-ink-dim)]">
            <span className="sw-mono mr-1.5 text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
              at open
            </span>
            <span className="italic">“{incident.summary}”</span>
          </p>
        )}
      </div>
      <div className="text-left sm:text-right">
        <div className="sw-mono text-sm text-[var(--color-ink)]">
          {formatSpan(incident.opened_at, incident.resolved_at)}
        </div>
        <div className="sw-mono text-[11px] text-[var(--color-ink-faint)]">
          {incident.consecutive_failures} consecutive ·{" "}
          {open
            ? `opened ${formatRelative(incident.opened_at)}`
            : `resolved ${formatLocalDateTime(incident.resolved_at)}`}
        </div>
      </div>
      {/* rca null → nothing renders (graceful, exactly as before RCA existed) */}
      {incident.rca && <RcaPanel rca={incident.rca} />}
    </div>
  );
}

export default function IncidentsPage() {
  // Open: all open incidents, unwindowed (count-bounded: ≤1 open per check). Fetched at a large page
  // size so the list is effectively complete in one page — the open section has no Load-more and must
  // never silently truncate a still-open incident. Resolved: cursor-paginated over a date-range window
  // (default 30d) with Load more — the unbounded-over-time set.
  const openH = useIncidentHistory({ status: "open" }, NO_RANGE, 200);
  const dateRange = useDateRange("30d");
  const resolvedH = useIncidentHistory({ status: "resolved" }, dateRange.range);

  const { data: checks } = useChecks();
  const { data: inUseTags } = useTags();
  const { selected, toggle, clear } = useTagFilter();

  // Filter incidents by their CHECK's tags — looked up in the already-cached checks
  // list (no per-incident fetch). Empty checks (not loaded) → no match while loading.
  const tagsByCheck = useMemo(() => {
    const m = new Map<number, Tag[]>();
    for (const c of checks ?? []) m.set(c.id, c.tags);
    return m;
  }, [checks]);
  const match = (i: IncidentWithCheck) => matchesTags(tagsByCheck.get(i.check_id), selected);

  const open = openH.incidents.filter(match);
  const resolved = resolvedH.incidents.filter(match);
  // Counts are over what's LOADED (cursor pagination has no total); resolved grows as you Load more.
  const totalLoaded = openH.incidents.length + resolvedH.incidents.length;
  const shown = open.length + resolved.length;

  const initialLoading = openH.isLoading || resolvedH.isLoading;
  const error = openH.error ?? resolvedH.error;

  function onResolvedRangeChange() {
    resolvedH.reset(); // restart the resolved cursor walk for the new window
  }

  return (
    <div className="space-y-6">
      <header>
        <p className="sw-eyebrow">Reliability</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Incidents</h1>
      </header>

      {totalLoaded > 0 && (
        <TagFilter
          available={inUseTags ?? []}
          selected={selected}
          onToggle={toggle}
          onClear={clear}
          resultLabel={`${shown} of ${totalLoaded} incidents match`}
        />
      )}

      {initialLoading && totalLoaded === 0 ? (
        <div className="py-16"><Spinner label="Loading incidents…" /></div>
      ) : error ? (
        <ErrorState message={error instanceof Error ? error.message : "Failed to load incidents."} />
      ) : (
        <div className="space-y-8">
          <section data-testid="incidents-open">
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-sm font-semibold text-[var(--color-ink)]">Open</h2>
              <span className="sw-mono text-xs text-[var(--color-ink-faint)]">({open.length})</span>
            </div>
            {open.length === 0 ? (
              <div className="sw-panel flex items-center gap-2 px-4 py-5 text-sm text-[var(--color-ink-dim)]">
                <span className="sw-dot sw-dot-pass" />{" "}
                {selected.length > 0 ? "No open incidents match this filter." : "All clear — no open incidents."}
              </div>
            ) : (
              <div className="sw-panel divide-y divide-[var(--color-border)] overflow-hidden">
                {open.map((i) => (
                  <IncidentRow key={i.id} incident={i} />
                ))}
              </div>
            )}
          </section>

          <section data-testid="incidents-resolved">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-[var(--color-ink)]">Resolved</h2>
                <span className="sw-mono text-xs text-[var(--color-ink-faint)]">
                  ({resolved.length}{resolvedH.hasMore ? "+" : ""})
                </span>
              </div>
              <DateRangeControl
                state={dateRange}
                onModeChange={onResolvedRangeChange}
                ariaLabel="resolved incidents date range"
                testIdPrefix="incidents"
              />
            </div>
            {resolved.length === 0 ? (
              <EmptyState
                title={selected.length > 0 ? "No resolved incidents match this filter." : "No resolved incidents in this window."}
              />
            ) : (
              <>
                <div className="sw-panel divide-y divide-[var(--color-border)] overflow-hidden">
                  {resolved.map((i) => (
                    <IncidentRow key={i.id} incident={i} />
                  ))}
                </div>
                {resolvedH.hasMore && (
                  <div className="mt-3 flex justify-center">
                    <button
                      type="button"
                      onClick={resolvedH.loadMore}
                      disabled={resolvedH.isLoadingMore}
                      className="sw-btn"
                      data-testid="incidents-load-more"
                    >
                      {resolvedH.isLoadingMore ? "Loading…" : "Load more"}
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
