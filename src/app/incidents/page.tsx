"use client";

import Link from "next/link";

import { useIncidents } from "@/lib/client";
import { ToneBadge } from "@/components/status-badge";
import { EmptyState, ErrorState, Spinner } from "@/components/states";
import { severityMeta } from "@/lib/status";
import { formatLocalDateTime, formatRelative, formatSpan } from "@/lib/format";
import type { IncidentRca, IncidentWithCheck, RcaClassification } from "@/lib/types";

const RCA_LABEL: Record<RcaClassification, string> = {
  "real-outage": "Real outage",
  "flaky-transient": "Flaky / transient",
  "selector-drift": "Selector drift",
  "environment-regional": "Environment / regional",
  "perf-regression": "Perf regression",
};
// A real outage is red; perf/selector/environment are amber (degraded, not a hard
// down); flaky-transient is neutral (likely noise).
const RCA_TONE: Record<RcaClassification, "fail" | "warn" | "idle"> = {
  "real-outage": "fail",
  "perf-regression": "warn",
  "selector-drift": "warn",
  "environment-regional": "warn",
  "flaky-transient": "idle",
};

/**
 * Runner root-cause analysis. ★ The observed-vs-inferred split is the whole point:
 * OBSERVED = facts the evidence shows (solid, confident styling); INFERRED = the
 * model's hypotheses (dashed, tentative, italic). The human must never mistake a
 * guess for a fact, so the two blocks are deliberately styled differently.
 */
function RcaPanel({ rca }: { rca: IncidentRca }) {
  return (
    <div className="col-span-full mt-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">Root cause</span>
        <ToneBadge label={RCA_LABEL[rca.classification]} token={RCA_TONE[rca.classification]} />
        <span className="sw-mono rounded-full border border-[var(--color-border-strong)] px-1.5 text-[10px] uppercase tracking-wider text-[var(--color-ink-dim)]">
          {rca.confidence} confidence
        </span>
      </div>
      {rca.summary && <p className="mb-3 text-sm text-[var(--color-ink-dim)]">{rca.summary}</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {/* OBSERVED — facts: solid border, panel bg, normal text */}
        <div className="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-panel-2)] p-2.5">
          <div className="mb-1.5 flex items-center gap-1.5">
            <span className="sw-dot" style={{ background: "var(--color-pass)" }} />
            <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink)]">Observed · facts</span>
          </div>
          {rca.observed.length > 0 ? (
            <ul className="space-y-1 text-[12px] text-[var(--color-ink-dim)]">
              {rca.observed.map((o, i) => (
                <li key={i}>• {o}</li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-[var(--color-ink-faint)]">—</p>
          )}
        </div>
        {/* INFERRED — hypotheses: DASHED border, no bg, italic muted text */}
        <div className="rounded-md border border-dashed border-[var(--color-border-strong)] p-2.5">
          <div className="mb-1.5 flex items-center gap-1.5">
            <span className="sw-dot" style={{ background: "var(--color-warn)" }} />
            <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-dim)]">
              Inferred · model&apos;s hypothesis
            </span>
          </div>
          {rca.inferred.length > 0 ? (
            <ul className="space-y-1 text-[12px] italic text-[var(--color-ink-faint)]">
              {rca.inferred.map((x, i) => (
                <li key={i}>~ {x}</li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-[var(--color-ink-faint)]">—</p>
          )}
        </div>
      </div>
    </div>
  );
}

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
