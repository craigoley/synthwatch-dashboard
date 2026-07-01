"use client";

import { useState } from "react";
import Link from "next/link";

import { useTrustReport } from "@/lib/client";
import { EmptyState, Spinner } from "@/components/states";
import {
  TrustChipBadge,
  TrustLegend,
  RedTestNotCaptured,
  TRUST_RANK,
  retryRateText,
  lastGreenText,
} from "@/components/trust";
import type { ReportWindow, TrustRow } from "@/lib/types";

const WINDOWS: ReportWindow[] = ["7d", "30d", "90d"];

// reds: real-outage vs everything-else (monitor-noise + env/perf/unclassified). ★ real is ONLY real_outage —
// perf-regression + unclassified are NEVER folded into "real" (the honesty the scorecard exists for).
function redsText(row: TrustRow): string {
  if (row.incidents.total === 0) return "—";
  const other = row.incidents.total - row.incidents.real_outage;
  return `${row.incidents.real_outage} / ${other}`;
}

// mobile: 2-col wrap; sm+: the full scorecard template. Header (sm+ only) uses the template directly.
const TEMPLATE = "sm:grid-cols-[1fr_110px_130px_90px_110px_120px]";

export default function TrustPage() {
  const [window, setWindow] = useState<ReportWindow>("30d");
  const { data, isLoading } = useTrustReport(window);

  // Worst-first: unverified + flaky lead so a Director scans the problems first; ties broken by name.
  const sorted = [...(data?.monitors ?? [])].sort(
    (a, b) => TRUST_RANK[a.trust] - TRUST_RANK[b.trust] || a.check_name.localeCompare(b.check_name),
  );

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="sw-eyebrow">Reporting</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Monitor trust</h1>
          <p className="mt-1 text-sm text-[var(--color-ink-dim)]">
            Every green shown with its proof — measured facts + an auditable chip. No composite score.
          </p>
        </div>
        <div className="inline-flex rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] p-0.5" role="group" aria-label="window">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              aria-pressed={w === window}
              onClick={() => setWindow(w)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                w === window ? "bg-[var(--color-panel-2)] text-[var(--color-ink)]" : "text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
              }`}
            >
              {w}
            </button>
          ))}
        </div>
      </header>

      <TrustLegend />

      {isLoading && !data ? (
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
                  className={`grid grid-cols-2 ${TEMPLATE} items-center gap-x-3 gap-y-1 px-4 py-2.5`}
                >
                  <Link
                    href={`/checks/${row.check_id}`}
                    className="col-span-2 truncate text-[13px] font-medium text-[var(--color-ink)] hover:text-[var(--color-brand)] sm:col-span-1"
                    title={row.check_name}
                  >
                    {row.check_name}
                  </Link>
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
                  <RedTestNotCaptured />
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
