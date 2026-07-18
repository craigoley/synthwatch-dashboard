"use client";

import { useState } from "react";
import { getTraceSignals, ApiRequestError, type TraceSignalsSummary } from "@/lib/api-client";
import { useAuth } from "@/components/auth-provider";
import { Spinner } from "@/components/states";

/**
 * The compact, REDACTED trace summary for a run that has persisted trace_signals but NO downloadable trace
 * (`trace_url` null) — the sensitive-monitor green-run case (B10 stores no zip, but the runner-extracted
 * signals survive). So such a run surfaces its network/console rollup instead of reading as "no trace".
 * Editor/admin-gated (the trace-signals endpoint serves forensic data), click-to-load like the trace viewer.
 */
type View = "idle" | "loading" | "empty" | "error" | { data: TraceSignalsSummary };

export function TraceSummary({ runId }: { runId: number }) {
  const { canWrite, promptLogin } = useAuth();
  const [view, setView] = useState<View>("idle");

  async function load() {
    setView("loading");
    try {
      const s = await getTraceSignals(runId);
      setView(s ? { data: s } : "empty");
    } catch (e) {
      // 401/403 are handled by the global request() interceptor (re-login / permission toast) — just reset.
      if (e instanceof ApiRequestError && (e.status === 401 || e.status === 403)) setView("idle");
      else setView("error");
    }
  }

  if (!canWrite) {
    return (
      <div className="mt-3">
        <button type="button" onClick={promptLogin} className="sw-btn sw-btn-sm" data-testid={`trace-summary-signin-${runId}`}>
          ▸ Trace summary
        </button>
        <p className="mt-1 text-[11px] text-[var(--color-ink-faint)]">Sign in (editor access) to view the redacted trace summary.</p>
      </div>
    );
  }

  return (
    <div className="mt-3" data-testid={`trace-summary-${runId}`}>
      {view === "idle" && (
        <>
          <button type="button" onClick={load} className="sw-btn sw-btn-sm" data-testid={`load-trace-summary-${runId}`}>
            ▸ Trace summary
          </button>
          <p className="mt-1 text-[11px] text-[var(--color-ink-faint)]">
            Redacted network &amp; console summary — this sensitive monitor stores no downloadable trace, but the
            captured signals survive.
          </p>
        </>
      )}

      {view === "loading" && (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-4" data-testid="trace-summary-loading">
          <Spinner label="Loading trace summary…" />
        </div>
      )}

      {view === "empty" && (
        <p className="text-xs text-[var(--color-ink-faint)]" data-testid="trace-summary-empty">
          No trace summary available for this run.
        </p>
      )}

      {view === "error" && (
        <p className="text-xs text-[var(--color-ink-faint)]" data-testid="trace-summary-error">
          Couldn’t load the trace summary — this is usually transient.{" "}
          <button type="button" onClick={load} className="underline">Retry</button>
        </p>
      )}

      {typeof view === "object" && <SummaryBody s={view.data} />}
    </div>
  );
}

export function SummaryBody({ s }: { s: TraceSignalsSummary }) {
  const errors = s.console.messages.filter((m) => m.level === "error" || m.level === "pageerror");
  const warns = s.console.messages.filter((m) => m.level === "warning");
  const clean = s.network.failed.length === 0 && errors.length === 0 && warns.length === 0;
  return (
    <div className="sw-panel space-y-3 p-3" data-testid="trace-summary-body">
      <div className="flex items-center justify-between gap-2">
        <span className="sw-eyebrow">Redacted trace summary</span>
        {s.targetHost && <span className="sw-mono truncate text-[11px] text-[var(--color-ink-faint)]">{s.targetHost}</span>}
      </div>
      <div className="sw-mono text-[12px] text-[var(--color-ink-dim)]">
        {s.network.totalRequests} requests · {s.network.wireKb} KB on the wire · {s.network.thirdPartyCount} third-party
      </div>

      {s.network.failed.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] text-[var(--color-ink-faint)]">Failed / aborted requests</div>
          <ul className="space-y-0.5">
            {s.network.failed.slice(0, 6).map((f, i) => (
              <li key={i} className="sw-mono truncate text-[11px]" style={{ color: "var(--color-fail)" }}>
                {f.status} · {f.url}
              </li>
            ))}
          </ul>
        </div>
      )}

      {s.network.topThirdParties.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] text-[var(--color-ink-faint)]">Top third parties</div>
          <ul className="space-y-0.5">
            {s.network.topThirdParties.slice(0, 5).map((t, i) => (
              <li key={i} className="sw-mono truncate text-[11px] text-[var(--color-ink-dim)]">
                {t.host} — {t.count}× · {t.kb} KB
              </li>
            ))}
          </ul>
        </div>
      )}

      {(errors.length > 0 || warns.length > 0) && (
        <div>
          <div className="mb-1 text-[11px] text-[var(--color-ink-faint)]">
            Console — {errors.length} error(s), {warns.length} warning(s)
            {s.console.droppedError > 0 && ` · +${s.console.droppedError} truncated`}
          </div>
          <ul className="space-y-0.5">
            {[...errors, ...warns].slice(0, 8).map((m, i) => (
              <li
                key={i}
                className="sw-mono truncate text-[11px]"
                style={{ color: m.level === "warning" ? "var(--color-warn)" : "var(--color-fail)" }}
                title={m.sourceHost ? `${m.origin} · ${m.sourceHost}` : m.origin}
              >
                [{m.origin === "third-party" ? "3p" : "site"}] {m.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      {clean && <p className="text-[11px] text-[var(--color-ink-faint)]">No failed requests or console errors — a clean run.</p>}
    </div>
  );
}
