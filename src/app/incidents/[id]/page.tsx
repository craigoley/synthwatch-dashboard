"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

import { useIncident } from "@/lib/client";
import { apiUrl } from "@/lib/api-client";
import { StatusBadge, ToneBadge, TONE_VAR } from "@/components/status-badge";
import { RcaPanel } from "@/components/rca-panel";
import { EmptyState, ErrorState, Spinner } from "@/components/states";
import { runStatusMeta, severityMeta } from "@/lib/status";
import { formatDuration, formatLocalDateTime, formatRelative, formatSpan } from "@/lib/format";
import type { IncidentDetail, IncidentTimelineRun, LocationStatus } from "@/lib/types";

const isDown = (s: string) => s === "fail" || s === "error";

/** Per-location latest status with the shared "Regional N/M" semantics (hidden if single-location). */
function PerLocation({ locations }: { locations: LocationStatus[] }) {
  if (locations.length <= 1) return null;
  const down = locations.filter((l) => isDown(l.status)).length;
  const verdict =
    down === 0
      ? { label: "Healthy in all locations", token: "pass" as const }
      : down === locations.length
        ? { label: "Global — all locations failing", token: "fail" as const }
        : { label: `Regional — ${down}/${locations.length} locations failing`, token: "warn" as const };
  return (
    <div className="sw-panel p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">By location</h2>
        <span className="sw-mono text-[11px] font-medium" style={{ color: TONE_VAR[verdict.token] }}>
          {verdict.label}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {locations.map((l) => (
          <div
            key={l.location}
            className="flex items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2"
          >
            <span className="sw-mono truncate text-[12px] text-[var(--color-ink-dim)]">{l.location}</span>
            <StatusBadge status={l.status} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** ★ The evidence trail behind the RCA: each run, failed (red) vs recovery (green),
 *  with links out to the screenshot + trace proxy when present. */
function Timeline({ runs }: { runs: IncidentTimelineRun[] }) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">Run timeline</h2>
        <span className="sw-mono text-xs text-[var(--color-ink-faint)]">({runs.length})</span>
      </div>
      {runs.length === 0 ? (
        <EmptyState title="No runs recorded for this incident." />
      ) : (
        <div className="space-y-2">
          {runs.map((r) => (
            <div
              key={r.run_id}
              className="sw-panel border-l-2 p-3"
              style={{ borderLeftColor: TONE_VAR[runStatusMeta(r.status).token] }}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <StatusBadge status={r.status} />
                <span className="text-sm text-[var(--color-ink)]">{formatLocalDateTime(r.started_at)}</span>
                <span className="sw-mono text-[12px] text-[var(--color-ink-dim)]">{formatDuration(r.duration_ms)}</span>
                {r.http_status !== null && (
                  <span className="sw-mono text-[11px] text-[var(--color-ink-faint)]">HTTP {r.http_status}</span>
                )}
                {r.location && r.location !== "default" && (
                  <span className="sw-mono text-[11px] text-[var(--color-ink-faint)]">{r.location}</span>
                )}
                {r.failed_step && (
                  <span className="sw-mono text-[11px]" style={{ color: "var(--color-fail)" }}>
                    ✕ {r.failed_step}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-3">
                  {r.screenshot_url && (
                    <a
                      href={apiUrl(r.screenshot_url)}
                      target="_blank"
                      rel="noreferrer"
                      className="sw-mono text-[11px] text-[var(--color-brand)] hover:underline"
                    >
                      ↗ screenshot
                    </a>
                  )}
                  {r.trace_url && (
                    <a
                      href={apiUrl(r.trace_url)}
                      target="_blank"
                      rel="noreferrer"
                      className="sw-mono text-[11px] text-[var(--color-brand)] hover:underline"
                    >
                      ↗ trace
                    </a>
                  )}
                </span>
              </div>
              {r.error_message && (
                <p className="sw-mono mt-2 text-[12px] text-[var(--color-ink-dim)]">{r.error_message}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Recurrence({ items, currentId }: { items: IncidentDetail["recurrence"]; currentId: number }) {
  const others = items.filter((i) => i.id !== currentId);
  if (others.length === 0) return null;
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">Recurrence</h2>
        <span className="sw-mono text-xs text-[var(--color-ink-faint)]">
          this check has had {others.length + 1} incidents recently
        </span>
      </div>
      <div className="sw-panel divide-y divide-[var(--color-border)] overflow-hidden">
        {others.map((i) => (
          <Link
            key={i.id}
            href={`/incidents/${i.id}`}
            className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-[var(--color-panel-2)]"
          >
            <span className="min-w-0">
              <span className="sw-mono text-[11px] uppercase tracking-wider text-[var(--color-ink-faint)]">
                {i.status}
              </span>
              {i.summary && <span className="ml-2 text-sm italic text-[var(--color-ink-dim)]">“{i.summary}”</span>}
            </span>
            <span className="sw-mono shrink-0 text-[11px] text-[var(--color-ink-faint)]">
              {formatSpan(i.opened_at, i.resolved_at)}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

export default function IncidentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { data: incident, error, isLoading } = useIncident(Number.isFinite(id) ? id : null);

  if (isLoading && !incident) return <div className="py-16"><Spinner label="Loading incident…" /></div>;
  if (error) {
    return <ErrorState message={error instanceof Error ? error.message : "Failed to load incident."} />;
  }
  if (!incident) return <EmptyState title="Incident not found." />;

  const open = incident.resolved_at === null;
  const sev = severityMeta(incident.severity);

  return (
    <div className="space-y-6">
      <header>
        <Link href="/incidents" className="sw-mono text-[11px] text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]">
          ← Incidents
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Incident #{incident.id}</h1>
          <ToneBadge label={sev.label} token={sev.token} />
          <span className="sw-mono rounded-full border border-[var(--color-border-strong)] px-1.5 text-[10px] uppercase tracking-wider text-[var(--color-ink-dim)]">
            {incident.status}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-[var(--color-ink-dim)]">
          <Link href={`/checks/${incident.check_id}`} className="text-[var(--color-brand)] hover:underline">
            {incident.check_name}
          </Link>
          <span className="sw-mono uppercase text-[var(--color-ink-faint)]">{incident.check_kind}</span>
          <span>· {incident.consecutive_failures} consecutive failures</span>
          <span>
            ·{" "}
            {open
              ? `opened ${formatRelative(incident.opened_at)}`
              : `resolved ${formatLocalDateTime(incident.resolved_at)}`}
          </span>
          <span>· lasted {formatSpan(incident.opened_at, incident.resolved_at)}</span>
        </div>
      </header>

      <PerLocation locations={incident.per_location ?? []} />

      {/* rca null → no panel (graceful, exactly like the list) */}
      {incident.rca && <RcaPanel rca={incident.rca} />}

      <Timeline runs={incident.timeline ?? []} />

      <Recurrence items={incident.recurrence ?? []} currentId={incident.id} />
    </div>
  );
}
