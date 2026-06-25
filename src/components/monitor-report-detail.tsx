"use client";

import { useMemo } from "react";
import Link from "next/link";

import { useRuns, useMetrics, useIncidents } from "@/lib/client";
import { AvailabilityChart, LatencyChart } from "@/components/charts";
import { NarrativeCard } from "@/components/narrative-card";
import { StatusBadge, TONE_VAR } from "@/components/status-badge";
import { formatDuration, formatLocalDateTime, lookbackRange } from "@/lib/format";
import type { CheckKind, MetricPoint, ReportWindow } from "@/lib/types";

const WINDOW_DAYS: Record<ReportWindow, number> = { "7d": 7, "30d": 30, "90d": 90 };

const isFail = (s: string) => s === "fail" || s === "error";

/** Latest non-null web vital across the metric points (browser checks only). */
function latestVitals(metrics: MetricPoint[]) {
  const sorted = [...metrics].sort((a, b) => +new Date(a.started_at) - +new Date(b.started_at));
  const pick = (k: keyof MetricPoint) => {
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      const v = sorted[i]?.[k];
      if (typeof v === "number") return v;
    }
    return null;
  };
  // ★ LCP / FCP / TTFB / CLS only — INP is intentionally omitted (reporting scope).
  return { lcp: pick("lcp_ms"), fcp: pick("fcp_ms"), ttfb: pick("ttfb_ms"), cls: pick("cls") };
}

function Vital({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] px-2.5 py-1.5">
      <div className="sw-mono text-sm font-medium text-[var(--color-ink)]">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">{label}</div>
    </div>
  );
}

/**
 * Per-monitor drill-down for the reports list: availability trend + latency trend,
 * browser-only web vitals (no INP, no empty cards for http/ssl), recent error
 * details, and incident history with RCA links. All from existing per-check endpoints.
 */
export function MonitorReportDetail({
  checkId,
  kind,
  window,
  hideNarrative = false,
}: {
  checkId: number;
  kind: CheckKind;
  window: ReportWindow;
  /** The reports card already shows the per-monitor narrative — suppress the duplicate here. */
  hideNarrative?: boolean;
}) {
  // Recent runs within the report window — for the "recent errors" + latency trend.
  // Memoize on `window`: lookbackRange() reads Date.now() at call time, so calling it
  // inline would mint a fresh from/to (and thus a fresh SWR key) on every render,
  // defeating caching/dedup and triggering a refetch loop against the API.
  const range = useMemo(() => lookbackRange(WINDOW_DAYS[window]), [window]);
  const { data: runsPage } = useRuns(checkId, 50, range);
  const { data: metrics } = useMetrics(kind === "browser" ? checkId : null);
  const { data: incidents } = useIncidents();

  const runs = runsPage?.runs ?? [];
  const failures = runs.filter((r) => isFail(r.status));
  const incs = [...(incidents?.open ?? []), ...(incidents?.resolved ?? [])].filter((i) => i.check_id === checkId);
  const vitals = kind === "browser" && metrics ? latestVitals(metrics) : null;

  return (
    <div className="space-y-4 border-t border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-4" data-testid={`detail-${checkId}`}>
      {/* Compact per-monitor AI narrative — hides until the endpoint serves one. Suppressed when the
          parent reports card already renders it (hideNarrative). */}
      {!hideNarrative && <NarrativeCard scope="monitor" checkKey={checkId} window={window} compact />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AvailabilityChart checkId={checkId} />
        <LatencyChart runs={runs} />
      </div>

      {/* ★ Web vitals — browser checks ONLY; never rendered for http/ssl. */}
      {kind === "browser" && (
        <div data-testid={`vitals-${checkId}`}>
          <div className="sw-eyebrow mb-2">Web vitals (latest)</div>
          {vitals && (vitals.lcp != null || vitals.fcp != null || vitals.ttfb != null || vitals.cls != null) ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Vital label="LCP" value={formatDuration(vitals.lcp)} />
              <Vital label="FCP" value={formatDuration(vitals.fcp)} />
              <Vital label="TTFB" value={formatDuration(vitals.ttfb)} />
              <Vital label="CLS" value={vitals.cls == null ? "—" : vitals.cls.toFixed(2)} />
            </div>
          ) : (
            <p className="text-[11px] text-[var(--color-ink-faint)]">No web-vitals captured yet.</p>
          )}
        </div>
      )}

      {/* Error details — what's actually going wrong (recent failed runs). */}
      <div data-testid={`errors-${checkId}`}>
        <div className="sw-eyebrow mb-2">Recent errors</div>
        {failures.length === 0 ? (
          <p className="text-[11px] text-[var(--color-ink-faint)]">No failures in the recent runs.</p>
        ) : (
          <div className="space-y-1.5">
            {failures.slice(0, 8).map((r) => (
              <div
                key={r.id}
                className="rounded-md border-l-2 px-3 py-2 text-[12px]"
                style={{ borderLeftColor: TONE_VAR.fail, background: "var(--color-panel-2)" }}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  <StatusBadge status={r.status} />
                  <span className="text-[var(--color-ink-dim)]">{formatLocalDateTime(r.started_at)}</span>
                  {r.http_status !== null && (
                    <span className="sw-mono text-[11px] text-[var(--color-ink-faint)]">HTTP {r.http_status}</span>
                  )}
                  {r.failed_step && (
                    <span className="sw-mono text-[11px]" style={{ color: "var(--color-fail)" }}>✕ {r.failed_step}</span>
                  )}
                </div>
                {r.error_message && (
                  <p className="sw-mono mt-1 text-[11px] text-[var(--color-ink-dim)]">{r.error_message}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Incident history + RCA link. */}
      {incs.length > 0 && (
        <div data-testid={`incidents-${checkId}`}>
          <div className="sw-eyebrow mb-2">Incidents</div>
          <div className="sw-panel divide-y divide-[var(--color-border)] overflow-hidden">
            {incs.slice(0, 6).map((i) => (
              <Link
                key={i.id}
                href={`/incidents/${i.id}`}
                className="flex items-center justify-between gap-3 px-3 py-2 text-[12px] hover:bg-[var(--color-panel-2)]"
              >
                <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
                  {i.status}
                </span>
                {i.summary && <span className="flex-1 truncate italic text-[var(--color-ink-dim)]">“{i.summary}”</span>}
                <span className="sw-mono text-[11px] text-[var(--color-brand)]">view RCA →</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
