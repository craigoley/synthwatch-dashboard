"use client";

import { useStatus } from "@/lib/client";
import { TONE_VAR } from "@/components/status-badge";
import { formatPct } from "@/lib/format";
import type { StatusProperty } from "@/lib/types";

// ★ Property-level rollup (§A3) for the status page — stakeholders think in PROPERTIES (wegmans.com, meals2go),
// not individual checks (that's the "Components" list below). Driven by GET /status (server curates to
// property level — no raw check ids/URLs). ★ current-STATE badge is worded + colored separately from the
// historical uptime % so a green "Operational" can't be read as a claim about the window's availability.

type Tone = "pass" | "warn" | "fail" | "idle";

const STATE_META: Record<StatusProperty["state"], { label: string; tone: Tone }> = {
  up: { label: "Operational", tone: "pass" },
  degraded: { label: "Degraded", tone: "warn" },
  down: { label: "Down", tone: "fail" },
  unknown: { label: "No data", tone: "idle" },
};

function StateBadge({ state }: { state: StatusProperty["state"] }) {
  const m = STATE_META[state] ?? STATE_META.unknown;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-medium"
      style={{ color: TONE_VAR[m.tone], background: `color-mix(in srgb, ${TONE_VAR[m.tone]} 12%, transparent)` }}
      data-testid={`status-badge-${state}`}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: TONE_VAR[m.tone] }} />
      {m.label}
    </span>
  );
}

function PropertyCard({ p }: { p: StatusProperty }) {
  const showPct = !p.building_baseline && p.uptime_pct != null;
  return (
    <div className="sw-panel p-4" data-testid={`status-property-${p.name}`}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="truncate text-sm font-semibold text-[var(--color-ink)]" title={p.name}>{p.name}</h3>
        <StateBadge state={p.state} />
      </div>
      <div className="mt-3 flex items-baseline justify-between gap-2">
        <div>
          {/* HISTORICAL uptime — labelled distinctly from the NOW badge above. */}
          <div className="sw-mono text-xl font-medium tabular-nums text-[var(--color-ink)]" data-testid={`status-uptime-${p.name}`}>
            {showPct ? formatPct(p.uptime_pct as number, 2) : "—"}
          </div>
          <div className="text-[11px] text-[var(--color-ink-dim)]">
            {p.building_baseline ? "building baseline" : "30-day uptime"}
          </div>
        </div>
        <div className="text-right text-[11px] text-[var(--color-ink-dim)]" data-testid={`status-breakdown-${p.name}`}>
          {p.check_count} {p.check_count === 1 ? "check" : "checks"}
          {p.down_count > 0 && <span style={{ color: TONE_VAR.fail }}> · {p.down_count} down</span>}
          {p.degraded_count > 0 && <span style={{ color: TONE_VAR.warn }}> · {p.degraded_count} degraded</span>}
        </div>
      </div>
    </div>
  );
}

// ★ Null-safe (the .tone-crash lesson): endpoint absent (null) / still loading / zero curated properties →
// the section renders NOTHING, so the existing status page is unaffected. unknown state → the idle fallback;
// null/building uptime → an em-dash (never a fabricated %).
export function PropertyStatusSection() {
  const { data } = useStatus();
  if (!data || data.properties.length === 0) return null;

  return (
    <section className="space-y-3" data-testid="status-properties-section">
      <h2 className="text-sm font-semibold tracking-tight text-[var(--color-ink)]">By property</h2>
      <div className="grid gap-3 sm:grid-cols-2" data-testid="status-properties">
        {data.properties.map((p) => (
          <PropertyCard key={p.name} p={p} />
        ))}
      </div>
    </section>
  );
}
