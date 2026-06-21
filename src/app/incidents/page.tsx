"use client";

import Link from "next/link";

import { useIncidents } from "@/lib/client";
import { ToneBadge } from "@/components/status-badge";
import { EmptyState, ErrorState, Spinner } from "@/components/states";
import { severityMeta } from "@/lib/status";
import { formatLocalDateTime, formatRelative, formatSpan } from "@/lib/format";
import type { IncidentWithCheck } from "@/lib/types";

function IncidentRow({ incident }: { incident: IncidentWithCheck }) {
  const meta = severityMeta(incident.severity);
  const open = incident.resolved_at === null;
  return (
    <div className="sw-rail grid grid-cols-1 gap-3 px-4 py-3.5 sm:grid-cols-[auto_1fr_auto] sm:items-center"
      style={{ ["--rail" as string]: incident.severity === "critical" ? "var(--color-fail)" : "var(--color-warn)" }}
    >
      <ToneBadge label={meta.label} token={meta.token} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/checks/${incident.check_id}`}
            className="truncate text-sm font-medium text-[var(--color-ink)] hover:text-[var(--color-brand)]"
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
          <p className="mt-0.5 truncate text-sm text-[var(--color-ink-dim)]">{incident.summary}</p>
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
    </div>
  );
}

export default function IncidentsPage() {
  const { data, error, isLoading } = useIncidents();

  return (
    <div className="space-y-6">
      <header>
        <p className="sw-eyebrow">Reliability</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Incidents</h1>
      </header>

      {isLoading && !data ? (
        <div className="py-16"><Spinner label="Loading incidents…" /></div>
      ) : error ? (
        <ErrorState message={error instanceof Error ? error.message : "Failed to load incidents."} />
      ) : !data ? null : (
        <div className="space-y-8">
          <section>
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-sm font-semibold text-[var(--color-ink)]">Open</h2>
              <span className="sw-mono text-xs text-[var(--color-ink-faint)]">({data.open.length})</span>
            </div>
            {data.open.length === 0 ? (
              <div className="sw-panel flex items-center gap-2 px-4 py-5 text-sm text-[var(--color-ink-dim)]">
                <span className="sw-dot sw-dot-pass" /> All clear — no open incidents.
              </div>
            ) : (
              <div className="sw-panel divide-y divide-[var(--color-border)] overflow-hidden">
                {data.open.map((i) => (
                  <IncidentRow key={i.id} incident={i} />
                ))}
              </div>
            )}
          </section>

          <section>
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-sm font-semibold text-[var(--color-ink)]">Resolved</h2>
              <span className="sw-mono text-xs text-[var(--color-ink-faint)]">({data.resolved.length})</span>
            </div>
            {data.resolved.length === 0 ? (
              <EmptyState title="No resolved incidents yet." />
            ) : (
              <div className="sw-panel divide-y divide-[var(--color-border)] overflow-hidden">
                {data.resolved.map((i) => (
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
