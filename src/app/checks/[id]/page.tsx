"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

import { useCheck, useMetrics, updateCheck, revalidateChecks, runCheckNow, revalidateRunHistory } from "@/lib/client";
import { useAuth } from "@/components/auth-provider";
import { AvailabilityChart, LatencyChart, MetricsCharts } from "@/components/charts";
import { CheckSlaPanel, SloPanel } from "@/components/sla";
import { MonitorCostPanel } from "@/components/cost";
import { CredentialsPanel } from "@/components/credentials-panel";
import { TrustCard } from "@/components/trust";
import { RunHistory } from "@/components/run-history";
import { LiveStepsChecklist } from "@/components/live-steps";
import { TraceViewer } from "@/components/trace-viewer";
import { StatusBadge, TONE_VAR } from "@/components/status-badge";

// The host of a check's target_url → the deploy-marker overlay key (a deploy is per host). undefined when
// the url doesn't parse (network kinds / bad url) → the charts simply render no overlay.
function hostFromUrl(u: string | null | undefined): string | undefined {
  try {
    return u ? new URL(u).host : undefined;
  } catch {
    return undefined;
  }
}
import { TagChips } from "@/components/tag-chips";
import { RedactionBadge } from "@/components/redaction";
import { Modal } from "@/components/modal";
import { MonitorForm } from "@/components/monitor-form";
import { EmptyState, ErrorState, Spinner } from "@/components/states";
import { runStatusMeta } from "@/lib/status";
import { usePersistedBoolean } from "@/lib/use-persisted-boolean";
import { formatCertExpiry, formatDuration, formatRelative, secondsToMinutesLabel } from "@/lib/format";
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
  // warn = up-but-degraded; counted only when nothing is hard-down (failures take
  // precedence in the headline).
  const degraded = entries.filter(([, r]) => r.status === "warn").length;
  // ★ 3-state summary, consistent with the per-location badges: down (regional vs
  // global outage) → degraded (warn, NOT "healthy") → healthy.
  const verdict =
    down > 0
      ? down === entries.length
        ? { label: "Global outage — all locations failing", token: "fail" as const }
        : { label: `Regional — ${down}/${entries.length} locations failing`, token: "warn" as const }
      : degraded > 0
        ? {
            label: `Degraded — ${degraded}/${entries.length} location${degraded === 1 ? "" : "s"} degraded`,
            token: "warn" as const,
          }
        : { label: "Healthy in all locations", token: "pass" as const };

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
          // ★ Each row links to that location's LATEST run in the history list below (#run-<id>), which
          // expands to its trace + "Get AI insights". The failing location → its failing run (the thing you
          // want to troubleshoot). The run id is already on the per-location run object — no API change.
          <a
            key={loc}
            href={`#run-${r.id}`}
            data-testid={`location-run-${loc}`}
            title={`View ${loc}'s latest run`}
            aria-label={`View ${loc}'s latest run (${r.status})`}
            className="group flex items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-panel-2)]"
          >
            <span className="sw-mono truncate text-[12px] text-[var(--color-ink-dim)]">{loc}</span>
            <span className="flex shrink-0 items-center gap-1.5">
              <StatusBadge status={r.status} />
              <span aria-hidden className="text-[var(--color-ink-faint)] transition group-hover:text-[var(--color-ink)]">→</span>
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}

/**
 * Browser checks only: the monitor's last-known-good (most-recent-success) Playwright trace — the
 * COMPLETE run, a baseline to diff failures against. Shown only when a baseline exists
 * (success_trace_at set). Reuses the shared TraceViewer embed, pointed at the per-check success
 * trace proxy (→ API GET /checks/{id}/success-trace, overwritten on each success).
 */
function SuccessTracePanel({ check }: { check: Check }) {
  if (check.kind !== "browser" || !check.success_trace_at) return null;
  return (
    <div className="sw-panel p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-[var(--color-ink)]">Last known good</h3>
        <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
          success baseline · {formatRelative(check.success_trace_at)}
        </span>
      </div>
      <TraceViewer
        proxyPath={`/trace-proxy/check/${check.id}`}
        openLabel="▸ View last success trace"
        iframeTitle={`Last successful trace for ${check.name}`}
        viewTestId={`view-success-trace-${check.id}`}
        iframeTestId={`success-trace-viewer-${check.id}`}
      />
      <p className="mt-1.5 text-[11px] text-[var(--color-ink-faint)]">
        The most recent SUCCESSFUL run&apos;s full trace — a baseline to diff against failures.
      </p>
    </div>
  );
}

export default function CheckDetailPage() {
  const routeParams = useParams<{ id: string }>();
  const id = Number(routeParams?.id);
  const valid = Number.isInteger(id) && id > 0;

  const [editing, setEditing] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [running, setRunning] = useState(false);
  // ★ "expecting a run": true from clicking Run now until the run actually appears as 'running' — bridges
  // the trigger→start gap so the scoped fast poll is already active when the run begins.
  const [expectRun, setExpectRun] = useState(false);
  // App-wide (check-id-agnostic) collapse preference for the tall metrics section — set it on one monitor
  // page and every monitor page opens collapsed. Defaults to EXPANDED when unset. SSR-safe.
  const [metricsCollapsed, setMetricsCollapsed] = usePersistedBoolean("synthwatch:metrics-section-collapsed", false);
  const { canWrite } = useAuth(); // editor/admin — gates the "Run now" affordance (it spends compute)

  const { data, error, isLoading } = useCheck(valid ? id : null, { expectRun });
  const { data: metrics } = useMetrics(valid ? id : null);

  // The latest run's status drives the live indicator + when to stop the fast poll.
  const latestRunStatus = data?.recent_runs?.[0]?.status ?? null;

  // Once the run is visibly 'running', drop the bridge flag — useCheck's data-driven fast poll takes over
  // (and falls back to idle when the run finishes), so we never fast-poll past the run.
  useEffect(() => {
    if (latestRunStatus === "running") setExpectRun(false);
  }, [latestRunStatus]);

  // Safety: never fast-poll forever if a triggered run never appears (e.g. the trigger failed) — clear the
  // bridge after a bounded window.
  useEffect(() => {
    if (!expectRun) return;
    const t = setTimeout(() => setExpectRun(false), 90_000);
    return () => clearTimeout(t);
  }, [expectRun]);

  // Mirror the header's live status in the run-history list below: when the latest run's status flips
  // (idle→running→terminal), revalidate the history so the new/updated row shows without a manual reload.
  useEffect(() => {
    if (valid && latestRunStatus !== null) void revalidateRunHistory(id);
  }, [latestRunStatus, valid, id]);

  // ★ Post-terminal "settle" window: when a run goes running→terminal, keep the list + trace on the FAST
  // poll for a few beats so the completed row AND a trace_url that lands JUST AFTER the status flip are
  // picked up. Without this the lifecycle would stop ON the transition (one beat too early) and the trace
  // (uploaded around the terminal write) could lag until a manual refresh.
  const [settling, setSettling] = useState(false);
  const prevStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = latestRunStatus;
    if (prev === "running" && latestRunStatus !== null && latestRunStatus !== "running") {
      setSettling(true);
      const t = setTimeout(() => setSettling(false), 6000);
      return () => clearTimeout(t);
    }
  }, [latestRunStatus]);

  // The run-history list + per-run trace are "live" while a run is expected (Run now just clicked), actively
  // running, or just settled — the SAME poll-while-running lifecycle as the status badge.
  const runLive = expectRun || latestRunStatus === "running" || settling;

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

  async function refreshRuns() {
    await Promise.all([revalidateChecks(check.id), revalidateRunHistory(check.id)]);
  }

  // Trigger an on-demand run (the API enqueues it + kicks the runner; cron is the fallback). setExpectRun
  // turns on the SCOPED fast poll (useCheck), so the run is caught live as it goes running→done — no manual
  // refresh, no fragile fixed-timer nudges. The fast poll self-stops once the run settles.
  async function handleRunNow() {
    setRunning(true);
    setExpectRun(true);
    try {
      // A PAUSED monitor can only be run as a SANDBOX validation (a normal run on a disabled check 409s);
      // an enabled monitor runs normally. The live view below renders the result + trace either way.
      await runCheckNow(check.id, { sandbox: !check.enabled });
      await refreshRuns(); // immediate nudge; the scoped poll handles the run's lifecycle from here
    } catch {
      // 401/403 are handled globally by the api-client interceptor; the trigger didn't take → stop expecting.
      setExpectRun(false);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <Link href="/" className="sw-mono text-xs text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]">
        ← Status grid
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        {/* min-w-0: flex items default to min-width:auto, so any long unbreakable child (the target URL,
            a long name) would blow this out past the viewport instead of shrinking — the mobile
            horizontal-scroll bug. Letting it shrink is what makes the children's truncate engage.
            THIS wrapper's min-w-0 is the load-bearing constraint — the target-URL <a>'s own min-w-0 is
            redundant; e2e/detail.spec.ts:157-179 reds only if THIS one is removed, not the <a>'s. */}
        <div className="min-w-0">
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
            {/* B10: a sensitive-but-unredacted monitor is flagged loudly right in the header. */}
            <RedactionBadge health={check.redaction_health} />
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
              // min-w-0: as a flex item this defaults to min-width:auto, which pins its minimum to the
              // full nowrap URL width — truncate (already present) never engaged and a long URL forced
              // horizontal page scroll on mobile. min-w-0 lets it shrink → the ellipsis works; title
              // carries the full URL on hover.
              <a
                href={check.target_url}
                target="_blank"
                rel="noreferrer"
                title={check.target_url}
                className="sw-mono min-w-0 truncate text-[var(--color-brand)] hover:underline"
              >
                {check.target_url}
              </a>
            )}
            <span>· last run {formatRelative(recent_runs[0]?.started_at)}</span>
          </div>
          <TagChips tags={check.tags} className="mt-2" />
        </div>
        <div className="flex items-center gap-2">
          {/* Run now is available for a PAUSED monitor too — but as a SANDBOX validation: distinct label +
              blue (validation) accent + a tooltip stating it won't alert / count / resume. An ENABLED monitor
              is unchanged. */}
          {canWrite && (
            <button
              onClick={handleRunNow}
              disabled={running || expectRun || latestRunStatus === "running"}
              className="sw-btn"
              style={check.enabled ? undefined : { borderColor: "var(--color-running)", color: "var(--color-running)" }}
              title={
                check.enabled
                  ? "Run this monitor now — don't wait for the timer"
                  : "Sandbox validation: run this PAUSED monitor once to inspect the result + trace. It won't alert, won't count toward SLO, and won't resume the monitor."
              }
              data-testid="run-now"
              data-sandbox={check.enabled ? undefined : "true"}
            >
              {/* Pending (triggered) → Running/Validating (live) → settled label. */}
              {latestRunStatus === "running"
                ? check.enabled
                  ? "Running…"
                  : "Validating…"
                : running || expectRun
                  ? "Starting…"
                  : check.enabled
                    ? "Run now"
                    : "Sandbox validation"}
            </button>
          )}
          {/* Editor-only writes (mirror Run-now): a viewer sees read-only — these PATCH the check (and Edit's
              tag editor auto-saves), so the controls must not leak to viewers. The API is the real gate; this
              keeps the UX honest. */}
          {canWrite && (
            <>
              <button onClick={togglePause} disabled={pausing} className="sw-btn">
                {pausing ? "…" : check.enabled ? "Pause" : "Resume"}
              </button>
              <button onClick={() => setEditing(true)} className="sw-btn sw-btn-primary">
                Edit
              </button>
            </>
          )}
        </div>
      </header>

      {/* Live step-by-step checklist — shown only while a run is in flight (the run-history funnel takes
          over once it's terminal). Rides #108's fast poll; steps come from the runner's live run_steps. */}
      {latestRunStatus === "running" && (check.kind === "browser" || check.kind === "multistep") && (
        <LiveStepsChecklist run={recent_runs[0]!} templateRunId={recent_runs[1]?.id ?? null} />
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <ConfigChip label="Interval" value={`${secondsToMinutesLabel(check.interval_seconds)} min`} />
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

      {/* Model-B credential editor (Step C). Editor-only (canWrite); the API also nulls the masked slots for
          a non-write session, so a viewer never sees it. Write-only: values are set, never read back. */}
      <CredentialsPanel check={check} />

      <PerLocationPanel runs={recent_runs} />

      <CheckSlaPanel checkId={check.id} />

      {/* Estimated monthly compute cost — projected + inspectable breakdown + measured + divergence flag.
          Self-hides (null) until GET /reports/cost is reachable / the monitor has runs. */}
      <MonitorCostPanel checkId={check.id} />

      {/* §D1 Trust drill-down — chip + honest red-test gap, retry sparkline, incident breakdown, spec
          integrity hash. Self-hides (404 → null) until GET /reports/trust/{id} is reachable. */}
      <TrustCard checkId={check.id} />

      {/* ★ ONE "Metrics" disclosure over the WHOLE tall chart stack (availability + latency + web vitals),
          so collapsing actually shrinks the page (the old toggle only hid the small Telemetry block below
          the big charts). Reuses the app-wide persisted key from #120. The header matches the bold
          chart-card section headers (text-sm font-semibold ink) with a chevron that rotates on expand. */}
      <section data-testid="metrics-section">
        <h2 className="mb-3">
          <button
            type="button"
            onClick={() => setMetricsCollapsed(!metricsCollapsed)}
            aria-expanded={!metricsCollapsed}
            aria-controls="metrics-body"
            data-testid="metrics-toggle"
            className="group flex w-full items-center gap-2 text-left text-sm font-semibold text-[var(--color-ink)]"
          >
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              className="h-3.5 w-3.5 shrink-0 text-[var(--color-ink-dim)] transition-transform"
              style={{ transform: metricsCollapsed ? "none" : "rotate(90deg)" }}
            >
              <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Metrics
            <span className="ml-0.5 text-[10px] font-normal uppercase tracking-wider text-[var(--color-ink-faint)]">
              availability · latency · web vitals
            </span>
          </button>
        </h2>
        {!metricsCollapsed && (
          <div id="metrics-body" data-testid="metrics-body" className="space-y-6">
            {/* Availability SHAPE over time — complements the SLA panel's point-in-time %. */}
            <AvailabilityChart checkId={check.id} host={hostFromUrl(check.target_url)} />

            {/* SLO complements SLA: only when an SLO target is set (opt-in) */}
            {check.slo && <SloPanel slo={check.slo} />}

            <LatencyChart runs={recent_runs} host={hostFromUrl(check.target_url)} />

            <div data-testid="telemetry-block">
              <h3 className="mb-3 text-sm font-semibold text-[var(--color-ink)]">Telemetry</h3>
              {metrics ? (
                <MetricsCharts data={metrics} />
              ) : (
                <div className="sw-panel p-6">
                  <Spinner label="Loading telemetry…" />
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Browser checks: the last-known-good success trace (baseline to diff against failures).
          Hidden until the monitor has had a success (success_trace_at set). */}
      <SuccessTracePanel check={check} />

      {/* Cursor-paginated run history: date-range control (default last 7d) + Load more.
          The default window keeps the first fetch BOUNDED — never an all-time scan. */}
      {/* Honesty: while the monitor is PAUSED, on-demand runs are SANDBOX validations — a green result here
          is a validation pass, NOT a real prod pass (it never alerted, counted toward SLO, or resumed the
          monitor). Say so, so the run-history below isn't misread. */}
      {!check.enabled && (
        <p
          className="sw-mono text-[11px] text-[var(--color-running)]"
          data-testid="sandbox-runs-note"
        >
          Paused monitor — on-demand runs are sandbox validations (no alert · no SLO · no resume).
        </p>
      )}
      <RunHistory checkId={check.id} live={runLive} />

      <Modal open={editing} onClose={() => setEditing(false)} title={`Edit · ${check.name}`}>
        <MonitorForm initial={check} onDone={() => setEditing(false)} onCancel={() => setEditing(false)} />
      </Modal>
    </div>
  );
}
