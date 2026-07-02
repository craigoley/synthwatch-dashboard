"use client";

import { useMttrReport } from "@/lib/client";
import { ErrorState } from "@/components/states";
import { formatDuration } from "@/lib/format";
import type { ReportWindow, Tag, MttrFleet, MttrClassificationBucket, MttrTrendPoint } from "@/lib/types";

// Shared "status-color LAW" for rca.classification (mirrors incident-breakdown-card's META): real = red,
// env/perf = warn, selector-drift = a monitor bug (brand), flaky/unclassified = idle/unknown.
const META: Record<string, { label: string; tone: string }> = {
  "real-outage": { label: "Real outage", tone: "fail" },
  "environment-regional": { label: "Environment / regional", tone: "warn" },
  "perf-regression": { label: "Perf regression", tone: "warn" },
  "selector-drift": { label: "Selector drift — monitor bug", tone: "brand" },
  "flaky-transient": { label: "Flaky / transient", tone: "idle" },
  unclassified: { label: "Unclassified", tone: "idle" },
};
const metaOf = (c: string) => META[c] ?? { label: c, tone: "idle" };

// MTTR is transported in SECONDS; formatDuration takes ms. Null → an honest em-dash, never "0s".
const fmtDur = (sec: number | null | undefined) => (sec == null ? "—" : formatDuration(sec * 1000));
const pct = (n: number) => `${Math.round((n ?? 0) * 100)}%`;

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">{label}</div>
      <div className="sw-mono text-2xl font-medium tabular-nums text-[var(--color-ink)]">{value}</div>
      {hint && <div className="text-[11px] text-[var(--color-ink-dim)]">{hint}</div>}
    </div>
  );
}

function FleetTile({ fleet }: { fleet: MttrFleet }) {
  return (
    <div className="sw-panel p-4" data-testid="fleet-mttr-rollup">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--color-ink)]">Time to resolve · fleet</h3>
        <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
          {fleet.resolved_count} resolved · {fleet.open_count} open
        </span>
      </div>
      {fleet.insufficient_data ? (
        <p className="text-[13px] text-[var(--color-ink-dim)]" data-testid="fleet-mttr-building">
          Not enough resolved incidents in this window yet for a reliable MTTR.
        </p>
      ) : (
        <div className="flex flex-wrap gap-x-8 gap-y-2">
          <Stat label="Median" value={fmtDur(fleet.median_seconds)} hint="typical" />
          <Stat label="Mean" value={fmtDur(fleet.mean_seconds)} hint="incl. long tail" />
          <Stat label="Detection lag" value={fmtDur(fleet.mttd_proxy_seconds)} hint="proxy" />
        </div>
      )}
    </div>
  );
}

function ClassificationBars({ buckets }: { buckets: MttrClassificationBucket[] }) {
  if (buckets.length === 0) return null;
  return (
    <div className="sw-panel p-4" data-testid="fleet-mttr-classification">
      <h3 className="mb-3 text-sm font-semibold text-[var(--color-ink)]">Incidents by classification</h3>
      <ul className="space-y-2">
        {buckets.map((b) => {
          const m = metaOf(b.classification);
          return (
            <li key={b.classification} className="flex items-center gap-3">
              <span className="w-40 shrink-0 truncate text-[12px] text-[var(--color-ink-dim)]">{m.label}</span>
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--color-bg)]">
                <span className="block h-full rounded-full" style={{ width: pct(b.pct_of_total), background: `var(--color-${m.tone})` }} />
              </span>
              <span className="sw-mono w-20 shrink-0 text-right text-[11px] text-[var(--color-ink-dim)]">
                {b.count} · {pct(b.pct_of_total)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TrendSparkline({ trend }: { trend: MttrTrendPoint[] }) {
  const pts = trend.filter((p) => p.mean_seconds != null);
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (pts.length < 2 || !first || !last) return null; // a trend needs ≥2 buckets to read as "getting faster/slower"
  const max = Math.max(...pts.map((p) => p.mean_seconds as number), 1);
  return (
    <div className="sw-panel p-4" data-testid="fleet-mttr-trend">
      <h3 className="mb-3 text-sm font-semibold text-[var(--color-ink)]">MTTR trend</h3>
      <div className="flex items-end gap-1" style={{ height: 48 }}>
        {pts.map((p) => (
          <span
            key={p.bucket_start}
            title={`${p.bucket_start.slice(0, 10)} · ${fmtDur(p.mean_seconds)} · ${p.resolved_count} resolved`}
            className="flex-1 rounded-t bg-[var(--color-brand)]"
            style={{ height: `${Math.max(4, ((p.mean_seconds as number) / max) * 100)}%` }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-[var(--color-ink-faint)]">
        <span>{first.bucket_start.slice(0, 10)}</span>
        <span>{last.bucket_start.slice(0, 10)}</span>
      </div>
    </div>
  );
}

// Fleet MTTR / incident analytics (§A5). MTTR over RESOLVED incidents (open excluded, counted); median + mean
// (skew visible); classification bars; trend. ★ Null-safe throughout (the .tone-crash lesson): endpoint-absent
// → hide; null mean/median → "—"; empty classification/trend → their panels hide; unknown classification → idle.
export function FleetMttrReport({ window, tags = [] }: { window: ReportWindow; tags?: Tag[] }) {
  const { data, error } = useMttrReport(window, tags);
  // ★ Loud-not-silent: a 500/network error shows a visible state, never a blank that reads as "not deployed".
  if (error) return <ErrorState testId="fleet-mttr-error" message="Incident analytics failed to load — retry." />;
  if (!data) return null; // 404 → null → hide quietly (feature absent, correct)

  const fleet = data.fleet;
  if (!fleet || fleet.total_incidents === 0) {
    // Scoped-empty is honest; globally-empty (no incidents at all — good news) hides to avoid clutter.
    if (tags.length === 0) return null;
    return (
      <section className="sw-panel p-4" data-testid="fleet-mttr">
        <h3 className="mb-1 text-sm font-semibold text-[var(--color-ink)]">Time to resolve</h3>
        <p className="text-[13px] text-[var(--color-ink-dim)]">No incidents match this filter in {window}.</p>
      </section>
    );
  }

  // Slowest mean first; null MTTR (thin) sorts last — attention items lead.
  const sorted = [...data.items].sort((a, b) => {
    const av = a.mean_seconds;
    const bv = b.mean_seconds;
    if (av == null && bv == null) return a.check_name.localeCompare(b.check_name);
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av || a.check_name.localeCompare(b.check_name);
  });

  return (
    <section className="space-y-3" data-testid="fleet-mttr">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">Incident analytics — time to resolve</h2>
        <span className="text-[11px] text-[var(--color-ink-faint)]">
          MTTR over resolved incidents · {window} · open excluded from the mean
        </span>
      </div>
      <FleetTile fleet={fleet} />
      <ClassificationBars buckets={data.classification} />
      <TrendSparkline trend={data.trend} />
      {sorted.length > 0 && (
        <div className="sw-panel overflow-hidden" data-testid="fleet-mttr-checks">
          <div className="hidden grid-cols-[1fr_80px_80px_60px] gap-3 border-b border-[var(--color-border)] px-4 py-2.5 text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)] sm:grid">
            <span>Monitor</span>
            <span className="text-right">Median</span>
            <span className="text-right">Mean</span>
            <span className="text-right">Open</span>
          </div>
          <div className="divide-y divide-[var(--color-border)]">
            {sorted.map((row) => (
              <div key={row.check_id} data-testid={`mttr-row-${row.check_id}`} className="grid grid-cols-[1fr_80px_80px_60px] items-center gap-3 px-4 py-2.5">
                <span className="truncate text-[13px] text-[var(--color-ink)]" title={row.check_name}>{row.check_name}</span>
                <span className="sw-mono text-right text-[12px] text-[var(--color-ink-dim)]">{fmtDur(row.median_seconds)}</span>
                <span className="sw-mono text-right text-[12px] text-[var(--color-ink-dim)]">{fmtDur(row.mean_seconds)}</span>
                <span className="sw-mono text-right text-[12px] text-[var(--color-ink-dim)]">{row.open_count || "—"}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
