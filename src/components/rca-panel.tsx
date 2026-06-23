import { ToneBadge } from "@/components/status-badge";
import type { IncidentRca, RcaClassification } from "@/lib/types";

export const RCA_LABEL: Record<RcaClassification, string> = {
  "real-outage": "Real outage",
  "flaky-transient": "Flaky / transient",
  "selector-drift": "Selector drift",
  "environment-regional": "Environment / regional",
  "perf-regression": "Perf regression",
};
// A real outage is red; perf/selector/environment are amber (degraded, not a hard
// down); flaky-transient is neutral (likely noise).
export const RCA_TONE: Record<RcaClassification, "fail" | "warn" | "idle"> = {
  "real-outage": "fail",
  "perf-regression": "warn",
  "selector-drift": "warn",
  "environment-regional": "warn",
  "flaky-transient": "idle",
};

/**
 * Runner root-cause analysis — shared by the incidents LIST (inline triage) and the
 * incident DETAIL page (full investigation). ★ The observed-vs-inferred split is the
 * whole point: OBSERVED = facts the evidence shows (solid, confident styling);
 * INFERRED = the model's hypotheses (dashed, tentative, italic). The human must
 * never mistake a guess for a fact, so the two blocks are deliberately distinct.
 */
export function RcaPanel({ rca }: { rca: IncidentRca }) {
  return (
    <div className="col-span-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">Root cause</span>
        <ToneBadge label={RCA_LABEL[rca.classification]} token={RCA_TONE[rca.classification]} />
        <span className="sw-mono rounded-full border border-[var(--color-border-strong)] px-1.5 text-[10px] uppercase tracking-wider text-[var(--color-ink-dim)]">
          {rca.confidence} confidence
        </span>
      </div>
      {rca.summary && <p className="mb-3 text-sm text-[var(--color-ink-dim)]">{rca.summary}</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {/* OBSERVED — facts: solid border, panel bg, normal text */}
        <div className="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-panel-2)] p-2.5">
          <div className="mb-1.5 flex items-center gap-1.5">
            <span className="sw-dot" style={{ background: "var(--color-pass)" }} />
            <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink)]">Observed · facts</span>
          </div>
          {rca.observed.length > 0 ? (
            <ul className="space-y-1 text-[12px] text-[var(--color-ink-dim)]">
              {rca.observed.map((o, i) => (
                <li key={i}>• {o}</li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-[var(--color-ink-faint)]">—</p>
          )}
        </div>
        {/* INFERRED — hypotheses: DASHED border, no bg, italic muted text */}
        <div className="rounded-md border border-dashed border-[var(--color-border-strong)] p-2.5">
          <div className="mb-1.5 flex items-center gap-1.5">
            <span className="sw-dot" style={{ background: "var(--color-warn)" }} />
            <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-dim)]">
              Inferred · model&apos;s hypothesis
            </span>
          </div>
          {rca.inferred.length > 0 ? (
            <ul className="space-y-1 text-[12px] italic text-[var(--color-ink-faint)]">
              {rca.inferred.map((x, i) => (
                <li key={i}>~ {x}</li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-[var(--color-ink-faint)]">—</p>
          )}
        </div>
      </div>
    </div>
  );
}
