"use client";

import Link from "next/link";

import { NarrativeCard } from "@/components/narrative-card";
import { MonitorReportDetail } from "@/components/monitor-report-detail";
import { Sparkline } from "@/components/sparkline";
import { StatusDot } from "@/components/status-badge";
import { TagChips } from "@/components/tag-chips";
import { EnvBadge } from "@/components/env-badge";
import { availabilityTone } from "@/lib/status";
import { formatDuration, formatPct } from "@/lib/format";
import type { CheckKind, ReportWindow, RunStatus, SparkPoint, Tag, IncidentSeverity } from "@/lib/types";

/**
 * One per-monitor report (Phase: reports redesign). Assembled in the reports page from the PROVEN data
 * sources (the live checks list + the SLA endpoint + optional rollup-report enrichment), so a monitor that
 * has data always renders — the old list bound only to /reports/availability, which can be empty even when
 * monitors exist. A card shows the at-a-glance health a director wants: windowed availability, latency,
 * incidents, a trend, and the per-monitor AI narrative; it expands to the full drill-down.
 */
export interface ReportRow {
  check_id: number;
  name: string;
  kind: CheckKind;
  /** Authoritative deployment env (checks.environment) — rendered via <EnvBadge>, self-hides for prod. */
  environment: string;
  current_status: RunStatus | null;
  tags: Tag[];
  /** Availability over the selected window (computed from SLA up/down, or the rollup report when present). */
  availability_pct: number | null;
  up_runs: number;
  down_runs: number;
  completed_runs: number;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  /** true when latency came from the windowed rollup report; false = the live 24h metrics (labelled). */
  latency_windowed: boolean;
  open_incident_count: number;
  max_open_severity: IncidentSeverity | null;
  /** Incidents opened during the window (rollup report); null when that source is unavailable. */
  incident_window_count: number | null;
  /** Signed days to TLS cert expiry (SSL checks only; null for everything else — never 0 as a sentinel). */
  last_cert_days_remaining: number | null;
  /** Per-check cert warn threshold (days) — the badge warns exactly when the runner does; null → runner's ?? 30. */
  cert_expiry_warn_days: number | null;
  spark: SparkPoint[];
}

/**
 * TLS cert runway badge. SSL checks only — `null` (non-cert) renders NOTHING (gaps-not-zeros: never a
 * misleading "0 days"). For a cert check, 0 = expires today, negative = already expired (both real, loud).
 *
 * Tones MIRROR the runner's cert states so the dashboard never silently disagrees with it: the runner emits
 * a `warn` run (and emails the alert) once days-remaining <= the per-check `cert_expiry_warn_days` (its own
 * `?? 30` default), and a cert is only a hard fail once it has ACTUALLY expired — there is no separate runner
 * "fail-soon" cert tier. So: expired (< 0) → fail, inside the per-check warn window → warn, else pass. We read
 * the check's own `warnDays` (NOT a hardcoded 14) — otherwise a cert ~20d out would show green here while the
 * runner had already warned+emailed (the #175/#177 false-green class). The exact day count stays in the label,
 * so urgency is legible without inventing a red tier the runner doesn't have.
 */
function CertRunway({ days, warnDays }: { days: number | null; warnDays: number | null }) {
  if (days == null) return null;
  const warnAt = warnDays ?? 30; // mirror the runner's `cert_expiry_warn_days ?? 30`
  const tone = days < 0 ? "fail" : days <= warnAt ? "warn" : "pass";
  const label = days < 0 ? "cert expired" : days === 0 ? "cert expires today" : `cert ${days}d`;
  return (
    <span
      data-testid="cert-runway"
      data-tone={tone}
      className="sw-mono inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px]"
      style={{
        color: `var(--color-${tone})`,
        background: `color-mix(in srgb, var(--color-${tone}) 12%, transparent)`,
      }}
      title={`TLS certificate ${days < 0 ? "expired" : `expires in ${days} day${days === 1 ? "" : "s"}`}`}
    >
      {label}
    </span>
  );
}

function Metric({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone?: string;
  sub?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] uppercase tracking-wider text-[var(--color-ink-faint)]">{label}</div>
      <div className="sw-mono truncate text-sm font-medium" style={{ color: tone ?? "var(--color-ink)" }}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-[var(--color-ink-faint)]">{sub}</div>}
    </div>
  );
}

/** A thin uptime bar — green proportion = up / (up+down) over the window. Muted when no runs. */
function UptimeBar({ up, down }: { up: number; down: number }) {
  const total = up + down;
  if (total === 0) {
    return <div className="h-1.5 w-full rounded-full bg-[var(--color-border)]" title="no runs in window" />;
  }
  const upPct = (up / total) * 100;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-fail)]" title={`${up} up · ${down} down`}>
      <div className="h-full rounded-full" style={{ width: `${upPct}%`, background: "var(--color-pass)" }} />
    </div>
  );
}

export function MonitorReportCard({
  row,
  window,
  open,
  onToggle,
}: {
  row: ReportRow;
  window: ReportWindow;
  open: boolean;
  onToggle: () => void;
}) {
  // Honest empty: only when this monitor genuinely has nothing to report from ANY source — no windowed
  // availability, no latency, no completed runs. (A populated availability/latency from any source means
  // there IS data, even if one source — e.g. the rollup report — is empty.)
  const noData =
    row.availability_pct == null && row.p50_ms == null && row.p95_ms == null && row.completed_runs === 0;
  const incidents = row.incident_window_count ?? row.open_incident_count;
  const incidentLabel = row.incident_window_count != null ? `Incidents (${window})` : "Open incidents";

  return (
    <section className="sw-panel overflow-hidden" data-testid={`report-${row.check_id}`}>
      <div className="flex flex-col gap-3 p-4">
        {/* header — the toggle button (name as text, no nested link) + a separate link to the monitor */}
        <div className="flex items-start justify-between gap-3">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="flex min-w-0 items-center gap-2.5 text-left"
            data-testid={`report-toggle-${row.check_id}`}
          >
            <span aria-hidden className="text-[10px] text-[var(--color-ink-faint)]">{open ? "▾" : "▸"}</span>
            <StatusDot status={row.current_status} />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-[var(--color-ink)]">{row.name}</span>
              <span className="flex flex-wrap items-center gap-1.5">
                <EnvBadge check={{ environment: row.environment, id: row.check_id }} />
                <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">{row.kind}</span>
                <CertRunway days={row.last_cert_days_remaining} warnDays={row.cert_expiry_warn_days} />
                <TagChips tags={row.tags} />
              </span>
            </span>
          </button>
          <div className="flex shrink-0 items-center gap-3">
            <span
              className="sw-mono text-lg font-semibold sm:text-xl"
              style={{ color: availabilityTone(row.availability_pct) }}
              title="availability over the window"
            >
              {formatPct(row.availability_pct)}
            </span>
            <Link
              href={`/checks/${row.check_id}`}
              className="text-[var(--color-ink-faint)] transition hover:text-[var(--color-brand)]"
              title="Open monitor"
              aria-label={`Open ${row.name}`}
            >
              ↗
            </Link>
          </div>
        </div>

        {noData ? (
          <p className="text-[12px] text-[var(--color-ink-faint)]">No completed runs in this window yet.</p>
        ) : (
          <>
            <UptimeBar up={row.up_runs} down={row.down_runs} />

            {/* metric strip */}
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
              <Metric label="p50" value={formatDuration(row.p50_ms)} sub={row.latency_windowed ? window : "24h"} />
              <Metric label="p95" value={formatDuration(row.p95_ms)} sub={row.latency_windowed ? window : "24h"} />
              <Metric label="p99" value={formatDuration(row.p99_ms)} sub={row.latency_windowed ? window : undefined} />
              <Metric
                label={incidentLabel}
                value={String(incidents)}
                tone={incidents > 0 ? "var(--color-fail)" : "var(--color-ink-dim)"}
              />
              <Metric label="Runs" value={row.completed_runs.toLocaleString()} sub={window} />
              <div className="col-span-3 flex items-end justify-end sm:col-span-1">
                <Sparkline points={row.spark} width={110} height={28} />
              </div>
            </div>
          </>
        )}

        {/* per-monitor AI narrative (Layer 3) — hides until the endpoint serves one (currently 7d). */}
        <NarrativeCard scope="monitor" checkKey={row.check_id} window={window} compact />
      </div>

      {open && <MonitorReportDetail checkId={row.check_id} kind={row.kind} window={window} hideNarrative />}
    </section>
  );
}
