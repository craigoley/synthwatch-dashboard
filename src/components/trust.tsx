"use client";

import { useTrustDetail } from "@/lib/client";
import { TONE_VAR } from "@/components/status-badge";
import { formatRelative } from "@/lib/format";
import type { TrustChip, TrustIncidents, TrustRetryPoint, TrustRow } from "@/lib/types";

/**
 * §D1 monitor-trust — the "every green shown with its proof" surface. NO composite score: the chip is
 * rule-derived by the API from NAMED CONSTANTS, and we render that rule as a visible legend so the chip is
 * auditable, not magic. Colors follow the severity discipline — and unverified is NEUTRAL (grey), never red:
 * it isn't broken, it's unproven.
 */

// Named-constant thresholds — the SAME rule the API applies, rendered verbatim in the legend below.
export const TRUST_RULES = {
  RETRY_PROVEN_MAX: 0.1, // proven-live requires retry rate < 10%
  RETRY_FLAKY_MIN: 0.5, // flaky if retry rate ≥ 50%
  GREEN_INTERVALS: 2, // proven-live requires a green within the last 2 run intervals
} as const;

// chip → { label, tone }. tone maps to the status-color law: pass=green(calm-good), warn=amber(attention),
// running=blue(neutral-active/in-between), idle=grey(neutral-unknown). NONE are red — unverified ≠ broken.
export const TRUST_META: Record<TrustChip, { label: string; tone: "pass" | "warn" | "running" | "idle"; blurb: string }> = {
  "proven-live": {
    label: "Proven live",
    tone: "pass",
    blurb: `green within ${TRUST_RULES.GREEN_INTERVALS} intervals AND retry < ${TRUST_RULES.RETRY_PROVEN_MAX * 100}% AND no monitor-noise`,
  },
  nominal: { label: "Nominal", tone: "running", blurb: "in between — recent green, retry acceptable, no clear flakiness" },
  flaky: {
    label: "Flaky",
    tone: "warn",
    blurb: `retry ≥ ${TRUST_RULES.RETRY_FLAKY_MIN * 100}% OR any monitor-noise (flaky/selector-drift)`,
  },
  unverified: { label: "Unverified", tone: "idle", blurb: "never green OR no runs — unproven, not broken" },
};

// Worst-first sort rank: a Director scans the problems first (unverified + flaky on top, proven-live last).
export const TRUST_RANK: Record<TrustChip, number> = { unverified: 0, flaky: 1, nominal: 2, "proven-live": 3 };

export function TrustChipBadge({ chip }: { chip: TrustChip }) {
  const m = TRUST_META[chip];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-medium"
      style={{ color: TONE_VAR[m.tone], background: `color-mix(in srgb, ${TONE_VAR[m.tone]} 14%, transparent)` }}
      data-testid={`trust-chip-${chip}`}
      title={m.blurb}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: TONE_VAR[m.tone] }} />
      {m.label}
    </span>
  );
}

/** The rule legend — load-bearing: the chip is only trustworthy because the rule is inspectable. */
export function TrustLegend() {
  return (
    <div className="sw-panel p-4 text-[12px]" data-testid="trust-legend">
      <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">How the chip is derived</h3>
      <p className="mb-3 text-[var(--color-ink-dim)]">
        No composite score — measured facts + an auditable rule. Each chip is exactly:
      </p>
      <ul className="space-y-2">
        {(Object.keys(TRUST_META) as TrustChip[]).map((chip) => (
          <li key={chip} className="flex flex-wrap items-baseline gap-2">
            <TrustChipBadge chip={chip} />
            <span className="text-[var(--color-ink-dim)]">{TRUST_META[chip].blurb}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The honest red-test slot — a planned capability, NEVER rendered as passing/green in v1. */
export function RedTestNotCaptured() {
  return (
    <span
      className="sw-mono text-[12px] text-[var(--color-ink-faint)]"
      data-testid="trust-redtest"
      title="Red-test tracking (does a real failure actually turn this monitor red?) is a planned capability; not yet captured."
    >
      ✗ not captured
    </span>
  );
}

// ── formatting helpers (honest-empty) ────────────────────────────────────────────────────────────────────
export function retryRateText(row: Pick<TrustRow, "retry_rate" | "retry_count" | "run_count">): string {
  if (row.retry_rate == null) return "—"; // no runs → em-dash, NEVER 0%
  return `${Math.round(row.retry_rate * 100)}% (${row.retry_count}/${row.run_count})`;
}
export function lastGreenText(iso: string | null): string {
  return iso == null ? "never verified" : formatRelative(iso);
}

// ── detail-card pieces ───────────────────────────────────────────────────────────────────────────────────

const INCIDENT_META: { key: keyof TrustIncidents; label: string; tone: "fail" | "warn" | "brand" | "idle" }[] = [
  { key: "real_outage", label: "Real outage", tone: "fail" },
  { key: "environment_regional", label: "Environment / regional", tone: "warn" },
  { key: "perf_regression", label: "Perf regression", tone: "warn" },
  { key: "selector_drift", label: "Selector drift — monitor bug", tone: "brand" },
  { key: "flaky_transient", label: "Flaky / transient", tone: "idle" },
  { key: "unclassified", label: "Unclassified", tone: "idle" },
];

function IncidentBreakdown({ incidents }: { incidents: TrustIncidents }) {
  if (incidents.total === 0) {
    return <p className="text-[12px] text-[var(--color-ink-dim)]" data-testid="trust-incidents-none">No incidents in this window.</p>;
  }
  return (
    <ul className="space-y-1 text-[12px]" data-testid="trust-incidents">
      {INCIDENT_META.map((m) => (
        <li key={m.key} className="flex items-center justify-between gap-3" data-testid={`trust-incident-${m.key}`}>
          <span className="flex items-center gap-2 text-[var(--color-ink-dim)]">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: `var(--color-${m.tone})` }} />
            {m.label}
          </span>
          <span className="sw-mono text-[var(--color-ink)]">{incidents[m.key]}</span>
        </li>
      ))}
    </ul>
  );
}

function RetrySparkline({ series }: { series: TrustRetryPoint[] }) {
  const present = series.filter((p) => p.retry_rate != null);
  if (present.length < 2) return null; // needs ≥2 real days to read a trend
  const first = series.find((p) => p.retry_rate != null);
  const last = [...series].reverse().find((p) => p.retry_rate != null);
  return (
    <div data-testid="trust-retry-sparkline">
      <h4 className="mb-2 text-[11px] uppercase tracking-wider text-[var(--color-ink-faint)]">Retry rate · daily</h4>
      <div className="flex items-end gap-0.5" style={{ height: 44 }}>
        {series.map((p) =>
          p.retry_rate == null ? (
            // a GAP (no runs) — a faint baseline tick, never a 0%-height bar (gaps-not-zeros)
            <span key={p.day} title={`${p.day} · no runs`} className="flex-1 self-end" style={{ height: 2, background: "var(--color-border)" }} />
          ) : (
            <span
              key={p.day}
              title={`${p.day} · ${Math.round(p.retry_rate * 100)}% retry · ${p.run_count} runs`}
              className="flex-1 rounded-t"
              style={{ height: `${Math.max(3, p.retry_rate * 100)}%`, background: "var(--color-warn)" }}
            />
          ),
        )}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-[var(--color-ink-faint)]">
        <span>{first?.day}</span>
        <span>{last?.day}</span>
      </div>
    </div>
  );
}

/**
 * Per-check Trust card for the monitor detail page. Self-fetching + null-safe: 404 / no trust data → renders
 * nothing (mirrors the SLO/deploys self-hide). Shows the chip + the honest red-test gap, last-green, the
 * retry-rate sparkline, the full incident breakdown, and the spec-provenance hash (an INTEGRITY fact — the
 * committed assertion code that ran — explicitly NOT a red-test).
 */
export function TrustCard({ checkId, window = "30d" }: { checkId: number; window?: "7d" | "30d" | "90d" }) {
  const { data } = useTrustDetail(checkId, window);
  if (!data) return null;
  const m = data.monitor;
  const neverGreen = m.last_green_at == null;

  return (
    <section className="sw-panel p-4" data-testid="trust-card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--color-ink)]">Trust</h3>
        <div className="flex items-center gap-2">
          <TrustChipBadge chip={m.trust} />
          <RedTestNotCaptured />
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">Last green</div>
          <div
            className={`text-[13px] ${neverGreen ? "font-medium" : ""}`}
            style={{ color: neverGreen ? TONE_VAR.idle : "var(--color-ink)" }}
            data-testid="trust-last-green"
          >
            {lastGreenText(m.last_green_at)}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">Retry rate</div>
          <div className="sw-mono text-[13px] text-[var(--color-ink)]" data-testid="trust-retry-rate">{retryRateText(m)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">Runs</div>
          <div className="sw-mono text-[13px] text-[var(--color-ink)]">{m.run_count}</div>
        </div>
      </div>

      <div className="mb-4">
        <RetrySparkline series={data.retry_series} />
      </div>

      <div className="mb-4">
        <h4 className="mb-2 text-[11px] uppercase tracking-wider text-[var(--color-ink-faint)]">Incidents by cause</h4>
        <IncidentBreakdown incidents={m.incidents} />
      </div>

      {/* Spec provenance — an INTEGRITY fact (the committed assertion code that actually ran), NOT a red-test. */}
      {m.spec_provenance.executed_sha256 && (
        <div className="border-t border-[var(--color-border)] pt-3" data-testid="trust-provenance">
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
            Spec integrity · executed code
          </div>
          {m.spec_provenance.spec_path && (
            <div className="sw-mono text-[11px] text-[var(--color-ink-dim)]">{m.spec_provenance.spec_path}</div>
          )}
          <div className="sw-mono break-all text-[11px] text-[var(--color-ink)]" title="SHA-256 of the assertion code that ran">
            {m.spec_provenance.executed_sha256}
          </div>
        </div>
      )}
    </section>
  );
}
