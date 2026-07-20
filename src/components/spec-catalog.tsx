"use client";

/**
 * The spec-catalog rendering — extracted from the former /specs page so it can live inside the merged
 * /monitors page (the "New monitors" section + its "Browse the full catalog" reveal). Repo=truth: this shows
 * what Git DECLARES; the catalog is a ~24h reconcile-cron snapshot, so its callers stamp it "as of …".
 *
 * ★ TWO ORTHOGONAL DIMENSIONS (don't collapse to one badge):
 *  - COVERAGE: Unmonitored (no check) / Active / Paused / Archived / Removed.
 *  - RUNNABLE?: ✓ Runnable / ⚠ Orphan (not fetchable+compilable from main; reason shown).
 */

import { useState } from "react";
import Link from "next/link";

import { StatusDot } from "@/components/status-badge";
import { useAuth } from "@/components/auth-provider";
import { formatDuration } from "@/lib/format";
import { daysUntilPurge } from "@/lib/status";
import type { SpecCatalogEntry, SpecCoverage } from "@/lib/types";

export function coverageOf(s: SpecCatalogEntry): SpecCoverage {
  if (!s.monitored) return "unmonitored";
  if (s.removed_at) return "removed"; // git-removed (0072) — purging; supersedes archive/active/paused
  if (s.archived_at) return "archived"; // reversible archive (0071) — takes precedence over active/paused
  return s.enabled ? "active" : "paused";
}

const COVERAGE_META: Record<SpecCoverage, { label: string; tone: string }> = {
  active: { label: "Active", tone: "var(--color-pass)" },
  paused: { label: "Paused", tone: "var(--color-idle)" },
  archived: { label: "Archived", tone: "var(--color-ink-faint)" },
  removed: { label: "Removed", tone: "var(--color-fail)" },
  unmonitored: { label: "Unmonitored", tone: "var(--color-ink-faint)" },
};

// ── Filter / sort over the catalog (PURE UI, LOCAL state — the former /specs URL-sync is dropped now that
//    the catalog lives inside /monitors, whose own TagFilter already owns ?tags=). ──
type SpecSortCol = "name" | "coverage" | "p95" | "interval";
interface SpecSort {
  col: SpecSortCol;
  dir: "asc" | "desc";
}
const DEFAULT_SORT: SpecSort = { col: "name", dir: "asc" };
export const SPEC_SORTS: { col: SpecSortCol; label: string }[] = [
  { col: "name", label: "Name" },
  { col: "coverage", label: "Coverage" },
  { col: "p95", label: "p95" },
  { col: "interval", label: "Interval" },
];
// Coverage order for the "coverage" sort: not-set-up first, then paused, then active.
const COVERAGE_RANK: Record<SpecCoverage, number> = { unmonitored: 0, removed: 1, archived: 2, paused: 3, active: 4 };

/** Sort comparator. Health/interval are absent on unmonitored rows → NULLS LAST regardless of dir; name is
 *  the stable tiebreak so the order is deterministic. */
export function compareSpec(a: SpecCatalogEntry, b: SpecCatalogEntry, col: SpecSortCol, dir: "asc" | "desc"): number {
  const s = dir === "asc" ? 1 : -1;
  const byName = a.name.localeCompare(b.name);
  if (col === "name") return byName * s;
  if (col === "coverage") return (COVERAGE_RANK[coverageOf(a)] - COVERAGE_RANK[coverageOf(b)]) * s || byName;
  const av = col === "p95" ? (a.health?.p95_ms ?? null) : a.suggested_interval_seconds;
  const bv = col === "p95" ? (b.health?.p95_ms ?? null) : b.suggested_interval_seconds;
  if (av == null && bv == null) return byName;
  if (av == null) return 1; // nulls last, regardless of dir
  if (bv == null) return -1;
  return (av - bv) * s || byName;
}

export function useSpecFilters() {
  const [tags, setTags] = useState<string[]>([]);
  const [sort, setSortState] = useState<SpecSort>(DEFAULT_SORT);
  return {
    tags,
    sort,
    toggleTag: (t: string) => setTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t])),
    clearTags: () => setTags([]),
    setSort: (col: SpecSortCol) =>
      setSortState((prev) =>
        prev.col === col
          ? { col, dir: prev.dir === "asc" ? "desc" : "asc" }
          : { col, dir: col === "p95" || col === "interval" ? "desc" : "asc" },
      ),
  };
}
export type SpecFilters = ReturnType<typeof useSpecFilters>;

function CoverageBadge({ coverage, removedAt }: { coverage: SpecCoverage; removedAt?: string | null }) {
  const meta = COVERAGE_META[coverage];
  const daysLeft = coverage === "removed" ? daysUntilPurge(removedAt) : null;
  return (
    <span
      data-testid="spec-coverage"
      data-coverage={coverage}
      title={daysLeft != null ? `Git-removed — hard-deletes in ${daysLeft} day${daysLeft === 1 ? "" : "s"}` : undefined}
      className="sw-mono inline-flex w-fit shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
      style={{
        color: meta.tone,
        background: `color-mix(in srgb, ${meta.tone} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${meta.tone} 34%, transparent)`,
      }}
    >
      {meta.label}
      {daysLeft != null && <span className="ml-1 normal-case opacity-80">· purging {daysLeft}d</span>}
    </span>
  );
}

/** ✓ Runnable / ⚠ Orphan. Orphan is NEUTRAL (idle gray) — a known gap, not an alarm. */
function RunnableCell({ entry }: { entry: SpecCatalogEntry }) {
  if (entry.runnable) {
    return (
      <span data-testid="spec-runnable" data-runnable="true" className="inline-flex items-center gap-1.5 text-[13px] text-[var(--color-ink-dim)]">
        <span aria-hidden style={{ color: "var(--color-pass)" }}>✓</span> Runnable
      </span>
    );
  }
  return (
    <span
      data-testid="spec-runnable"
      data-runnable="false"
      className="inline-flex min-w-0 items-start gap-1.5 text-[13px] text-[var(--color-ink-dim)]"
      title={entry.not_runnable_reason ?? undefined}
    >
      <span aria-hidden style={{ color: "var(--color-idle)" }}>⚠</span>
      <span className="min-w-0">
        Orphan
        {entry.not_runnable_reason && (
          <span className="sw-mono block truncate text-[11px] text-[var(--color-ink-faint)]">
            {entry.not_runnable_reason}
          </span>
        )}
      </span>
    </span>
  );
}

/** Health for an ACTIVE spec only (status dot + p95). Unmonitored/Paused → a dash. */
function HealthCell({ entry }: { entry: SpecCatalogEntry }) {
  if (coverageOf(entry) !== "active" || !entry.health) {
    return <span className="text-[13px] text-[var(--color-ink-faint)]">—</span>;
  }
  const h = entry.health;
  return (
    <span className="flex items-center gap-2">
      <StatusDot status={h.current_status} />
      <span className="sw-mono text-[12px] text-[var(--color-ink-dim)]">{formatDuration(h.p95_ms)}</span>
      {h.open_incident_count > 0 && (
        <span className="sw-mono text-[11px]" style={{ color: "var(--color-fail)" }} title="open incidents">
          ●{h.open_incident_count}
        </span>
      )}
    </span>
  );
}

/**
 * Action: "Set up monitor" — only on UNMONITORED rows. DISABLED for an ORPHAN (runnable=false) with the probe
 * reason, so a knowingly-broken spec can't be activated into a monitor that infra-errors every tick.
 */
function ActionCell({ entry, onActivate }: { entry: SpecCatalogEntry; onActivate: (e: SpecCatalogEntry) => void }) {
  const { canWrite } = useAuth();
  if (!canWrite) return <span className="text-[13px] text-[var(--color-ink-faint)]">—</span>;
  if (entry.monitored) return <span className="text-[13px] text-[var(--color-ink-faint)]">—</span>;
  const disabled = !entry.runnable;
  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        data-testid={`setup-${entry.source_key}`}
        disabled={disabled}
        title={disabled ? (entry.not_runnable_reason ?? "This spec isn't runnable yet.") : undefined}
        onClick={() => onActivate(entry)}
        className="sw-btn sw-btn-sm sw-btn-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        Set up monitor
      </button>
      {disabled && (
        <span className="text-[11px] text-[var(--color-ink-faint)]" data-testid={`setup-blocked-${entry.source_key}`}>
          Fix the spec in Git first.
        </span>
      )}
    </div>
  );
}

export function SpecRow({ entry, onActivate }: { entry: SpecCatalogEntry; onActivate: (e: SpecCatalogEntry) => void }) {
  return (
    <div
      data-testid={`spec-row-${entry.source_key}`}
      data-coverage={coverageOf(entry)}
      data-runnable={entry.runnable}
      className="grid grid-cols-1 gap-2 px-4 py-3 sm:grid-cols-[1fr_120px_170px_150px_120px_150px] sm:items-center sm:gap-3"
    >
      <div className="min-w-0">
        <span className="block truncate text-sm font-medium text-[var(--color-ink)]">{entry.name}</span>
        <span className="sw-mono block truncate text-[11px] text-[var(--color-ink-faint)]">{entry.spec_path}</span>
      </div>
      <CoverageBadge coverage={coverageOf(entry)} removedAt={entry.removed_at} />
      <RunnableCell entry={entry} />
      {entry.check_id != null ? (
        <Link href={`/checks/${entry.check_id}`} className="truncate text-[13px] text-[var(--color-brand)] hover:underline">
          {entry.check_name ?? `#${entry.check_id}`}
        </Link>
      ) : (
        <span className="text-[13px] text-[var(--color-ink-faint)]">—</span>
      )}
      <HealthCell entry={entry} />
      <ActionCell entry={entry} onActivate={onActivate} />
    </div>
  );
}

/** The panel + column header + rows. Reused by BOTH the un-activated list and the full-catalog reveal. */
export function SpecTable({
  items,
  onActivate,
  testId = "spec-catalog",
}: {
  items: SpecCatalogEntry[];
  onActivate: (e: SpecCatalogEntry) => void;
  testId?: string;
}) {
  return (
    <div className="sw-panel overflow-hidden" data-testid={testId}>
      <div className="hidden grid-cols-[1fr_120px_170px_150px_120px_150px] gap-3 border-b border-[var(--color-border)] px-4 py-2.5 text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)] sm:grid">
        <span>Spec</span>
        <span>Coverage</span>
        <span>Runnable?</span>
        <span>Linked monitor</span>
        <span>Health</span>
        <span>Action</span>
      </div>
      <div className="divide-y divide-[var(--color-border)]">
        {items.map((entry) => (
          <SpecRow key={entry.source_key} entry={entry} onActivate={onActivate} />
        ))}
      </div>
    </div>
  );
}

/** Sort + tag-filter controls for the full-catalog reveal (no view toggle — the reveal is always "all"). */
export function CatalogControls({ filters, items }: { filters: SpecFilters; items: SpecCatalogEntry[] }) {
  const tagCounts = new Map<string, number>();
  for (const s of items) for (const t of s.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  const availableTags = [...tagCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-ink-faint)]">
        <span className="uppercase tracking-wider">Sort</span>
        {SPEC_SORTS.map((s) => {
          const active = filters.sort.col === s.col;
          return (
            <button
              key={s.col}
              type="button"
              data-testid={`spec-sort-${s.col}`}
              onClick={() => filters.setSort(s.col)}
              className={`rounded-md border px-2 py-0.5 transition ${
                active
                  ? "border-[var(--color-brand-dim)] text-[var(--color-ink)]"
                  : "border-[var(--color-border-strong)] text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
              }`}
            >
              {s.label}
              {active ? (filters.sort.dir === "asc" ? " ↑" : " ↓") : ""}
            </button>
          );
        })}
      </div>
      {availableTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="spec-tag-filter">
          <span className="text-[11px] uppercase tracking-wider text-[var(--color-ink-faint)]">Tags</span>
          {availableTags.map(([tag, count]) => {
            const on = filters.tags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                role="checkbox"
                aria-checked={on}
                aria-label={`filter ${tag}`}
                data-testid={`spec-tag-${tag}`}
                onClick={() => filters.toggleTag(tag)}
                className={`sw-mono inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition ${
                  on
                    ? "border-[var(--color-brand-dim)] bg-[color-mix(in_srgb,var(--color-brand)_14%,transparent)] text-[var(--color-ink)]"
                    : "border-[var(--color-border-strong)] bg-[var(--color-bg)] text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
                }`}
              >
                {tag} <span className="text-[var(--color-ink-faint)]">{count}</span>
              </button>
            );
          })}
          {filters.tags.length > 0 && (
            <button
              type="button"
              onClick={filters.clearTags}
              data-testid="spec-clear-tags"
              className="sw-mono text-[11px] text-[var(--color-ink-faint)] transition hover:text-[var(--color-ink)]"
            >
              Clear ✕
            </button>
          )}
        </div>
      )}
    </div>
  );
}
