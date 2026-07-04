"use client";

import { useEffect, useState } from "react";

import { useRunHistory } from "@/lib/client";
import { FunnelBar } from "@/components/funnel-bar";
import { StatusDot, TONE_VAR } from "@/components/status-badge";
import { DateRangeControl, useDateRange } from "@/components/date-range-control";
import { EmptyState, ErrorState, Spinner } from "@/components/states";
import { runStatusMeta } from "@/lib/status";
import { formatDuration, formatLocalDateTime } from "@/lib/format";
import { runsDebug } from "@/lib/debug";
import { TraceViewer } from "@/components/trace-viewer";
import { AiInsightsPanel } from "@/components/ai-insights";
import { BaselineDiffPanel } from "@/components/baseline-diff";
import type { Run, RunOutcome } from "@/lib/types";

/**
 * Failure artifacts for a failed browser run: inline screenshot + trace download.
 * Both are served SAME-ORIGIN through the dashboard's own proxies — never raw
 * apiUrl() — because the API gates artifacts behind a bearer (synthwatch-api #154)
 * and a bare <img src>/<a href> to the cross-origin API carries neither the bearer
 * header nor the proxy cookie (→ 401 even for logged-in users). Both may be null
 * (passing/non-browser runs → section hidden) or 404 (blob deleted after 90d
 * retention while the DB url persists) — the <img> onError shows a neutral
 * "unavailable" instead of a broken-image icon.
 */
function RunArtifacts({ run }: { run: Run }) {
  const [imgFailed, setImgFailed] = useState(false);
  // ★ SAME-ORIGIN screenshot proxy (app/screenshot-proxy/[runId]) — cookie→bearer, the trace proxy's sibling.
  const screenshot = run.screenshot_url ? `/screenshot-proxy/${run.id}` : null;
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
              {/* eslint-disable-next-line @next/next/no-img-element -- failure-artifact screenshots come from
                  arbitrary runner/blob hosts; next/image optimization doesn't apply (would need a custom loader). */}
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
  // retry_count telemetry (runner 0048): only meaningful when >1 (a clean first-try pass shows nothing, and
  // null = pre-telemetry → nothing). A PASS that needed multiple attempts is "degrading-but-green" — the
  // valuable, otherwise-invisible signal — so it gets a soft amber warning. A fail's retries are secondary
  // (the red status already says "down"), so it renders faint/neutral.
  const retried = run.retry_count != null && run.retry_count > 1;
  const degrading = retried && !failed;
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
          {retried && (
            <span
              data-testid="retry-badge"
              title={
                degrading
                  ? `Degrading: passed only after ${run.retry_count} attempts`
                  : `Took ${run.retry_count} attempts`
              }
              className="sw-mono ml-2 inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px]"
              style={
                degrading
                  ? {
                      color: "var(--color-warn)",
                      background: "color-mix(in srgb, var(--color-warn) 12%, transparent)",
                    }
                  : { color: "var(--color-ink-faint)" }
              }
            >
              ↻ {run.retry_count} attempts
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
const OUTCOMES: { value: RunOutcome; label: string }[] = [
  { value: "all", label: "All" },
  { value: "passed", label: "Passed" },
  { value: "failed", label: "Failed" },
  { value: "errored", label: "Errored" }, // infra_error = "didn't run", distinct from a failure
];

export function RunHistory({ checkId, live = false }: { checkId: number; live?: boolean }) {
  const dateRange = useDateRange("7d");
  const [outcome, setOutcome] = useState<RunOutcome>("all");
  // ★ Frozen-`to` fix (the real run-history "not updating" root cause): a preset window's `to` is Date.now()
  //   captured ONCE at mount (useDateRange's memo deps exclude time), so the live list kept requesting
  //   [mount-7d, mount) on EVERY poll and the API correctly EXCLUDED every run with started_at >= mount — a
  //   freshly-completed run never appeared until a reload remounted the window. For a live preset, OMIT `to`
  //   so the server windows to its OWN now() each poll (no client-clock dependency). A CUSTOM range is a
  //   deliberately historical window — keep its frozen `to`. `from` stays (the lookback start can be fixed).
  const effectiveRange =
    dateRange.mode === "custom" ? dateRange.range : { from: dateRange.range.from };
  // ★ `live` (a run is in-flight/expected on the parent page) puts the list + trace on the fast
  // poll-while-running cadence — the same lifecycle the status badge uses — so a freshly-completed run row
  // and its now-populated trace appear without a manual refresh.
  const { runs, error, isLoading, isLoadingMore, hasMore, loadMore, reset } = useRunHistory(
    checkId,
    effectiveRange,
    undefined,
    { live, outcome }, // server-side ?outcome= (api #153); outcome is in the hook's cursor key → resets the walk
  );

  const [expanded, setExpanded] = useState<number | null>(null);
  // Default-expand the most recent run so failures are visible immediately (parity with the prior static
  // run list). Keyed on the first run id so it re-arms when the range changes.
  // ★ While LIVE (a run is in-flight/just-finished on this check — i.e. after "Run now"), FOLLOW the newest
  //   run: when a fresh run lands on page 0 via the poll, auto-expand it so its result + trace surface the
  //   same way a hard reload would. Without this the previously-expanded row stayed open and the new run
  //   arrived COLLAPSED at the top — it looked like "nothing happened until I refreshed". When NOT live, keep
  //   the old rule (expand only if nothing is open) so a background poll never yanks a row the user is reading.
  const firstId = runs[0]?.id ?? null;
  const firstStatus = runs[0]?.status ?? null;
  const rowCount = runs.length;
  useEffect(() => {
    // ★ Funnel stage (e): the #126 auto-expand. Logs whether the effect ran and on which firstId/live — the
    //   render log below shows the resulting expandedId, so a "row present but collapsed" failure is visible.
    if (firstId !== null) runsDebug(`auto-expand effect → ran (firstId=${firstId}, live=${live})`, { firstId, live });
    if (firstId !== null) setExpanded((cur) => (live || cur === null ? firstId : cur));
  }, [firstId, live]);

  // ★ Funnel stage (c)+(d): the MERGED list that actually reached the component, and what renders. If the
  //   page-0 fetch log showed the fresh run (stage b) but topRowId here is stale, SWR dropped it on merge.
  useEffect(() => {
    runsDebug(`post-merge → render: ${rowCount} rows, top id=${firstId}`, {
      totalRows: rowCount,
      topRowId: firstId,
      topRowStatus: firstStatus,
      expandedId: expanded,
      hasMore,
      live,
    });
  }, [rowCount, firstId, firstStatus, expanded, hasMore, live]);

  // ★ The "updating…" indicator on/off transitions — ties the user's "flashes twice" to which live windows
  //   actually opened (each ON should coincide with fast poll-ticks in the engine logs above).
  useEffect(() => {
    runsDebug(`updating-indicator ${live ? "ON" : "OFF"}`, { live });
  }, [live]);

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

      {/* Server-side outcome filter (api #153). Selecting a value re-fetches page 0 of the FILTERED set (the
          outcome is in the hook's cursor key), so "Load more" pages the filter — no client-side false counts. */}
      <div
        className="mb-3 inline-flex rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] p-0.5"
        role="group"
        aria-label="run outcome filter"
      >
        {OUTCOMES.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={o.value === outcome}
            data-testid={`run-outcome-${o.value}`}
            onClick={() => {
              setOutcome(o.value);
              setExpanded(null); // the new filter's page 0 has a different top run
            }}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
              o.value === outcome
                ? "bg-[var(--color-panel-2)] text-[var(--color-ink)]"
                : "text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
            }`}
          >
            {o.label}
          </button>
        ))}
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
