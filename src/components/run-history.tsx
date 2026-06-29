"use client";

import { useEffect, useState } from "react";

import { useRunHistory } from "@/lib/client";
import { apiUrl } from "@/lib/api-client";
import { FunnelBar } from "@/components/funnel-bar";
import { StatusDot, TONE_VAR } from "@/components/status-badge";
import { DateRangeControl, useDateRange } from "@/components/date-range-control";
import { EmptyState, ErrorState, Spinner } from "@/components/states";
import { runStatusMeta } from "@/lib/status";
import { formatDuration, formatLocalDateTime } from "@/lib/format";
import { TraceViewer } from "@/components/trace-viewer";
import { AiInsightsPanel } from "@/components/ai-insights";
import { BaselineDiffPanel } from "@/components/baseline-diff";
import type { Run } from "@/lib/types";

/**
 * Failure artifacts for a failed browser run: inline screenshot + trace download.
 * screenshot_url / trace_url are proxy PATHS, resolved against the API base via
 * apiUrl(). Both may be null (passing/non-browser runs → section hidden) or 404
 * (blob deleted after 90d retention while the DB url persists) — the <img>
 * onError shows a neutral "unavailable" instead of a broken-image icon.
 */
function RunArtifacts({ run }: { run: Run }) {
  const [imgFailed, setImgFailed] = useState(false);
  const screenshot = run.screenshot_url ? apiUrl(run.screenshot_url) : null;
  // ★ Serve the trace SAME-ORIGIN via the dashboard's own proxy (app/trace-proxy/[id]).
  // The viewer fetch()es the trace, and fetching the cross-origin (API-origin) trace is
  // the documented-broken CORS trap (Playwright #38622); same-origin dodges it entirely
  // and works on prod / preview / localhost alike.
  const traceProxy = run.trace_url ? `/trace-proxy/${run.id}` : null;
  if (!screenshot && !traceProxy) return null;
  return (
    <div className="mt-3 space-y-3">
      {screenshot && (
        <div>
          <div className="mb-2 sw-eyebrow">Failure screenshot</div>
          {imgFailed ? (
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-4 text-xs text-[var(--color-ink-faint)]">
              Screenshot unavailable — the artifact has expired or was removed.
            </div>
          ) : (
            <a href={screenshot} target="_blank" rel="noreferrer">
              <img
                src={screenshot}
                alt={`Failure screenshot for run ${run.id}`}
                onError={() => setImgFailed(true)}
                className="max-h-80 rounded-lg border border-[var(--color-border)]"
              />
            </a>
          )}
        </div>
      )}
      {traceProxy && (
        <div>
          <div className="mb-1 sw-eyebrow">Playwright trace — forensics</div>
          <TraceViewer
            proxyPath={traceProxy}
            openLabel="▸ View trace"
            iframeTitle={`Playwright trace for run ${run.id}`}
            viewTestId={`view-trace-${run.id}`}
            iframeTestId={`trace-viewer-${run.id}`}
          />
          <p className="mt-1.5 text-[11px] text-[var(--color-ink-faint)]">
            Per-action screenshots, console, network waterfall &amp; DOM time-travel — from the trace
            captured on failure.
          </p>
          {/* On-demand AOAI analysis of this trace (slice 3) — gated + inert-until-configured. */}
          <AiInsightsPanel runId={run.id} />
          {/* Location comparison: why this FAILING run differs from the last-known-good baseline. */}
          {(run.status === "fail" || run.status === "error") && <BaselineDiffPanel runId={run.id} />}
        </div>
      )}
    </div>
  );
}

function RunRow({
  run,
  expanded,
  onToggle,
}: {
  run: Run;
  expanded: boolean;
  onToggle: () => void;
}) {
  const failed = run.status === "fail" || run.status === "error";
  return (
    <>
      <button
        onClick={onToggle}
        id={`run-${run.id}`}
        data-testid="run-row"
        className="grid w-full scroll-mt-20 grid-cols-[16px_1fr_auto_auto] items-center gap-3 px-4 py-2.5 text-left transition hover:bg-[var(--color-panel-2)]"
      >
        <StatusDot status={run.status} />
        <div className="min-w-0">
          <span className="text-sm text-[var(--color-ink)]">{formatLocalDateTime(run.started_at)}</span>
          {run.http_status !== null && (
            <span className="sw-mono ml-2 text-[11px] text-[var(--color-ink-faint)]">
              HTTP {run.http_status}
            </span>
          )}
          {run.failed_step && (
            <span className="sw-mono ml-2 text-[11px]" style={{ color: "var(--color-fail)" }}>
              ✕ {run.failed_step}
            </span>
          )}
        </div>
        <span className="sw-mono text-sm text-[var(--color-ink-dim)]">{formatDuration(run.duration_ms)}</span>
        <span
          className="text-xs text-[var(--color-ink-faint)] transition"
          style={{ transform: expanded ? "rotate(90deg)" : "none" }}
        >
          ▸
        </span>
      </button>
      {expanded && (
        <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-4">
          <div className="mb-3 sw-eyebrow">Funnel · run #{run.id}</div>
          <FunnelBar runId={run.id} />
          {run.error_message && (
            // Toned by run status: ssl records its cert message on PASS runs too
            // ("cert valid, expires … (Nd)"), so a green run must not look red.
            <p
              className="sw-mono mt-3 rounded border-l-2 px-3 py-2 text-[12px]"
              style={{
                borderColor: TONE_VAR[runStatusMeta(run.status).token],
                background: `color-mix(in srgb, ${TONE_VAR[runStatusMeta(run.status).token]} 8%, transparent)`,
                color: TONE_VAR[runStatusMeta(run.status).token],
              }}
            >
              {run.error_message}
            </p>
          )}
          {failed && <RunArtifacts run={run} />}
          {!run.error_message && !failed && (
            <p className="mt-3 text-xs text-[var(--color-ink-faint)]">Run completed without errors.</p>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Cursor-paginated run history with a date-range control (default last 7d) and a Load-more
 * button. The default window keeps the very first request BOUNDED — it never asks the API
 * for all-time history. Shares the cursor engine + date-range control with the incidents list.
 */
export function RunHistory({ checkId, live = false }: { checkId: number; live?: boolean }) {
  const dateRange = useDateRange("7d");
  // ★ `live` (a run is in-flight/expected on the parent page) puts the list + trace on the fast
  // poll-while-running cadence — the same lifecycle the status badge uses — so a freshly-completed run row
  // and its now-populated trace appear without a manual refresh.
  const { runs, error, isLoading, isLoadingMore, hasMore, loadMore, reset } = useRunHistory(
    checkId,
    dateRange.range,
    undefined,
    { live },
  );

  const [expanded, setExpanded] = useState<number | null>(null);
  // Default-expand the most recent run so failures are visible immediately (parity with
  // the prior static run list). Keyed on the first run id so it re-arms when the range changes.
  const firstId = runs[0]?.id ?? null;
  useEffect(() => {
    if (firstId !== null) setExpanded((cur) => (cur === null ? firstId : cur));
  }, [firstId]);

  // Deep-link target: a `#run-<id>` hash (e.g. the per-location panel's "View run" → that location's latest
  // run) expands that run and scrolls to it — surfacing its trace + "Get AI insights". Re-applies once runs
  // load (the row must exist in the loaded window) and on hashchange (clicking another location). If the
  // target isn't in the loaded window (older than the range), it's a no-op — the row link still scrolls.
  useEffect(() => {
    function focusHashRun() {
      if (typeof window === "undefined") return;
      const m = window.location.hash.match(/^#run-(\d+)$/);
      if (!m) return;
      const id = Number(m[1]);
      if (!runs.some((r) => r.id === id)) return;
      setExpanded(id);
      requestAnimationFrame(() =>
        document.getElementById(`run-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }),
      );
    }
    focusHashRun();
    window.addEventListener("hashchange", focusHashRun);
    return () => window.removeEventListener("hashchange", focusHashRun);
  }, [runs.length]); // eslint-disable-line react-hooks/exhaustive-deps -- re-arm when the loaded set grows

  function onRangeChange() {
    setExpanded(null);
    reset(); // restart the cursor walk for the new window
  }

  return (
    <section data-testid="run-history">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-ink)]">
          Run history{" "}
          <span className="sw-mono text-xs text-[var(--color-ink-faint)]">({runs.length}{hasMore ? "+" : ""})</span>
          {/* ★ Visible "watching" affordance: while a run is in-flight/expected (live), the list is fast-
              polling — show it so the wait reads as ACTIVE, not stuck. Hidden when idle. */}
          {live && (
            <span
              className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-running)]"
              data-testid="run-history-live"
            >
              <span className="sw-dot sw-dot-running" aria-hidden /> updating…
            </span>
          )}
        </h2>
        <DateRangeControl
          state={dateRange}
          onModeChange={onRangeChange}
          ariaLabel="run history date range"
          testIdPrefix="run-history"
        />
      </div>

      {error ? (
        <ErrorState message={error instanceof Error ? error.message : "Failed to load run history."} />
      ) : isLoading && runs.length === 0 ? (
        <div className="sw-panel p-6">
          <Spinner label="Loading runs…" />
        </div>
      ) : runs.length === 0 ? (
        <EmptyState title="No runs recorded yet." hint="No runs in the selected window." />
      ) : (
        <>
          <div className="sw-panel divide-y divide-[var(--color-border)] overflow-hidden">
            {runs.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                expanded={expanded === run.id}
                onToggle={() => setExpanded((cur) => (cur === run.id ? null : run.id))}
              />
            ))}
          </div>
          {hasMore && (
            <div className="mt-3 flex justify-center">
              <button
                type="button"
                onClick={loadMore}
                disabled={isLoadingMore}
                className="sw-btn"
                data-testid="run-history-load-more"
              >
                {isLoadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
