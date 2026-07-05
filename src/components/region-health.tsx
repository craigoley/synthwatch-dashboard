"use client";

import { useRegionHealth } from "@/lib/client";
import { ErrorState } from "@/components/states";
import { formatDuration, formatRelative } from "@/lib/format";
import type { RegionHealthRow, RegionHealthStatus } from "@/lib/types";

/**
 * Region health (the F-4 pair: api #168 serves it, this renders it). Per-region run FRESHNESS — the
 * visible alarm for a silently-dead region. Quorum semantics hide the failure today: when a region stops
 * reporting, the remaining regions keep every check green, so nothing on any page says "eastus2 has been
 * silent for 3 hours". This panel says exactly that, at ops-glance level on /status.
 *
 * Four honest states, none silent (#175/#177 discipline):
 *   fresh          → calm pass row (age shown — proof of life, not just a green dot)
 *   stale          → ★ THE ALARM: loud fail-toned banner row, visually unlike any trust chip
 *   never_reported → its own neutral-warn state (a CONFIGURED region with no data ever — not stale,
 *                    not an error, and its age is "—", never a fabricated 0/now)
 *   fetch error    → loud ErrorState (an alarm panel silently blank on incident day = F-4 again)
 * A 404 (endpoint not deployed in this env) → the section hides cleanly.
 */

const STATUS_META: Record<
  RegionHealthStatus,
  { label: string; tone: "pass" | "warn" | "fail"; blurb: (r: RegionHealthRow) => string }
> = {
  fresh: {
    label: "fresh",
    tone: "pass",
    blurb: (r) => (r.age_seconds != null ? `last run ${formatDuration(r.age_seconds * 1000)} ago` : "reporting"),
  },
  stale: {
    label: "STALE — region silent",
    tone: "fail",
    blurb: (r) =>
      r.age_seconds != null
        ? `no runs for ${formatDuration(r.age_seconds * 1000)}${r.last_run_at ? ` (last ${formatRelative(r.last_run_at)})` : ""}`
        : "no recent runs",
  },
  never_reported: {
    label: "never reported",
    tone: "warn",
    blurb: () => "configured, but no run has ever arrived from this region",
  },
};

function RegionRow({ r }: { r: RegionHealthRow }) {
  const meta = STATUS_META[r.status];
  const alarm = r.status === "stale";
  return (
    <div
      data-testid={`region-health-${r.region}`}
      data-status={r.status}
      className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border px-3 py-2 ${alarm ? "border-l-4" : ""}`}
      style={{
        // ★ The stale row is the alarm — a filled, fail-toned banner (deliberately NOT a chip: chips are
        // per-monitor trust vocabulary; a dead REGION is an infrastructure-level signal and must read louder).
        borderColor: alarm
          ? "var(--color-fail)"
          : "color-mix(in srgb, var(--color-border) 100%, transparent)",
        background: alarm ? "color-mix(in srgb, var(--color-fail) 12%, transparent)" : "var(--color-bg)",
      }}
    >
      <span className="sw-mono min-w-0 truncate text-[13px] font-medium text-[var(--color-ink)]">{r.region}</span>
      <span
        className="sw-mono text-[11px] font-semibold uppercase tracking-wider"
        style={{ color: `var(--color-${meta.tone})` }}
      >
        {meta.label}
      </span>
      <span className="text-[12px] text-[var(--color-ink-dim)]">{meta.blurb(r)}</span>
    </div>
  );
}

export function RegionHealthSection() {
  const { data, error } = useRegionHealth();
  // ★ Loud-not-silent (#175): a 500/network error shows a visible state — THIS panel going blank is the
  // exact silently-dead-region failure mode it exists to kill. A 404 → data null → hide (feature absent).
  if (error) {
    return (
      <section data-testid="region-health-section">
        <h2 className="mb-2 text-sm font-semibold tracking-tight text-[var(--color-ink)]">Region health</h2>
        <ErrorState testId="region-health-error" message="Region health failed to load — retry." />
      </section>
    );
  }
  if (!data || data.regions.length === 0) return null;

  return (
    <section className="space-y-3" data-testid="region-health-section">
      <h2 className="text-sm font-semibold tracking-tight text-[var(--color-ink)]">Region health</h2>
      <p className="text-[11px] text-[var(--color-ink-faint)]">
        Freshness of each probe region. A silent region doesn&apos;t fail checks — the other regions keep them
        green — so staleness here is the only place a dead region shows.
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        {data.regions.map((r) => (
          <RegionRow key={r.region} r={r} />
        ))}
      </div>
    </section>
  );
}
