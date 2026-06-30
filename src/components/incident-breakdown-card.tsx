"use client";

import { useIncidentBreakdown } from "@/lib/client";
import type { ReportWindow, Tag } from "@/lib/types";

// Status-color LAW (tokens, not hex): real-outage = a true red (the site genuinely broke); env/perf = genuine
// but categorized; selector-drift = a MONITOR bug to fix (brand/attention, not red); flaky-transient +
// unclassified = low-signal/unknown (idle). Each maps to a --color-* token.
const META: Record<string, { label: string; tone: string; group: "real" | "monitor-bug" | "transient" | "unknown" }> = {
  "real-outage": { label: "Real outage", tone: "fail", group: "real" },
  "environment-regional": { label: "Environment / regional", tone: "warn", group: "real" },
  "perf-regression": { label: "Perf regression", tone: "warn", group: "real" },
  "selector-drift": { label: "Selector drift — monitor bug", tone: "brand", group: "monitor-bug" },
  "flaky-transient": { label: "Flaky / transient", tone: "idle", group: "transient" },
  unclassified: { label: "Unclassified", tone: "idle", group: "unknown" },
};

const metaOf = (c: string) => META[c] ?? { label: c, tone: "idle", group: "unknown" as const };

// Higher precision (more reds were real) = more trustworthy alerts → green; low = noisy monitors → red.
function precisionTone(p: number): string {
  if (p >= 0.8) return "pass";
  if (p >= 0.5) return "warn";
  return "fail";
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

function Shell({ window, children }: { window: ReportWindow; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">Alert quality — were the reds real?</h2>
        <span className="text-[11px] uppercase tracking-wider text-[var(--color-ink-faint)]">{window}</span>
      </div>
      {children}
    </section>
  );
}

export function IncidentBreakdownCard({ window, tags = [] }: { window: ReportWindow; tags?: Tag[] }) {
  const { data, isLoading } = useIncidentBreakdown(window, tags);

  if (isLoading || !data) {
    return (
      <Shell window={window}>
        <p className="text-sm text-[var(--color-ink-dim)]">{isLoading ? "Loading…" : "Couldn’t load the breakdown."}</p>
      </Shell>
    );
  }

  // ── Honest empty states (gaps, not fake zeros) ──
  if (data.total === 0) {
    return (
      <Shell window={window}>
        <p className="text-sm text-[var(--color-ink-dim)]">No incidents opened in this window — nothing to grade.</p>
      </Shell>
    );
  }
  if (data.precision === null) {
    // incidents exist but none are RCA-classified yet → precision is genuinely unknown, NOT 0%.
    return (
      <Shell window={window}>
        <p className="text-sm text-[var(--color-ink)]">
          <span className="font-semibold">{data.total}</span> incident{data.total === 1 ? "" : "s"} — none classified yet, so
          alert precision is unavailable.
        </p>
        <p className="mt-1 text-xs text-[var(--color-ink-faint)]">
          Precision appears once incidents get an RCA classification (real-outage vs monitor-bug vs transient).
        </p>
      </Shell>
    );
  }

  const tone = precisionTone(data.precision);

  return (
    <Shell window={window}>
      {/* ★ Lead with the alert-precision answer to "how many reds were real". */}
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-semibold tabular-nums" style={{ color: `var(--color-${tone})` }}>
          {pct(data.precision)}
        </span>
        <span className="text-sm text-[var(--color-ink-dim)]">of classified reds were real outages</span>
      </div>
      <p className="mt-1 text-xs text-[var(--color-ink-faint)]">
        {data.realOutages} of {data.classified} classified
        {data.unclassified > 0 ? ` · ${data.unclassified} not yet classified` : ""} · {data.total} total
      </p>

      {/* Per-classification breakdown */}
      <ul className="mt-4 space-y-2">
        {data.buckets.map((b) => {
          const m = metaOf(b.classification);
          return (
            <li key={b.classification} className="flex items-center gap-3">
              <span
                aria-hidden
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: `var(--color-${m.tone})` }}
              />
              <span className="w-48 shrink-0 truncate text-sm text-[var(--color-ink)]">{m.label}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-border)]">
                <div
                  className="h-full rounded-full"
                  style={{ width: pct(b.pctOfTotal), background: `var(--color-${m.tone})` }}
                />
              </div>
              <span className="w-16 shrink-0 text-right text-xs tabular-nums text-[var(--color-ink-dim)]">
                {b.count} · {pct(b.pctOfTotal)}
              </span>
            </li>
          );
        })}
      </ul>
    </Shell>
  );
}
