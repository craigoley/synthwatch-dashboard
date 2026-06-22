"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

import { useCheck, useMetrics, updateCheck, revalidateChecks } from "@/lib/client";
import { apiUrl } from "@/lib/api-client";
import { LatencyChart, MetricsCharts } from "@/components/charts";
import { CheckSlaPanel } from "@/components/sla";
import { FunnelBar } from "@/components/funnel-bar";
import { StatusBadge, StatusDot, TONE_VAR } from "@/components/status-badge";
import { Modal } from "@/components/modal";
import { MonitorForm } from "@/components/monitor-form";
import { EmptyState, ErrorState, Spinner } from "@/components/states";
import { runStatusMeta } from "@/lib/status";
import { formatCertExpiry, formatDuration, formatLocalDateTime, formatRelative } from "@/lib/format";
import type { ChainStep, Check, Run } from "@/lib/types";

function ConfigChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">{label}</div>
      <div className="sw-mono mt-0.5 text-sm text-[var(--color-ink)]">{value}</div>
    </div>
  );
}

/** SSL-only: the cert's days-remaining from the latest run's structured field. */
function CertPanel({ check, latest }: { check: Check; latest: Run | null }) {
  const expiry = formatCertExpiry(latest?.cert_days_remaining);
  const tone = TONE_VAR[runStatusMeta(latest?.status ?? null).token];
  return (
    <div className="sw-panel p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--color-ink)]">TLS certificate</h3>
        <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
          warn ≤ {check.cert_expiry_warn_days != null ? `${check.cert_expiry_warn_days}d` : "—"}
        </span>
      </div>
      {expiry ? (
        <div className="sw-mono text-2xl font-medium" style={{ color: tone }}>
          {expiry}
        </div>
      ) : (
        <div className="text-sm text-[var(--color-ink-dim)]">
          {latest ? "No certificate reading on the latest run." : "No runs yet."}
        </div>
      )}
      {latest?.error_message && (
        <p className="mt-2 text-xs text-[var(--color-ink-faint)]">{latest.error_message}</p>
      )}
    </div>
  );
}

/** Network checks (dns/tcp/ping): the latest run's result, colored by status. */
function NetPanel({ check, latest }: { check: Check; latest: Run | null }) {
  const tone = TONE_VAR[runStatusMeta(latest?.status ?? null).token];
  const title = check.kind === "dns" ? "DNS resolution" : check.kind === "tcp" ? "TCP connection" : "Reachability";
  return (
    <div className="sw-panel p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--color-ink)]">{title}</h3>
        <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
          latest result
        </span>
      </div>
      {latest?.error_message ? (
        <p className="sw-mono text-sm" style={{ color: tone }}>
          {latest.error_message}
        </p>
      ) : (
        <p className="text-sm text-[var(--color-ink-dim)]">
          {latest ? "Run completed (no detail recorded)." : "No runs yet."}
        </p>
      )}
      {latest?.duration_ms != null && (
        <p className="mt-2 text-xs text-[var(--color-ink-faint)]">latency {formatDuration(latest.duration_ms)}</p>
      )}
    </div>
  );
}

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
  const trace = run.trace_url ? apiUrl(run.trace_url) : null;
  if (!screenshot && !trace) return null;
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
      {trace && (
        <div>
          <div className="mb-1 sw-eyebrow">Playwright trace</div>
          <a href={trace} download className="sw-btn sw-btn-sm">
            ↓ Download trace (.zip)
          </a>
          <p className="mt-1.5 text-[11px] text-[var(--color-ink-faint)]">
            Open with: <span className="sw-mono">npx playwright show-trace &lt;file&gt;</span>
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Multistep checks: the configured step chain (the static "what the workflow
 * does" view — request line + auth/assertion/extract summary per step). Runtime
 * per-step results live in each run's funnel (run_steps) below; here we also flag
 * the step the latest run failed at, so the chain shows where it broke.
 */
function StepChainPanel({ steps, latest }: { steps: ChainStep[]; latest: Run | null }) {
  const failedAt =
    latest && (latest.status === "fail" || latest.status === "error") ? latest.failed_step : null;
  return (
    <div className="sw-panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--color-ink)]">Step chain</h3>
        <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
          {steps.length} {steps.length === 1 ? "step" : "steps"} · runs in order
        </span>
      </div>
      {steps.length === 0 ? (
        <p className="text-sm text-[var(--color-ink-dim)]">No steps configured.</p>
      ) : (
        <ol className="space-y-2">
          {steps.map((s, i) => {
            const name = s.name?.trim() || `step ${i + 1}`;
            const failed = failedAt != null && name === failedAt;
            const facets: string[] = [];
            if (s.auth && s.auth.type !== "none") facets.push(`auth: ${s.auth.type}`);
            if (s.assertions?.length) facets.push(`${s.assertions.length} assertion${s.assertions.length === 1 ? "" : "s"}`);
            if (s.extract?.length) facets.push(`→ ${s.extract.map((e) => `{{${e.var}}}`).join(", ")}`);
            return (
              <li
                key={i}
                className="rounded-lg border bg-[var(--color-bg)] px-3 py-2"
                style={{ borderColor: failed ? "var(--color-fail)" : "var(--color-border)" }}
              >
                <div className="flex items-center gap-2">
                  <span className="sw-mono text-[11px] text-[var(--color-ink-faint)]">{i + 1}</span>
                  <span className="sw-mono text-[11px] text-[var(--color-ink-dim)]">{s.method ?? "GET"}</span>
                  <span className="truncate text-sm text-[var(--color-ink)]">{name}</span>
                  {failed && (
                    <span className="sw-mono text-[10px]" style={{ color: "var(--color-fail)" }}>
                      ✕ failed here
                    </span>
                  )}
                </div>
                <div className="mt-0.5 sw-mono truncate text-[11px] text-[var(--color-ink-dim)]">{s.url}</div>
                {facets.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-[var(--color-ink-faint)]">
                    {facets.map((f, k) => (
                      <span key={k} className="sw-mono">
                        {f}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/**
 * Multi-location checks: the latest status per location, so a partial/regional
 * failure (e.g. eastus2 ✓, westus2 ✗) is visible at a glance next to the
 * aggregated verdict. Single-location checks (only "default") render nothing —
 * no clutter, no regression for the common case.
 */
function PerLocationPanel({ runs }: { runs: Run[] }) {
  // Latest run per location.
  const byLoc = new Map<string, Run>();
  for (const r of runs) {
    const loc = r.location ?? "default";
    const cur = byLoc.get(loc);
    if (!cur || new Date(r.started_at) > new Date(cur.started_at)) byLoc.set(loc, r);
  }
  if (byLoc.size <= 1) return null; // single-location → no panel

  const entries = [...byLoc.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const isDown = (r: Run) => r.status === "fail" || r.status === "error";
  const down = entries.filter(([, r]) => isDown(r)).length;
  // ★ Regional (some locations down) is visually distinct from a global outage.
  const verdict =
    down === 0
      ? { label: "Healthy in all locations", token: "pass" as const }
      : down === entries.length
        ? { label: "Global outage — all locations failing", token: "fail" as const }
        : { label: `Regional — ${down}/${entries.length} locations failing`, token: "warn" as const };

  return (
    <div className="sw-panel p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-[var(--color-ink)]">By location</h3>
        <span className="sw-mono text-[11px] font-medium" style={{ color: TONE_VAR[verdict.token] }}>
          {verdict.label}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {entries.map(([loc, r]) => (
          <div
            key={loc}
            className="flex items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2"
          >
            <span className="sw-mono truncate text-[12px] text-[var(--color-ink-dim)]">{loc}</span>
            <StatusBadge status={r.status} />
          </div>
        ))}
      </div>
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
            {check.kind === "dns" && (
              <span className="sw-mono">· {check.net_config?.recordType ?? "A"}</span>
            )}
            {(check.kind === "tcp" || check.kind === "ping") && check.net_config?.port != null && (
              <span className="sw-mono">· :{check.net_config.port}</span>
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
        {check.kind === "http" && (
          <ConfigChip label="Assertion" value={`${check.method} ${check.expected_status}`} />
        )}
        {check.kind === "http" && check.body_must_contain && (
          <ConfigChip label="Body has" value={check.body_must_contain} />
        )}
        {check.kind === "browser" && (
          <ConfigChip
            label="Lighthouse"
            value={check.lighthouse_enabled ? check.lighthouse_form_factor : "off"}
          />
        )}
        {check.kind === "browser" && (
          <ConfigChip
            label="Perf budget"
            value={check.perf_budget_lcp_ms ? `LCP ${check.perf_budget_lcp_ms}ms` : "—"}
          />
        )}
        {check.kind === "ssl" && (
          <ConfigChip
            label="Cert warn"
            value={check.cert_expiry_warn_days != null ? `${check.cert_expiry_warn_days}d` : "—"}
          />
        )}
        {check.kind === "dns" && (
          <ConfigChip label="Record" value={check.net_config?.recordType ?? "A"} />
        )}
        {check.kind === "dns" && check.net_config?.expectedValue && (
          <ConfigChip label="Expect" value={check.net_config.expectedValue} />
        )}
        {(check.kind === "tcp" || check.kind === "ping") && (
          <ConfigChip
            label="Port"
            value={
              check.net_config?.port != null
                ? String(check.net_config.port)
                : check.kind === "ping"
                  ? "443"
                  : "—"
            }
          />
        )}
        {check.kind === "multistep" && (
          <ConfigChip label="Steps" value={String(check.steps?.length ?? 0)} />
        )}
      </div>

      {check.kind === "ssl" && <CertPanel check={check} latest={recent_runs[0] ?? null} />}
      {(check.kind === "dns" || check.kind === "tcp" || check.kind === "ping") && (
        <NetPanel check={check} latest={recent_runs[0] ?? null} />
      )}
      {check.kind === "multistep" && (
        <StepChainPanel steps={check.steps ?? []} latest={recent_runs[0] ?? null} />
      )}

      <PerLocationPanel runs={recent_runs} />

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
