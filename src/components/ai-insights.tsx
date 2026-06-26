"use client";

import { useState } from "react";

import { getAiInsights, ApiRequestError } from "@/lib/api-client";
import { TONE_VAR } from "@/components/status-badge";
import { useAuth } from "@/components/auth-provider";
import { Spinner } from "@/components/states";
import type { AiInsight, AiInsights, AiInsightsResult, AiInsightSeverity } from "@/lib/types";

/**
 * Trace AI insights (slice 3): a "Get AI insights" button on the run-detail trace view → POST
 * /api/runs/{id}/ai-insights → categorized cards. Handles ALL non-happy states gracefully:
 *  - not_configured (200, the live state until the AOAI deploy prereq) → a clean message, not an error.
 *  - unavailable (AOAI/extraction non-fatal null) → a soft "try again".
 *  - 401/403 → swallowed here; the global request() interceptor drives re-login / the permission toast.
 *  - the button is gated to editors/admins (UX-only; the API is the real gate) — it's a token-spend action.
 */

const SEV_RANK: Record<AiInsightSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
// ★ Reuse the status-color law for severity — never invent colors:
//   critical/high = fail (red), medium = warn (amber), low/info = idle (grey).
const SEV_TOKEN: Record<AiInsightSeverity, "fail" | "warn" | "idle"> = {
  critical: "fail",
  high: "fail",
  medium: "warn",
  low: "idle",
  info: "idle",
};
const severityTone = (s: AiInsightSeverity) => TONE_VAR[SEV_TOKEN[s]];

type View = "idle" | "loading" | AiInsightsResult;

function InsightCard({ insight }: { insight: AiInsight }) {
  const tone = severityTone(insight.severity);
  return (
    <div className="rounded-md border-l-2 bg-[var(--color-panel-2)] px-3 py-2" style={{ borderLeftColor: tone }}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="sw-mono text-[10px] font-semibold uppercase tracking-wider" style={{ color: tone }}>
          {insight.severity}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
          {insight.confidence} confidence
        </span>
        {insight.scope && (
          <span className="sw-mono text-[10px] text-[var(--color-ink-faint)]">· {insight.scope.replace("_", " ")}</span>
        )}
      </div>
      <div className="mt-0.5 text-[13px] font-medium text-[var(--color-ink)]">{insight.title}</div>
      {insight.detail && <p className="mt-0.5 text-[12px] text-[var(--color-ink-dim)]">{insight.detail}</p>}
      {insight.evidence && (
        <p className="sw-mono mt-1 text-[11px] text-[var(--color-ink-faint)]">Evidence: {insight.evidence}</p>
      )}
    </div>
  );
}

function Category({ label, items }: { label: string; items: AiInsight[] }) {
  if (items.length === 0) return null;
  const sorted = [...items].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]); // worst first
  return (
    <div data-testid={`ai-category-${label.toLowerCase()}`}>
      <div className="sw-eyebrow mb-1.5">{label}</div>
      <div className="space-y-1.5">
        {sorted.map((i, k) => (
          <InsightCard key={k} insight={i} />
        ))}
      </div>
    </div>
  );
}

function InsightsBody({ insights }: { insights: AiInsights }) {
  return (
    <div className="space-y-3" data-testid="ai-insights-result">
      {insights.summary && <p className="text-[13px] text-[var(--color-ink)]">{insights.summary}</p>}
      <Category label="Performance" items={insights.performance} />
      <Category label="Network" items={insights.network} />
      <Category label="Errors" items={insights.errors} />
      <Category label="Suggestions" items={insights.suggestions} />
      {insights.caveats.length > 0 && (
        <div
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2"
          data-testid="ai-caveats"
        >
          <div className="sw-eyebrow mb-1">Caveats</div>
          <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-[var(--color-ink-faint)]">
            {insights.caveats.map((c, k) => (
              <li key={k}>{c}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function AiInsightsPanel({ runId }: { runId: number }) {
  const { canWrite, promptLogin } = useAuth();
  const [view, setView] = useState<View>("idle");

  async function analyze() {
    setView("loading");
    try {
      setView(await getAiInsights(runId));
    } catch (e) {
      // 401/403 are already handled by the global request() interceptor (re-login modal / permission
      // toast) — don't render a broken card; just reset. Anything else → a soft, retryable message.
      if (e instanceof ApiRequestError && (e.status === 401 || e.status === 403)) {
        setView("idle");
      } else {
        setView({ status: "unavailable", message: "Couldn’t generate insights. Try again." });
      }
    }
  }

  // Gate the affordance UX-only (the API is the real gate): a token-spend action, editors/admins only.
  if (!canWrite) {
    return (
      <div className="mt-3">
        <button
          type="button"
          onClick={promptLogin}
          className="sw-btn sw-btn-sm"
          data-testid={`ai-insights-signin-${runId}`}
        >
          ✨ Get AI insights
        </button>
        <p className="mt-1 text-[11px] text-[var(--color-ink-faint)]">Sign in (editor access) to analyze this trace.</p>
      </div>
    );
  }

  return (
    <div className="mt-3" data-testid={`ai-insights-${runId}`}>
      {view === "idle" && (
        <>
          <button
            type="button"
            onClick={analyze}
            className="sw-btn sw-btn-sm sw-btn-primary"
            data-testid={`get-ai-insights-${runId}`}
          >
            ✨ Get AI insights
          </button>
          <p className="mt-1 text-[11px] text-[var(--color-ink-faint)]">
            Best-effort analysis of the trace’s network, console &amp; payloads (takes a few seconds).
          </p>
        </>
      )}

      {view === "loading" && (
        <div
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-4"
          data-testid="ai-insights-loading"
        >
          <Spinner label="Analyzing the trace…" />
        </div>
      )}

      {typeof view === "object" && view.status === "ok" && (
        <div className="sw-panel p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="sw-eyebrow">AI insights</span>
            <button type="button" onClick={analyze} className="sw-btn sw-btn-sm" data-testid={`ai-rerun-${runId}`}>
              ↻ Re-run
            </button>
          </div>
          <InsightsBody insights={view.insights} />
        </div>
      )}

      {typeof view === "object" && view.status === "not_configured" && (
        <div
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-3 text-[12px] text-[var(--color-ink-dim)]"
          data-testid="ai-not-configured"
        >
          <span className="font-medium text-[var(--color-ink)]">{view.message}</span>{" "}
          Trace analysis turns on once the AOAI backend is configured.
        </div>
      )}

      {typeof view === "object" && view.status === "unavailable" && (
        <div
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-3 text-[12px] text-[var(--color-ink-dim)]"
          data-testid="ai-unavailable"
        >
          {view.message}{" "}
          <button
            type="button"
            onClick={analyze}
            className="underline hover:text-[var(--color-ink)]"
            data-testid={`ai-retry-${runId}`}
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
