"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

import { useCheck, useMetrics, updateCheck, revalidateChecks } from "@/lib/client";
import { LatencyChart, MetricsCharts } from "@/components/charts";
import { CheckSlaPanel } from "@/components/sla";
import { FunnelBar } from "@/components/funnel-bar";
import { StatusBadge, StatusDot } from "@/components/status-badge";
import { Modal } from "@/components/modal";
import { MonitorForm } from "@/components/monitor-form";
import { EmptyState, ErrorState, Spinner } from "@/components/states";
import { formatDuration, formatLocalDateTime, formatRelative } from "@/lib/format";
import type { Run } from "@/lib/types";

function ConfigChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">{label}</div>
      <div className="sw-mono mt-0.5 text-sm text-[var(--color-ink)]">{value}</div>
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
            <p
              className="sw-mono mt-3 rounded border-l-2 px-3 py-2 text-[12px]"
              style={{
                borderColor: "var(--color-fail)",
                background: "color-mix(in srgb, var(--color-fail) 8%, transparent)",
                color: "var(--color-fail)",
              }}
            >
              {run.error_message}
            </p>
          )}
          {failed && run.screenshot_url && (
            <div className="mt-3">
              <div className="mb-2 sw-eyebrow">Screenshot</div>
              {/* Runner-written screenshot. Plain <img> so any blob host works. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <a href={run.screenshot_url} target="_blank" rel="noreferrer">
                <img
                  src={run.screenshot_url}
                  alt={`Failure screenshot for run ${run.id}`}
                  className="max-h-80 rounded-lg border border-[var(--color-border)]"
                />
              </a>
            </div>
          )}
          {!run.error_message && !failed && (
            <p className="mt-3 text-xs text-[var(--color-ink-faint)]">Run completed without errors.</p>
          )}
        </div>
      )}
    </>
  );
}

export default function CheckDetailPage() {
  const routeParams = useParams<{ id: string }>();
  const id = Number(routeParams?.id);
  const valid = Number.isInteger(id) && id > 0;

  const { data, error, isLoading } = useCheck(valid ? id : null);
  const { data: metrics } = useMetrics(valid ? id : null);
  const [expandedRun, setExpandedRun] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [pausing, setPausing] = useState(false);

  // Default-expand the most recent run so failures are visible immediately.
  useEffect(() => {
    if (data?.recent_runs[0] && expandedRun === null) {
      setExpandedRun(data.recent_runs[0].id);
    }
  }, [data, expandedRun]);

  if (!valid) return <ErrorState message="Invalid check id." />;
  if (isLoading && !data) return <div className="py-16"><Spinner label="Loading monitor…" /></div>;
  if (error)
    return <ErrorState message={error instanceof Error ? error.message : "Failed to load monitor."} />;
  if (!data) return <EmptyState title="Monitor not found." />;

  const { check, recent_runs } = data;

  async function togglePause() {
    setPausing(true);
    try {
      await updateCheck(check.id, { enabled: !check.enabled });
      await revalidateChecks(check.id);
    } finally {
      setPausing(false);
    }
  }

  return (
    <div className="space-y-6">
      <Link href="/" className="sw-mono text-xs text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]">
        ← Status grid
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{check.name}</h1>
            <span className="flex items-center gap-1.5">
              <span className="text-[9px] uppercase tracking-wider text-[var(--color-ink-faint)]">latest run</span>
              <StatusBadge status={recent_runs[0]?.status ?? null} />
            </span>
            {!check.enabled && (
              <span className="sw-mono text-[11px] uppercase tracking-wider text-[var(--color-ink-faint)]">
                paused
              </span>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-[var(--color-ink-dim)]">
            <span className="sw-mono uppercase">{check.kind}</span>
            {check.kind === "http" && (
              <span className="sw-mono">· {check.method} → {check.expected_status}</span>
            )}
            {check.flow_name && <span className="sw-mono">· {check.flow_name}</span>}
            {check.target_url && (
              <a
                href={check.target_url}
                target="_blank"
                rel="noreferrer"
                className="sw-mono truncate text-[var(--color-brand)] hover:underline"
              >
                {check.target_url}
              </a>
            )}
            <span>· last run {formatRelative(recent_runs[0]?.started_at)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={togglePause} disabled={pausing} className="sw-btn">
            {pausing ? "…" : check.enabled ? "Pause" : "Resume"}
          </button>
          <button onClick={() => setEditing(true)} className="sw-btn sw-btn-primary">
            Edit
          </button>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <ConfigChip label="Interval" value={`${check.interval_seconds}s`} />
        <ConfigChip label="Timeout" value={`${check.timeout_ms}ms`} />
        <ConfigChip label="Fail thresh" value={String(check.failure_threshold)} />
        <ConfigChip label="Severity" value={check.severity} />
        {check.kind === "http" ? (
          <ConfigChip label="Assertion" value={`${check.method} ${check.expected_status}`} />
        ) : (
          <ConfigChip
            label="Lighthouse"
            value={check.lighthouse_enabled ? check.lighthouse_form_factor : "off"}
          />
        )}
        <ConfigChip
          label="Perf budget"
          value={check.perf_budget_lcp_ms ? `LCP ${check.perf_budget_lcp_ms}ms` : "—"}
        />
        {check.kind === "http" && (
          <ConfigChip
            label="Lighthouse"
            value={check.lighthouse_enabled ? check.lighthouse_form_factor : "off"}
          />
        )}
        {check.body_must_contain && (
          <ConfigChip label="Body has" value={check.body_must_contain} />
        )}
      </div>

      <CheckSlaPanel checkId={check.id} />

      <LatencyChart runs={recent_runs} />

      <section>
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-ink)]">Telemetry</h2>
        {metrics ? (
          <MetricsCharts data={metrics} />
        ) : (
          <div className="sw-panel p-6">
            <Spinner label="Loading telemetry…" />
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-ink)]">
          Run history <span className="sw-mono text-xs text-[var(--color-ink-faint)]">({recent_runs.length})</span>
        </h2>
        {recent_runs.length === 0 ? (
          <EmptyState title="No runs recorded yet." hint="The runner hasn't executed this check." />
        ) : (
          <div className="sw-panel divide-y divide-[var(--color-border)] overflow-hidden">
            {recent_runs.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                expanded={expandedRun === run.id}
                onToggle={() => setExpandedRun((cur) => (cur === run.id ? null : run.id))}
              />
            ))}
          </div>
        )}
      </section>

      <Modal open={editing} onClose={() => setEditing(false)} title={`Edit · ${check.name}`}>
        <MonitorForm initial={check} onDone={() => setEditing(false)} onCancel={() => setEditing(false)} />
      </Modal>
    </div>
  );
}
