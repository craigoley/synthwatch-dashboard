"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

import { useIncident, useCheckTags } from "@/lib/client";
import { getRunTraceSas } from "@/lib/api-client";
import { StatusBadge, ToneBadge, TONE_VAR } from "@/components/status-badge";
import { RcaPanel } from "@/components/rca-panel";
import { TagChips } from "@/components/tag-chips";
import { EnvBadge } from "@/components/env-badge";
import { EmptyState, ErrorState, Spinner } from "@/components/states";
import { runStatusMeta, severityMeta, resolutionReasonLabel, resolutionReasonExplanation } from "@/lib/status";
import { formatDuration, formatLocalDateTime, formatRelative, formatSpan } from "@/lib/format";
import type {
  IncidentDetail,
  IncidentResolutionReason,
  IncidentTimelineRun,
  LocationStatus,
  NearbyDeploy,
} from "@/lib/types";

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
 *  with links out to the screenshot + trace proxy when present — and a deep link into the
 *  check's run history (`/checks/{id}#run-{runId}`, the anchor run-history already serves),
 *  where the run's funnel, AI insights, baseline-diff, and embedded trace viewer live. */
function Timeline({
  runs,
  checkId,
  total,
  resolutionReason,
}: {
  runs: IncidentTimelineRun[];
  checkId: number;
  total: number | null;
  resolutionReason: IncidentResolutionReason | null;
}) {
  // The API caps a long incident's timeline server-side (the 2,309-run/765KB payload lesson). When the
  // cap bit and the API says so (timeline_total > rows served), caption it honestly; a pre-cap API sends
  // no total (null) → the plain count renders exactly as before (forward-compatible).
  const truncated = total != null && total > runs.length;
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">Run timeline</h2>
        <span className="sw-mono text-xs text-[var(--color-ink-faint)]" data-testid="timeline-count">
          {truncated ? `showing newest ${runs.length} of ${total}` : `(${runs.length})`}
        </span>
      </div>
      {/* A run-less (administrative) close leaves NO green recovery run, so the newest run is red. That is
          CORRECT here, not a rendering bug — explain it so the all-red timeline under a "resolved" incident
          isn't misread as still-broken-yet-closed. We never fake a green terminal or hide the red run. */}
      {resolutionReason && (
        <p className="mb-3 text-[12px] text-[var(--color-ink-dim)]" data-testid="timeline-no-recovery-note">
          No recovery run: this incident was closed because the monitor stopped running (see “Closed without
          recovery” above). The final run is red because the failure was never confirmed fixed — not because the
          incident is still open.
        </p>
      )}
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
                  {/* Deep link to this run in the check's run history — the richer per-run view
                      (funnel, AI insights, baseline-diff, embedded trace viewer). The #run-<id>
                      anchor expands + scrolls to the row when it's in the loaded window. */}
                  <Link
                    href={`/checks/${checkId}#run-${r.run_id}`}
                    data-testid={`timeline-run-link-${r.run_id}`}
                    className="sw-mono text-[11px] text-[var(--color-brand)] hover:underline"
                  >
                    view run #{r.run_id} →
                  </Link>
                  {/* ★ SAME-ORIGIN proxies, never raw apiUrl(): the API gates artifacts behind a bearer
                      (synthwatch-api #154), and a bare <a href> to the cross-origin API carries neither the
                      bearer nor the proxy cookie → 401 even for logged-in users. The proxies forward the
                      session cookie as the bearer. */}
                  {r.screenshot_url && (
                    <a
                      href={`/screenshot-proxy/${r.run_id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="sw-mono text-[11px] text-[var(--color-brand)] hover:underline"
                    >
                      ↗ screenshot
                    </a>
                  )}
                  {r.trace_url && (
                    // Mint a short-TTL SAS on click, then open the trace zip directly (off the Vercel proxy).
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          const sas = await getRunTraceSas(r.run_id);
                          window.open(sas.url, "_blank", "noopener");
                        } catch {
                          /* best-effort link — the full viewer (run history) surfaces load errors */
                        }
                      }}
                      className="sw-mono text-[11px] text-[var(--color-brand)] hover:underline"
                    >
                      ↗ trace
                    </button>
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

/**
 * Deploys DETECTED near this incident — ★ possible CORRELATION, never CAUSATION. detected_at is DETECTION time
 * (a monitor run first SAW the deploy), so it lags the real deploy. Empty → the section is ABSENT (no fabricated
 * content); a fetch failure surfaces at the incident level as a loud ErrorState (this data rides the incident
 * payload), never a silent blank here.
 */
function NearbyDeploys({ deploys }: { deploys: NearbyDeploy[] }) {
  if (deploys.length === 0) return null; // honest-empty → render absence, never a placeholder row
  return (
    <section data-testid="incident-nearby-deploys">
      <h2 className="text-sm font-semibold text-[var(--color-ink)]">Deploys detected near this incident</h2>
      <p className="mt-1 text-[12px] text-[var(--color-ink-dim)]">
        Possible correlation — not causation. The timestamp is <strong>detection</strong> time (when a monitor run
        first saw the deploy), which lags the actual deploy.
      </p>
      <ul className="mt-2 space-y-1.5">
        {deploys.map((d, i) => {
          const mins = Math.abs(d.offset_minutes);
          const dir = d.offset_minutes <= 0 ? "before" : "after"; // negative offset = detected before open
          const ident = d.is_sha ? d.sha.slice(0, 7) : d.fingerprint; // short-SHA, else the fingerprint label
          return (
            <li
              key={i}
              data-testid="incident-nearby-deploy"
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-l-2 pl-3 text-[13px]"
              style={{ borderColor: TONE_VAR.warn }}
            >
              <span className="text-[var(--color-ink)]">
                Deploy detected{" "}
                <strong>
                  {mins} min {dir}
                </strong>{" "}
                this incident opened
              </span>
              <span className="sw-mono text-[12px] text-[var(--color-ink-dim)]">
                {d.source} · {d.is_sha ? "SHA" : "fingerprint"} <code>{ident}</code> · detected{" "}
                {formatRelative(d.detected_at)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function IncidentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { data: incident, error, isLoading } = useIncident(Number.isFinite(id) ? id : null);
  // The check's tags (the incident payload doesn't embed them) — graceful 404 pre-API.
  const { data: checkTags } = useCheckTags(incident?.check_id ?? null);

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
          {/* Env is as visible as tags on every surface now — the shared <EnvBadge> (self-hides for prod)
              finishes #237, which deferred incident detail until the DTO carried environment. */}
          <EnvBadge check={{ environment: incident.environment, id: incident.check_id }} />
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
        <TagChips tags={checkTags ?? []} className="mt-2" />
      </header>

      {/* ★ Run-less resolve (runner 0095 closeStrandedIncidents): a resolved incident with resolution_reason set
          was NOT recovered — the monitor stopped running, so it was closed administratively. State that plainly,
          name the cause, and make clear it is not a recovery. null (genuine recovery) → nothing renders. */}
      {incident.resolution_reason && (
        <div
          className="sw-panel border-l-2 p-4"
          style={{ borderLeftColor: TONE_VAR.warn }}
          data-testid="resolution-reason-note"
        >
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-[var(--color-ink)]">Closed without recovery</h2>
            <ToneBadge label={resolutionReasonLabel(incident.resolution_reason)} token="idle" />
          </div>
          <p className="mt-1.5 text-sm text-[var(--color-ink-dim)]">
            {resolutionReasonExplanation(incident.resolution_reason)}
          </p>
        </div>
      )}

      <PerLocation locations={incident.per_location ?? []} />

      {/* deploy-proximity annotation — correlation, not causation; absent when none (honest-empty) */}
      <NearbyDeploys deploys={incident.nearby_deploys ?? []} />

      {/* rca null → no panel (graceful, exactly like the list) */}
      {incident.rca && <RcaPanel rca={incident.rca} />}

      <Timeline
        runs={incident.timeline ?? []}
        checkId={incident.check_id}
        total={incident.timeline_total}
        resolutionReason={incident.resolution_reason}
      />

      <Recurrence items={incident.recurrence ?? []} currentId={incident.id} />
    </div>
  );
}
