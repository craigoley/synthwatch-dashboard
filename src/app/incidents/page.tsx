"use client";

import { useMemo } from "react";
import Link from "next/link";

import { useIncidents, useChecks, useTags } from "@/lib/client";
import { ToneBadge } from "@/components/status-badge";
import { EmptyState, ErrorState, Spinner } from "@/components/states";
import { TagFilter, useTagFilter, matchesTags } from "@/components/tag-filter";
import { severityMeta } from "@/lib/status";
import { formatLocalDateTime, formatRelative, formatSpan } from "@/lib/format";
import type { IncidentWithCheck, Tag } from "@/lib/types";
import { RcaPanel } from "@/components/rca-panel";

function IncidentRow({ incident }: { incident: IncidentWithCheck }) {
  const meta = severityMeta(incident.severity);
  const open = incident.resolved_at === null;
  return (
    <div className="sw-rail relative grid grid-cols-1 gap-3 px-4 py-3.5 sm:grid-cols-[auto_1fr_auto] sm:items-center"
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
            className="relative z-10 truncate text-sm font-medium text-[var(--color-ink)] hover:text-[var(--color-brand)]"
          >
            {incident.check_name}
          </Link>
          <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
            {incident.check_kind}
          </span>
          <span className="sw-mono rounded-full border border-[var(--color-border-strong)] px-1.5 text-[10px] uppercase tracking-wider text-[var(--color-ink-dim)]">
            {incident.status}
          </span>
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
  const { data, error, isLoading } = useIncidents();
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

  const open = (data?.open ?? []).filter(match);
  const resolved = (data?.resolved ?? []).filter(match);
  const total = (data?.open.length ?? 0) + (data?.resolved.length ?? 0);
  const shown = open.length + resolved.length;

  return (
    <div className="space-y-6">
      <header>
        <p className="sw-eyebrow">Reliability</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Incidents</h1>
      </header>

      {data && total > 0 && (
        <TagFilter
          available={inUseTags ?? []}
          selected={selected}
          onToggle={toggle}
          onClear={clear}
          resultLabel={`${shown} of ${total} incidents match`}
        />
      )}

      {isLoading && !data ? (
        <div className="py-16"><Spinner label="Loading incidents…" /></div>
      ) : error ? (
        <ErrorState message={error instanceof Error ? error.message : "Failed to load incidents."} />
      ) : !data ? null : (
        <div className="space-y-8">
          <section>
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

          <section>
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-sm font-semibold text-[var(--color-ink)]">Resolved</h2>
              <span className="sw-mono text-xs text-[var(--color-ink-faint)]">({resolved.length})</span>
            </div>
            {resolved.length === 0 ? (
              <EmptyState
                title={selected.length > 0 ? "No resolved incidents match this filter." : "No resolved incidents yet."}
              />
            ) : (
              <div className="sw-panel divide-y divide-[var(--color-border)] overflow-hidden">
                {resolved.map((i) => (
                  <IncidentRow key={i.id} incident={i} />
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
