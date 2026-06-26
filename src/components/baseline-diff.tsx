"use client";

import { useState } from "react";

import { getBaselineDiff, ApiRequestError } from "@/lib/api-client";
import { InsightCard } from "@/components/ai-insights";
import { useAuth } from "@/components/auth-provider";
import { Spinner } from "@/components/states";
import type { BaselineDiff, BaselineDiffCause, BaselineDiffInsight, BaselineDiffResult, DiffConsoleLine } from "@/lib/types";

/**
 * Location comparison (POST /api/runs/{id}/baseline-diff): on a FAILING run, "Why is this failing?" diffs the
 * run vs the monitor's last-known-good BASELINE and shows the delta + an AI categorized cause.
 * ★ HONEST framing: it compares vs the baseline, NOT directly vs the passing location (passing runs have no
 * trace). Reuses the ai-insights InsightCard + the same non-fatal state machine (not_configured / unavailable /
 * transport_error). The diff is shown for every non-transport state; the insight only when configured.
 */

const CAUSE_LABEL: Record<BaselineDiffCause, string> = {
  "regional-waf-cdn": "Regional WAF / CDN rule",
  "network-allowlist": "Network allow-list (region IP)",
  "geo-dns": "Geo-DNS / regional CDN",
  "region-timeout": "Region-specific timeout",
  "third-party-blocked": "Third-party blocked in one region",
  "flaky-transient": "Likely flaky / transient",
  "undetermined": "Couldn’t determine",
};

type View = "idle" | "loading" | BaselineDiffResult;

function ConsoleDelta({ label, lines }: { label: string; lines: DiffConsoleLine[] }) {
  if (lines.length === 0) return null;
  return (
    <div>
      <div className="sw-eyebrow mb-1">{label}</div>
      <ul className="space-y-1">
        {lines.map((l, k) => (
          <li key={k} className="sw-mono text-[11px] text-[var(--color-ink-dim)]">
            <span className="text-[var(--color-ink-faint)]">[{l.origin}]</span> {l.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DiffBody({ diff }: { diff: BaselineDiff }) {
  const n = diff.network;
  const nothing =
    diff.console.onlyInThisRun.length === 0 &&
    diff.console.onlyInBaseline.length === 0 &&
    n.failedHostsOnlyInThisRun.length === 0 &&
    n.thirdPartyOnlyInThisRun.length === 0;
  return (
    <div className="space-y-3" data-testid="baseline-diff-delta">
      <p className="text-[11px] text-[var(--color-ink-faint)]">
        Comparing this {diff.failing.location ?? "run"} failure against the monitor’s last-known-good baseline
        {diff.baseline.capturedAt ? ` (captured ${new Date(diff.baseline.capturedAt).toLocaleString()})` : ""}.
      </p>
      <ConsoleDelta label="Console errors only in this run" lines={diff.console.onlyInThisRun} />
      <ConsoleDelta label="Console errors only in the baseline" lines={diff.console.onlyInBaseline} />
      {n.failedHostsOnlyInThisRun.length > 0 && (
        <div>
          <div className="sw-eyebrow mb-1">Hosts that failed only in this run</div>
          <div className="sw-mono text-[11px] text-[var(--color-ink-dim)]">{n.failedHostsOnlyInThisRun.join(", ")}</div>
        </div>
      )}
      {n.thirdPartyOnlyInThisRun.length > 0 && (
        <div>
          <div className="sw-eyebrow mb-1">Third-party origins only in this run</div>
          <div className="sw-mono text-[11px] text-[var(--color-ink-dim)]">
            {n.thirdPartyOnlyInThisRun.map((t) => `${t.host} (${t.count})`).join(", ")}
          </div>
        </div>
      )}
      <p className="text-[11px] text-[var(--color-ink-faint)]">
        {n.totalRequestsThisRun} requests this run vs {n.totalRequestsBaseline} in the baseline · {diff.console.shared} shared
        console errors.
      </p>
      {nothing && (
        <p className="text-[12px] text-[var(--color-ink-dim)]">
          No structural difference vs the baseline — the failure may be transient (see the analysis).
        </p>
      )}
    </div>
  );
}

function InsightBody({ insight }: { insight: BaselineDiffInsight }) {
  return (
    <div className="space-y-3" data-testid="baseline-diff-insight">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="rounded-md px-2 py-0.5 text-[11px] font-semibold"
          style={{
            background: insight.isFlaky
              ? "color-mix(in srgb, var(--color-warn) 14%, transparent)"
              : "color-mix(in srgb, var(--color-fail) 12%, transparent)",
            color: "var(--color-ink)",
          }}
          data-testid="baseline-diff-cause"
        >
          {CAUSE_LABEL[insight.likelyCause]}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
          {insight.confidence} confidence
        </span>
        {insight.isFlaky && (
          <span className="text-[10px] uppercase tracking-wider text-[var(--color-warn)]" data-testid="baseline-diff-flaky">
            may be transient
          </span>
        )}
      </div>
      {insight.summary && <p className="text-[13px] text-[var(--color-ink)]">{insight.summary}</p>}
      {insight.findings.length > 0 && (
        <div className="space-y-1.5">
          {insight.findings.map((f, k) => (
            <InsightCard key={k} insight={f} />
          ))}
        </div>
      )}
      {insight.caveats.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-[var(--color-ink-faint)]">
          {insight.caveats.map((c, k) => (
            <li key={k}>{c}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function BaselineDiffPanel({ runId }: { runId: number }) {
  const { canWrite, promptLogin } = useAuth();
  const [view, setView] = useState<View>("idle");

  async function run() {
    setView("loading");
    try {
      setView(await getBaselineDiff(runId));
    } catch (e) {
      if (e instanceof ApiRequestError && (e.status === 401 || e.status === 403)) {
        setView("idle");
      } else {
        setView({ status: "transport_error", message: "Couldn’t run the comparison — this is usually transient. Try again." });
      }
    }
  }

  if (!canWrite) {
    return (
      <div className="mt-3">
        <button type="button" onClick={promptLogin} className="sw-btn sw-btn-sm" data-testid={`baseline-diff-signin-${runId}`}>
          🔍 Why is this failing?
        </button>
        <p className="mt-1 text-[11px] text-[var(--color-ink-faint)]">Sign in (editor access) to compare against the last good run.</p>
      </div>
    );
  }

  return (
    <div className="mt-3" data-testid={`baseline-diff-${runId}`}>
      {view === "idle" && (
        <>
          <button type="button" onClick={run} className="sw-btn sw-btn-sm sw-btn-primary" data-testid={`get-baseline-diff-${runId}`}>
            🔍 Why is this failing?
          </button>
          <p className="mt-1 text-[11px] text-[var(--color-ink-faint)]">
            Compares this run against the monitor’s last-known-good run (not the passing location directly).
          </p>
        </>
      )}

      {view === "loading" && (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-4" data-testid="baseline-diff-loading">
          <Spinner label="Comparing against the baseline…" />
        </div>
      )}

      {typeof view === "object" && view.status === "transport_error" && (
        <div
          className="rounded-lg border px-3 py-3 text-[12px]"
          style={{
            background: "color-mix(in srgb, var(--color-warn) 10%, transparent)",
            borderColor: "color-mix(in srgb, var(--color-warn) 35%, transparent)",
            color: "var(--color-ink-dim)",
          }}
          data-testid="baseline-diff-transport-error"
        >
          {view.message}{" "}
          <button type="button" onClick={run} className="underline hover:text-[var(--color-ink)]" data-testid={`baseline-diff-transport-retry-${runId}`}>
            Try again
          </button>
        </div>
      )}

      {typeof view === "object" && (view.status === "ok" || view.status === "not_configured" || view.status === "unavailable") && (
        <div className="sw-panel space-y-3 p-3">
          <div className="flex items-center justify-between">
            <span className="sw-eyebrow">Comparison vs last good run</span>
            <button type="button" onClick={run} className="sw-btn sw-btn-sm" data-testid={`baseline-diff-rerun-${runId}`}>
              ↻ Re-run
            </button>
          </div>

          <DiffBody diff={view.diff} />

          {view.status === "ok" && <InsightBody insight={view.insight} />}

          {view.status === "not_configured" && (
            <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[12px] text-[var(--color-ink-dim)]" data-testid="baseline-diff-not-configured">
              <span className="font-medium text-[var(--color-ink)]">{view.message}</span> The AI comparison turns on once the AOAI backend is configured — the diff above is still shown.
            </p>
          )}

          {view.status === "unavailable" && (
            <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[12px] text-[var(--color-ink-dim)]" data-testid="baseline-diff-unavailable">
              {view.message}{" "}
              {view.retryable && (
                <button type="button" onClick={run} className="underline hover:text-[var(--color-ink)]" data-testid={`baseline-diff-retry-${runId}`}>
                  Try again
                </button>
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
