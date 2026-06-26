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
  const [traceOpen, setTraceOpen] = useState(false);
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
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setTraceOpen((o) => !o)}
              aria-expanded={traceOpen}
              className="sw-btn sw-btn-sm sw-btn-primary"
              data-testid={`view-trace-${run.id}`}
            >
              {traceOpen ? "▾ Hide trace" : "▸ View trace"}
            </button>
            <a href={traceProxy} download className="sw-btn sw-btn-sm">
              ↓ Download (.zip)
            </a>
          </div>
          {traceOpen && (
            // Self-hosted viewer (public/trace-viewer) fed the SAME-ORIGIN proxy URL —
            // the viewer's fetch() stays on the dashboard origin (no CORS). Absolute URL
            // required: the viewer resolves ?trace= relative to /trace-viewer/, not the page.
            <div className="mt-2 overflow-hidden rounded-lg border border-[var(--color-border)]">
              <iframe
                title={`Playwright trace for run ${run.id}`}
                src={`/trace-viewer/index.html?trace=${encodeURIComponent(
                  (typeof window !== "undefined" ? window.location.origin : "") + traceProxy,
                )}`}
                // The vendored viewer's OWN CSS sets `html,body{min-width:550px;min-height:450px;overflow:auto}`,
                // so when the iframe is smaller than that floor IT (not us) renders scrollbars. h-[70vh] alone
                // dips below 450px on common laptop heights (70% of ~640px ≈ 448px), tripping their vertical
                // scrollbar — and the ~15px it steals can cascade the width below 550px → a second one. The
                // min-h floor (their 450px + headroom) keeps the embed above the floor so it fills cleanly.
                // (Below ~550px viewport WIDTH their horizontal scrollbar is intrinsic — not fixable here.)
                className="block h-[70vh] min-h-[480px] w-full bg-white"
                data-testid={`trace-viewer-${run.id}`}
              />
            </div>
          )}
          <p className="mt-1.5 text-[11px] text-[var(--color-ink-faint)]">
            Per-action screenshots, console, network waterfall &amp; DOM time-travel — from the trace
            captured on failure.
          </p>
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
        data-testid="run-row"
        className="grid w-full grid-cols-[16px_1fr_auto_auto] items-center gap-3 px-4 py-2.5 text-left transition hover:bg-[var(--color-panel-2)]"
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
export function RunHistory({ checkId }: { checkId: number }) {
  const dateRange = useDateRange("7d");
  const { runs, error, isLoading, isLoadingMore, hasMore, loadMore, reset } = useRunHistory(
    checkId,
    dateRange.range,
  );

  const [expanded, setExpanded] = useState<number | null>(null);
  // Default-expand the most recent run so failures are visible immediately (parity with
  // the prior static run list). Keyed on the first run id so it re-arms when the range changes.
  const firstId = runs[0]?.id ?? null;
  useEffect(() => {
    if (firstId !== null) setExpanded((cur) => (cur === null ? firstId : cur));
  }, [firstId]);

  function onRangeChange() {
    setExpanded(null);
    reset(); // restart the cursor walk for the new window
  }

  return (
    <section data-testid="run-history">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">
          Run history{" "}
          <span className="sw-mono text-xs text-[var(--color-ink-faint)]">({runs.length}{hasMore ? "+" : ""})</span>
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
