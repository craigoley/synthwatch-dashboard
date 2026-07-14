"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

import { useTrustDetail, useTrustReport } from "@/lib/client";
import { TONE_VAR } from "@/components/status-badge";
import { EmptyState, ErrorState, Spinner } from "@/components/states";
import { StalenessStamp, useFetchedAt } from "@/components/staleness";
import { formatRelative } from "@/lib/format";
import type { ReportWindow, TrustChip, TrustDimensionState, TrustFlakeBudget, TrustIncidents, TrustRetryPoint, TrustRow } from "@/lib/types";

/**
 * §D1 monitor-trust — the "every green shown with its proof" surface. NO composite score: the chip is
 * rule-derived by the API from NAMED CONSTANTS, and we render that rule as a visible legend so the chip is
 * auditable, not magic. Colors follow the severity discipline — and unverified is NEUTRAL (grey), never red:
 * it isn't broken, it's unproven.
 */

// ★ B3-2 — the SAME per-dimension thresholds the API applies (TrustReportProjection), DERIVED FROM THE MEASURED
// 30d FLEET DISTRIBUTION (not round numbers), rendered verbatim in the legend below. Two cutoffs per rate
// dimension: `elevated` (above the well-behaved fleet band → blocks proven-live) and `flaky` (pathological).
export const TRUST_RULES = {
  GREEN_INTERVALS: 2, // proven-live requires a green within the last 2 run intervals
  FLAP_ELEVATED_MIN: 0.01, // flap dimension elevated at ≥ 1% …
  FLAP_FLAKY_MIN: 0.05, // … flaky at ≥ 5% …
  FLAP_MIN_COUNT: 2, // … both gated on ≥ 2 transient failures (one flap is noise; a pattern repeats)
  RETRY_ELEVATED_MIN: 0.02, // retry dimension elevated at ≥ 2% …
  RETRY_FLAKY_MIN: 0.1, // … flaky at ≥ 10% (matches the old proven-live boundary; the dead 50% floor is gone)
  SPURIOUS_ELEVATED_MIN: 0.01, // ★ B3-2 stage 2: spurious-red (monitor-side transients ÷ scheduled) elevated ≥ 1% …
  SPURIOUS_FLAKY_MIN: 0.05, // … flaky at ≥ 5% …
  SPURIOUS_MIN_COUNT: 2, // … with ≥ 2 monitor-side transients (one is noise)
} as const;

// chip → { label, tone }. tone maps to the status-color law: pass=green(calm-good), warn=amber(attention),
// running=blue(neutral-active/in-between), idle=grey(neutral-unknown). NONE are red — unverified ≠ broken.
// ★ B3-2: the chip is now DERIVED over distinct dimensions (below), never an OR-collapse that hides which axis.
export const TRUST_META: Record<TrustChip, { label: string; tone: "pass" | "warn" | "running" | "idle"; blurb: string }> = {
  "proven-live": {
    label: "Proven live",
    tone: "pass",
    blurb: `green within ${TRUST_RULES.GREEN_INTERVALS} intervals AND EVERY dimension ok (no elevated, no flaky)`,
  },
  nominal: { label: "Nominal", tone: "running", blurb: "green is stale, OR a dimension is elevated — worth watching, not yet flaky" },
  flaky: {
    label: "Flaky",
    tone: "warn",
    blurb: "ANY dimension flaky — the chip names which (flap / retry / monitor-noise)",
  },
  unverified: { label: "Unverified", tone: "idle", blurb: "never green OR no runs — unproven, not broken" },
};

// ── ★ B3-2 the DISTINCT DIMENSIONS (the surfaced replacement for the OR-collapse) ──────────────────────────
// tone by state: ok = calm/neutral, elevated = amber (watch), flaky = amber-loud (the axis that demotes the chip).
const DIM_STATE_TONE: Record<TrustDimensionState, "pass" | "warn" | "idle"> = { ok: "idle", elevated: "warn", flaky: "warn" };

type DimKey = "flap" | "retry" | "monitor_noise" | "spurious_red";
// Each dimension: its label, the exact formula + threshold (rendered verbatim in the legend), and how to read
// its current value off a row. monitor-noise is a COUNT (selector-drift + flaky-transient), not a rate.
const DIMENSION_META: {
  key: DimKey;
  label: string;
  rule: string;
  value: (row: TrustRow) => string;
}[] = [
  {
    key: "flap",
    label: "Flap",
    rule: `transient failures ÷ scheduled runs — elevated ≥ ${TRUST_RULES.FLAP_ELEVATED_MIN * 100}%, flaky ≥ ${TRUST_RULES.FLAP_FLAKY_MIN * 100}% (with ≥ ${TRUST_RULES.FLAP_MIN_COUNT})`,
    value: (row) => flapRateText(row),
  },
  {
    key: "retry",
    label: "Retry",
    rule: `runs needing a real retry ÷ runs — elevated ≥ ${TRUST_RULES.RETRY_ELEVATED_MIN * 100}%, flaky ≥ ${TRUST_RULES.RETRY_FLAKY_MIN * 100}%`,
    value: (row) => retryRateText(row),
  },
  {
    key: "monitor_noise",
    label: "Monitor-noise",
    rule: "RCA flaky-transient + selector-drift incidents — flaky at ≥ 1 (a count, not a rate)",
    value: (row) => (row.incidents ? `${row.incidents.flaky_transient + row.incidents.selector_drift}` : "—"),
  },
  {
    key: "spurious_red",
    label: "Spurious-red",
    // ★ ONLY monitor-side transients — a service-side transient (a real brief outage the monitor caught) is
    // deliberately excluded, so the budget never penalises a monitor for its service being flaky.
    rule: `MONITOR-SIDE transients ÷ scheduled runs — elevated ≥ ${TRUST_RULES.SPURIOUS_ELEVATED_MIN * 100}%, flaky ≥ ${TRUST_RULES.SPURIOUS_FLAKY_MIN * 100}% (with ≥ ${TRUST_RULES.SPURIOUS_MIN_COUNT}). Service-side transients never count.`,
    value: (row) => spuriousRedText(row),
  },
];

/**
 * ★ B3-2 — the distinct dimensions rendered as a compact strip: one labelled state dot per axis (flap / retry /
 * monitor-noise), tinted by its state, each carrying its current value + formula in the title. This is the
 * SURFACED replacement for the OR-collapse — you see WHICH axis flags, not a single verdict. Always shown (a
 * clean monitor reads three faint "ok" dots), so "proven live" is legible as "clean on every axis".
 */
export function DimensionStrip({ row }: { row: TrustRow }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="trust-dimensions">
      {DIMENSION_META.map((d) => {
        const state = row.dimensions[d.key];
        // ★ Absent state (null) → EXPLICIT unknown ("— no data"), NEVER a clean "ok". The API returned no
        // verdict for this axis; a data gap must read as unknown, not healthy. A hollow dot + em-dash reads
        // distinctly from the filled faint dot of a genuine "ok".
        if (state == null) {
          return (
            <span
              key={d.key}
              className="inline-flex items-center gap-1 text-[11px] text-[var(--color-ink-faint)]"
              data-testid={`trust-dim-${d.key}`}
              data-state="unknown"
              title={`${d.label}: NO DATA — the API returned no state for this dimension. This is UNKNOWN, not "ok".`}
            >
              <span className="h-1.5 w-1.5 rounded-full border border-[var(--color-ink-faint)]" />
              {d.label} <span className="font-medium">— no data</span>
            </span>
          );
        }
        const tone = DIM_STATE_TONE[state];
        const dim = state === "ok"; // an ok dimension reads faint; elevated/flaky read amber (attention)
        return (
          <span
            key={d.key}
            className="inline-flex items-center gap-1 text-[11px]"
            style={{ color: dim ? "var(--color-ink-faint)" : TONE_VAR[tone] }}
            data-testid={`trust-dim-${d.key}`}
            data-state={state}
            title={`${d.label}: ${state.toUpperCase()} (${d.value(row)}) — ${d.rule}`}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: dim ? "var(--color-border)" : TONE_VAR[tone] }} />
            {d.label} {d.value(row)}
            {state !== "ok" && <span className="font-medium"> · {state}</span>}
          </span>
        );
      })}
    </span>
  );
}

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

// ★ "Degrading-but-green" early warning. The ONLY threshold is > 0 (any passing run that needed a real retry
// is worth surfacing) — named, not magic. Deliberately SEPARATE from TRUST_RULES: this is NOT a chip rule.
export const RETRIED_PASSES_MIN_TO_WARN = 1;

/**
 * An ANNOTATION on a healthy monitor — NEVER a chip demotion. The API carries `retried_passes` (PASS/WARN runs
 * that still needed a real retry) as a DISPLAY-ONLY fact that never feeds the trust chip: a proven-live monitor
 * with retried passes STAYS proven-live. Rendered warn-toned but visually DISTINCT from TrustChipBadge — plain
 * caption text with a small dot, no pill — so it reads as "watch this", not "downgraded". Hidden when 0.
 */
export function RetriedPassesNote({ retriedPasses, window }: { retriedPasses: number; window: string }) {
  if (retriedPasses < RETRIED_PASSES_MIN_TO_WARN) return null;
  return (
    <span
      className="mt-0.5 inline-flex items-center gap-1 text-[11px]"
      style={{ color: TONE_VAR.warn }}
      data-testid="trust-retried-passes"
      title={`${retriedPasses} passing run(s) needed a real retry in the last ${window} — degrading, but still green. This does NOT change the trust chip.`}
    >
      <span className="h-1 w-1 rounded-full" style={{ background: TONE_VAR.warn }} />
      {retriedPasses} {retriedPasses === 1 ? "pass" : "passes"} needed retries · {window}
    </span>
  );
}

/**
 * Confirmation-retry P2: transient failures made VISIBLE. A scheduled run FAILED, but a fresh confirmation run
 * PASSED, so it was confirmed NOT-real and excluded from availability/the SLO — it DID happen (the check
 * flapped), it just did not count. Surfaced so a check flapping N×/window TELLS you rather than silently
 * self-healing. The copy is explicit that the platform MEASURED a self-healed failure, never HID one. Hidden
 * when 0. (Unlike RetriedPassesNote, a REPEATED flap also feeds the chip server-side — this note explains it.)
 */
export function FlapNote({ flapCount, scheduledCount, window }: { flapCount: number; scheduledCount: number; window: string }) {
  if (flapCount <= 0) return null;
  const pct = scheduledCount > 0 ? `${((flapCount / scheduledCount) * 100).toFixed(1)}%` : "—";
  return (
    <span
      className="mt-0.5 inline-flex items-center gap-1 text-[11px]"
      style={{ color: TONE_VAR.warn }}
      data-testid="trust-flap-note"
      title={`${flapCount} transient failure(s) in ${scheduledCount} scheduled runs (${pct}) over the last ${window}. Each FAILED, then a confirmation run PASSED — confirmed not-real, so it does NOT count toward availability or the SLO. The platform didn't hide a failure; it measured one that self-healed.`}
    >
      <span className="h-1 w-1 rounded-full" style={{ background: TONE_VAR.warn }} />
      {flapCount} transient {flapCount === 1 ? "failure" : "failures"} / {scheduledCount} runs ({pct}) · didn&apos;t count · {window}
    </span>
  );
}

// ★ B3-3 — the MONITOR trust budget. Rendered in a DELIBERATELY DISTINCT idiom from a service alert: the brand
// accent + a "⚑ degraded as a MONITOR" label + the copy "this is a MONITOR problem, not a service outage" — so
// an operator never confuses "my monitor is unreliable" with "Wegmans is down". The consequence is the DIRECTED
// FIX TASK (a string), never a mute. Indeterminate is surfaced with the honest partial-data caveat.
const MONITOR_TONE = "var(--color-brand)"; // distinct from the status-law tones (pass/warn/fail) on purpose
export function FlakeBudgetNote({ fb }: { fb: TrustFlakeBudget | null }) {
  // ★ Absence is a STATE, not health. A null budget = the API sent no flake-budget object; render it
  // EXPLICITLY (never nothing, never a crash) so a data gap can't read as "healthy monitor". Distinct from
  // the healthy self-hide below — healthy and absent must not be the same render.
  if (fb == null) {
    return (
      <div className="mt-0.5" data-testid="trust-flake-budget-absent">
        <span
          className="sw-mono text-[10px] text-[var(--color-ink-faint)]"
          title="The API returned no flake-budget object for this monitor (feature absent or an older API). This is MISSING DATA, not a healthy budget — the monitor-side trust budget could not be evaluated."
        >
          — no flake-budget data
        </span>
      </div>
    );
  }
  const degraded = fb.state === "degraded-as-a-monitor";
  const hasIndeterminate = fb.indeterminate > 0;
  if (!degraded && !hasIndeterminate) return null; // healthy + fully-classified → nothing to say
  return (
    <div className="mt-0.5 space-y-0.5" data-testid="trust-flake-budget">
      {degraded && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className="sw-mono rounded px-1 text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: MONITOR_TONE, background: `color-mix(in srgb, ${MONITOR_TONE} 14%, transparent)` }}
            data-testid="trust-degraded-as-monitor"
            title="The MONITOR is unreliable — a different problem, and a different owner, from a service outage. It is NOT muted: a monitor that flaps because the service is flaky is telling the truth."
          >
            ⚑ degraded as a monitor
          </span>
          <span className="sw-mono text-[10px] text-[var(--color-ink-faint)]">
            {fb.consumed}/{fb.budget.toFixed(1)} monitor-side budget · burn {fb.burn_rate.toFixed(1)}×
            {fb.target_is_default ? " · fleet default 2%" : ` · override ${(fb.target * 100).toFixed(1)}%`}
          </span>
        </div>
      )}
      {degraded && fb.directed_task && (
        <div className="text-[10px] text-[var(--color-ink-dim)]" data-testid="trust-directed-task">
          → {fb.directed_task}
        </div>
      )}
      {hasIndeterminate && (
        <div className="text-[10px] text-[var(--color-ink-faint)]" data-testid="trust-indeterminate-note">
          {fb.indeterminate} transient{fb.indeterminate === 1 ? "" : "s"} unclassified — this budget is computed over
          partial data. (http/dns/ssl read indeterminate until they accumulate first-party error-signal history —
          expected, not a fault.)
        </div>
      )}
    </div>
  );
}

/** The rule legend — load-bearing: the chip is only trustworthy because the rule is inspectable. ★ B3-2: it
 *  now states each DIMENSION's formula + threshold verbatim (the thresholds are derived from the measured fleet
 *  distribution), then the chip derivation over them. */
export function TrustLegend() {
  return (
    <div className="sw-panel p-4 text-[12px]" data-testid="trust-legend">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--color-ink)]">How the chip is derived</h3>
        {/* ★ the 2am glossary — plain-language definitions of flap / spurious-red / flake budget / etc. */}
        <Link href="/glossary" className="text-[11px] text-[var(--color-brand)] hover:underline" data-testid="trust-legend-glossary-link">
          ⓘ What do these words mean? →
        </Link>
      </div>
      <p className="mb-3 text-[var(--color-ink-dim)]">
        No composite score, and no OR-collapse — each dimension is graded on its own axis (thresholds derived
        from the measured fleet distribution), and the chip is a derivation over them that names what flagged:
      </p>
      <ul className="mb-3 space-y-2" data-testid="trust-legend-dimensions">
        {DIMENSION_META.map((d) => (
          <li key={d.key} className="flex flex-wrap items-baseline gap-2">
            <span className="sw-mono rounded bg-[color-mix(in_srgb,var(--color-ink)_8%,transparent)] px-1.5 py-0.5 text-[11px] text-[var(--color-ink)]">
              {d.label}
            </span>
            <span className="text-[var(--color-ink-dim)]">{d.rule}</span>
          </li>
        ))}
      </ul>
      <p className="mb-2 text-[var(--color-ink-dim)]">Then the chip is exactly:</p>
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

/** The honest red-test slot when no red-test is recorded — NEVER rendered as passing/green. */
export function RedTestNotCaptured() {
  return (
    <span
      className="sw-mono text-[12px] text-[var(--color-ink-faint)]"
      data-testid="trust-redtest"
      title="Red-test tracking (does a real failure actually turn this monitor red?) is not captured for this monitor yet."
    >
      ✗ not captured
    </span>
  );
}

// ★ The method labels render DISTINCTLY — an executed harness proof is a stronger fact than a human
// attestation; the scorecard must not collapse them to a generic "tested" (the method distinction IS the
// honesty). Unknown methods fall through to their raw string rather than a fabricated label.
const RED_TEST_METHOD_LABEL: Record<string, string> = {
  "executed-red-fixture": "executed",
  "attested-manual": "attested",
};

/** The red-test slot: the honest "✗ not captured" GAP, or — when a harness-confirmed red_tests row exists — a
 *  recorded proof carrying its METHOD (executed vs attested, shown distinctly) + recency. captured=true is only
 *  ever set from a real red-test (§D1 v2), never inferred. */
export function RedTestStatus({
  captured,
  testedAt,
  method,
}: {
  captured: boolean;
  testedAt: string | null;
  method: string | null;
}) {
  if (!captured) return <RedTestNotCaptured />;
  const label = method ? (RED_TEST_METHOD_LABEL[method] ?? method) : "recorded";
  const when = testedAt ? formatRelative(testedAt) : null;
  return (
    <span
      className="sw-mono text-[12px] text-[var(--color-ink)]"
      data-testid="trust-redtest"
      title={`Red-tested (${method ?? "recorded"}) — a known-bad input was proven to turn this monitor red${
        testedAt ? ` (${formatRelative(testedAt)})` : ""
      }. executed = automated harness proof; attested = human-recorded.`}
    >
      ✓ red-tested · {label}
      {when ? ` · ${when}` : ""}
    </span>
  );
}

// ── formatting helpers (honest-empty) ────────────────────────────────────────────────────────────────────
export function retryRateText(row: Pick<TrustRow, "retry_rate" | "retry_count" | "run_count">): string {
  if (row.retry_rate == null) return "—"; // no runs → em-dash, NEVER 0%
  return `${Math.round(row.retry_rate * 100)}% (${row.retry_count}/${row.run_count})`;
}
// Confirmation-retry P2: "4.2% (6/142)" — transient failures ÷ scheduled runs. Null denominator → "—", never 0%.
export function flapRateText(row: Pick<TrustRow, "flap_rate" | "flap_count" | "scheduled_count">): string {
  if (row.flap_rate == null) return "—"; // no scheduled runs → em-dash, NEVER 0%
  return `${(row.flap_rate * 100).toFixed(1)}% (${row.flap_count}/${row.scheduled_count})`;
}
// ★ B3-2 stage 2: spurious-red = MONITOR-SIDE transients ÷ scheduled. The (m/s/i) tail exposes the split so the
// service-side share (never counted) and the indeterminate share (unclassified) are visible, not hidden.
export function spuriousRedText(row: Pick<TrustRow, "transients" | "scheduled_count">): string {
  const t = row.transients;
  if (row.transients.spurious_red_rate == null) return "—"; // no scheduled runs → em-dash, NEVER 0%
  return `${(row.transients.spurious_red_rate * 100).toFixed(1)}% (${t.monitor_side}m/${t.service_side}s/${t.indeterminate}i)`;
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

function IncidentBreakdown({ incidents }: { incidents: TrustIncidents | null }) {
  // ★ null = the API sent no incident rollup → EXPLICIT "no data", distinct from a genuine total:0 (which is
  // the truthful "No incidents in this window"). Absence must never read as the healthy zero.
  if (incidents == null) {
    return <p className="text-[12px] text-[var(--color-ink-faint)]" data-testid="trust-incidents-nodata">No incident data — the API returned no incident rollup for this monitor.</p>;
  }
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
 * nothing (mirrors the SLO/deploys self-hide). Split into a GLANCE layer + ONE disclosure:
 *
 *   always visible — the chip, the honest red-test slot, LAST GREEN, RETRY RATE, RUNS, the degrading-but-green
 *   annotation, and (only when non-zero) an INCIDENTS count. Collapse the boring; NEVER collapse the alarming:
 *   every bad state (not-captured, flaky/unverified chip, incidents > 0, retried passes) stays in the summary.
 *
 *   deferred behind one "Details" disclosure (the Metrics-section mechanism) — the daily retry SPARKLINE (flat
 *   0% on most monitors; drill-down value only), the INCIDENTS-BY-CAUSE breakdown (its count is already in the
 *   summary when non-zero), and the FULL spec-integrity sha256 + path (forensic — nobody reads a 64-char hash
 *   at a glance; the summary carries the short form + a copy affordance instead of a two-line wrap on mobile).
 */
export function TrustCard({ checkId, window = "30d" }: { checkId: number; window?: "7d" | "30d" | "90d" }) {
  const { data, error, isValidating, mutate } = useTrustDetail(checkId, window);
  const fetchedAt = useFetchedAt(isValidating, data != null); // before early returns (hooks rule)
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Set when the disclosure is opened FROM the summary's incidents count: the tapped element stays put while
  // the body expands below, possibly off-screen on a long page — so bring the answer to the question into view.
  const scrollToDetails = useRef(false);
  useEffect(() => {
    if (detailsOpen && scrollToDetails.current) {
      scrollToDetails.current = false;
      document.getElementById("trust-details-body")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [detailsOpen]);
  // Transient "copied" confirmation on the short-sha copy affordance (auto-clears).
  const [copied, setCopied] = useState(false);
  // ★ Loud-not-silent: a 500/network error shows a visible state; a 404 → data null → hide (feature absent).
  if (error) return <ErrorState testId="trust-card-error" message="Trust data failed to load — retry." />;
  if (!data) return null;
  const m = data.monitor;
  const neverGreen = m.last_green_at == null;
  const sha = m.spec_provenance.executed_sha256;

  return (
    <section className="sw-panel p-4" data-testid="trust-card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-[var(--color-ink)]">Trust</h3>
          <StalenessStamp fetchedAt={fetchedAt} onRefresh={() => mutate()} refreshing={isValidating} testId="trust-card" />
        </div>
        <div className="flex items-center gap-2">
          <TrustChipBadge chip={m.trust} />
          <RedTestStatus
            captured={m.red_test_captured}
            testedAt={m.red_test_tested_at}
            method={m.red_test_method}
          />
        </div>
      </div>

      {/* degrading-but-green early warning + transient-flap note — distinct annotations, NOT a chip demotion.
          Each self-hides (RetriedPassesNote when < MIN, FlapNote when 0), so gate on EITHER having something to
          say — otherwise a check that flaps but has no retried passes would silently drop the flap note here
          while the fleet scorecard still shows it. */}
      {(m.retried_passes >= RETRIED_PASSES_MIN_TO_WARN || m.flap_count > 0) && (
        <div className="mb-3">
          <RetriedPassesNote retriedPasses={m.retried_passes} window={window} />
          <FlapNote flapCount={m.flap_count} scheduledCount={m.scheduled_count} window={window} />
        </div>
      )}

      {/* ★ B3-2: the distinct dimensions — WHICH axis flags, surfaced (never the OR-collapse). */}
      <div className="mb-3" data-testid="trust-card-dimensions">
        <DimensionStrip row={m} />
        {/* ★ B3-3: the MONITOR trust budget — "degraded as a monitor" + the directed FIX TASK (distinct from a
            service alert) + the indeterminate caveat. The SAME note the fleet Trust table renders, mounted here
            so the directed task is present on the surface where you INVESTIGATE one monitor (not only when
            comparing the fleet). Self-hides when healthy + fully-classified; data is already on `m` — no fetch. */}
        <FlakeBudgetNote fb={m.flake_budget} />
      </div>

      {/* the glance layer: a compact wrapping stat row, not a tall stack */}
      <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
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
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">Flap rate</div>
          <div
            className="sw-mono text-[13px] text-[var(--color-ink)]"
            data-testid="trust-flap-rate"
            title="Transient failures (a run that failed, then a confirmation passed → confirmed not-real, excluded from availability/the SLO) ÷ scheduled runs. These didn't count — but they DID happen."
          >
            {flapRateText(m)}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">Runs</div>
          <div className="sw-mono text-[13px] text-[var(--color-ink)]">{m.run_count}</div>
        </div>
        {/* ★ exception-visibility: a non-zero incident count NEVER hides in the disclosure — it sits in the
            summary, warn-toned, and tapping it opens the by-cause breakdown (one tap to the detail). A NULL
            rollup (API sent no incidents object) surfaces as an explicit "no data" here, never as absence. */}
        {m.incidents == null && (
          <div data-testid="trust-incidents-nodata-summary">
            <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">Incidents</div>
            <div className="sw-mono text-[13px] text-[var(--color-ink-faint)]">— no data</div>
          </div>
        )}
        {m.incidents != null && m.incidents.total > 0 && (
          <button
            type="button"
            onClick={() => {
              // Already open → the effect won't re-fire (no state change); scroll now instead of arming the
              // ref, which would otherwise go stale and cause a spurious scroll on a later toggle-open.
              if (detailsOpen) {
                document.getElementById("trust-details-body")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
              } else {
                scrollToDetails.current = true;
                setDetailsOpen(true);
              }
            }}
            className="cursor-pointer text-left"
            title="Incidents in this window — tap for the by-cause breakdown"
            data-testid="trust-incidents-count"
          >
            <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">Incidents</div>
            <div className="sw-mono text-[13px] font-medium" style={{ color: TONE_VAR.warn }}>
              {m.incidents.total} ›
            </div>
          </button>
        )}
        {/* spec integrity, short form — the full 64-char hash wrapped to two lines on mobile for a value
            nobody reads at a glance. Short sha here + copy affordance; the full hash lives in Details. */}
        {sha && (
          <div data-testid="trust-spec-short">
            <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">Spec</div>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(sha);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="sw-mono cursor-pointer text-[13px] text-[var(--color-ink)]"
              title={`SHA-256 of the assertion code that ran — tap to copy the full hash\n${sha}`}
              data-testid="trust-spec-copy"
            >
              {sha.slice(0, 8)}{" "}
              {copied ? (
                <span className="text-[11px]" style={{ color: TONE_VAR.pass }} data-testid="trust-spec-copied">
                  ✓ copied
                </span>
              ) : (
                <span aria-hidden className="text-[var(--color-ink-faint)]">⧉</span>
              )}
            </button>
          </div>
        )}
      </div>

      {/* ONE disclosure over the forensic layer — the same chevron mechanism as the Metrics section. */}
      <div className="mt-3 border-t border-[var(--color-border)] pt-2.5">
        <button
          type="button"
          onClick={() => setDetailsOpen(!detailsOpen)}
          aria-expanded={detailsOpen}
          aria-controls="trust-details-body"
          data-testid="trust-details-toggle"
          className="group flex w-full items-center gap-2 text-left text-[12px] font-medium text-[var(--color-ink)]"
        >
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            className="h-3 w-3 shrink-0 text-[var(--color-ink-dim)] transition-transform"
            style={{ transform: detailsOpen ? "rotate(90deg)" : "none" }}
          >
            <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Details
          <span className="ml-0.5 text-[10px] font-normal uppercase tracking-wider text-[var(--color-ink-faint)]">
            retry trend · incidents by cause · spec integrity
          </span>
        </button>
        {detailsOpen && (
          <div id="trust-details-body" data-testid="trust-details-body" className="mt-3 space-y-4">
            <RetrySparkline series={data.retry_series} />

            <div>
              <h4 className="mb-2 text-[11px] uppercase tracking-wider text-[var(--color-ink-faint)]">Incidents by cause</h4>
              <IncidentBreakdown incidents={m.incidents} />
            </div>

            {/* Spec provenance — an INTEGRITY fact (the committed assertion code that actually ran), NOT a red-test. */}
            {sha && (
              <div className="border-t border-[var(--color-border)] pt-3" data-testid="trust-provenance">
                <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
                  Spec integrity · executed code
                </div>
                {m.spec_provenance.spec_path && (
                  <div className="sw-mono text-[11px] text-[var(--color-ink-dim)]">{m.spec_provenance.spec_path}</div>
                )}
                <div className="sw-mono break-all text-[11px] text-[var(--color-ink)]" title="SHA-256 of the assertion code that ran">
                  {sha}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ── fleet scorecard (the /reports "Trust" tab) ───────────────────────────────────────────────────────────

// reds: real-outage vs everything-else (monitor-noise + env/perf/unclassified). ★ real is ONLY real_outage —
// perf-regression + unclassified are NEVER folded into "real" (the honesty the scorecard exists for).
function redsText(row: TrustRow): string {
  if (row.incidents == null || row.incidents.total === 0) return "—"; // null (no rollup) + zero both → "—"
  const other = row.incidents.total - row.incidents.real_outage;
  return `${row.incidents.real_outage} / ${other}`;
}

// mobile: 2-col wrap; sm+: the full scorecard template. Header (sm+ only) uses the template directly.
const SCORECARD_TEMPLATE = "sm:grid-cols-[1fr_110px_130px_90px_110px_120px]";

/**
 * The fleet trust scorecard — the "every green with its proof" table + the rule legend. Rendered under the
 * /reports "Trust" tab (D1 v2 relocated it from a top-level route). `window` comes from the reports page's
 * shared window control. Null-safe: 404 → a quiet "unavailable" (legend still shows). Sorted worst-first.
 */
export function TrustScorecard({ window }: { window: ReportWindow }) {
  const { data, isLoading, error, isValidating, mutate } = useTrustReport(window);
  const fetchedAt = useFetchedAt(isValidating, data != null);

  const sorted = [...(data?.monitors ?? [])].sort(
    (a, b) => TRUST_RANK[a.trust] - TRUST_RANK[b.trust] || a.check_name.localeCompare(b.check_name),
  );

  return (
    <div className="space-y-3" data-testid="trust-scorecard">
      {/* ★ Staleness: this fetch-once audit view was the app's least-fresh surface — stamp its fetch time +
          a manual refresh (it also revalidates on focus now). Only shown once data has landed. */}
      {data && (
        <div className="flex justify-end">
          <StalenessStamp fetchedAt={fetchedAt} onRefresh={() => mutate()} refreshing={isValidating} testId="trust" />
        </div>
      )}
      <TrustLegend />

      {/* ★ Loud-not-silent: a 500/network error is a distinct, visible state — NOT the "unavailable" empty
          (which is the honest 404-absent state). A monitoring scorecard must not vanish/blank on incident day. */}
      {error ? (
        <ErrorState testId="trust-error" message="Trust scorecard failed to load — retry." />
      ) : isLoading && !data ? (
        <div className="py-16"><Spinner label="Building trust scorecard…" /></div>
      ) : !data ? (
        <EmptyState title="Trust data unavailable." hint="The trust report endpoint isn’t reachable right now." />
      ) : sorted.length === 0 ? (
        <EmptyState title="No monitors to score yet." hint="Create a monitor to start collecting trust evidence." />
      ) : (
        <div className="sw-panel overflow-hidden" data-testid="trust-table">
          <div className="hidden grid-cols-[1fr_110px_130px_90px_110px_120px] gap-3 border-b border-[var(--color-border)] px-4 py-2.5 text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)] sm:grid">
            <span>Monitor</span>
            <span>Last green</span>
            <span>Retry rate</span>
            <span className="text-right">Reds r/n</span>
            <span>Red-tested</span>
            <span>Trust</span>
          </div>
          <div className="divide-y divide-[var(--color-border)]">
            {sorted.map((row) => {
              const neverGreen = row.last_green_at == null;
              return (
                <div
                  key={row.check_id}
                  data-testid={`trust-row-${row.check_id}`}
                  className={`grid grid-cols-2 ${SCORECARD_TEMPLATE} items-center gap-x-3 gap-y-1 px-4 py-2.5`}
                >
                  <div className="col-span-2 min-w-0 sm:col-span-1">
                    <Link
                      href={`/checks/${row.check_id}`}
                      className="block truncate text-[13px] font-medium text-[var(--color-ink)] hover:text-[var(--color-brand)]"
                      title={row.check_name}
                    >
                      {row.check_name}
                    </Link>
                    {/* ★ B3-2: the distinct dimensions — the surfaced replacement for the OR-collapse. Under the
                        name so a Director sees WHICH axis flags at a glance, not just the collapsed chip. */}
                    <div className="mt-0.5">
                      <DimensionStrip row={row} />
                    </div>
                    {/* degrading-but-green + transient-flap annotations — distinct from the chip + the dimensions */}
                    <RetriedPassesNote retriedPasses={row.retried_passes} window={window} />
                    <FlapNote flapCount={row.flap_count} scheduledCount={row.scheduled_count} window={window} />
                    {/* ★ B3-3: the MONITOR trust budget — "degraded as a monitor" + the directed fix task (distinct
                        from a service alert), and the honest indeterminate caveat. */}
                    <FlakeBudgetNote fb={row.flake_budget} />
                  </div>
                  <span
                    className={`text-[12px] ${neverGreen ? "font-medium text-[var(--color-ink-dim)]" : "text-[var(--color-ink-dim)]"}`}
                    data-testid={`trust-lastgreen-${row.check_id}`}
                  >
                    {lastGreenText(row.last_green_at)}
                  </span>
                  <span className="sw-mono text-[12px] text-[var(--color-ink-dim)]" data-testid={`trust-retry-${row.check_id}`}>
                    {retryRateText(row)}
                  </span>
                  <span
                    className="sw-mono text-right text-[12px] text-[var(--color-ink-dim)]"
                    title="real outage / other (noise, env, perf, unclassified)"
                    data-testid={`trust-reds-${row.check_id}`}
                  >
                    {redsText(row)}
                  </span>
                  <RedTestStatus
                    captured={row.red_test_captured}
                    testedAt={row.red_test_tested_at}
                    method={row.red_test_method}
                  />
                  <TrustChipBadge chip={row.trust} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
