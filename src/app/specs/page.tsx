"use client";

/**
 * Spec catalog (Phase 13) — the inventory of every monitor Git declares (the synthwatch-monitors
 * manifest), one row per spec, with its coverage + runnable state. This is the browse home; the
 * focused "what differs from Git" alert lives in the drift surface on /monitors (they coexist — see
 * the cross-link there). ACTIVATION (steps 4-6): an UNMONITORED + runnable row gets a "Set up monitor"
 * button → MonitorForm in activation mode → POST /api/checks (with spec_path + source_key) → the row
 * flips Unmonitored→Active on re-fetch. An ORPHAN (not runnable) row's button is DISABLED with the
 * reason — don't let someone create a monitor whose spec infra-errors every tick.
 *
 * ★ TWO ORTHOGONAL DIMENSIONS (don't collapse to one badge):
 *  - COVERAGE: Unmonitored (no check) / Active (check, enabled) / Paused (check, disabled).
 *  - RUNNABLE?: ✓ Runnable / ⚠ Orphan (not fetchable+compilable from main; reason shown).
 * A spec can be Unmonitored+Orphan (today's common case) OR Active+Orphan (future), so both show.
 *
 * Graceful: data null (404 — endpoint not deployed) → a neutral "not available yet" notice; empty
 * items (reconcile hasn't populated spec_catalog) → "no specs yet, run reconcile".
 */

import { useEffect, useState } from "react";
import Link from "next/link";

import { useSpecCatalog } from "@/lib/client";
import { EmptyState, ErrorState, Spinner } from "@/components/states";
import { StatusDot } from "@/components/status-badge";
import { Modal } from "@/components/modal";
import { MonitorForm } from "@/components/monitor-form";
import { useAuth } from "@/components/auth-provider";
import { SignInToEdit } from "@/components/write-gate";
import { activationFrom } from "@/lib/specs";
import { formatDuration, formatRelative } from "@/lib/format";
import type { SpecCatalogEntry, SpecCoverage } from "@/lib/types";

function coverageOf(s: SpecCatalogEntry): SpecCoverage {
  if (!s.monitored) return "unmonitored";
  if (s.archived_at) return "archived"; // reversible archive (0071) — takes precedence over active/paused
  return s.enabled ? "active" : "paused";
}

const COVERAGE_META: Record<SpecCoverage, { label: string; tone: string }> = {
  active: { label: "Active", tone: "var(--color-pass)" },
  paused: { label: "Paused", tone: "var(--color-idle)" },
  archived: { label: "Archived", tone: "var(--color-ink-faint)" },
  unmonitored: { label: "Unmonitored", tone: "var(--color-ink-faint)" },
};

// ── Filter / sort over the catalog (PURE UI — every field is already on each row). ──
// Default view = "unmonitored" (the not-set-up specs Craig wants first). The default state (unmonitored view,
// no tags, name-asc) is the NO-QUERYSTRING state, so a plain /specs URL is the default and a filtered view is
// shareable via ?view=all&tags=…&sort=….

type SpecView = "unmonitored" | "all";
type SpecSortCol = "name" | "coverage" | "p95" | "interval";
interface SpecSort {
  col: SpecSortCol;
  dir: "asc" | "desc";
}
const DEFAULT_SORT: SpecSort = { col: "name", dir: "asc" };
const SPEC_SORTS: { col: SpecSortCol; label: string }[] = [
  { col: "name", label: "Name" },
  { col: "coverage", label: "Coverage" },
  { col: "p95", label: "p95" },
  { col: "interval", label: "Interval" },
];
// Coverage order for the "coverage" sort: not-set-up first (the page's focus), then paused, then active.
const COVERAGE_RANK: Record<SpecCoverage, number> = { unmonitored: 0, archived: 1, paused: 2, active: 3 };
const isSortCol = (v: string): v is SpecSortCol => SPEC_SORTS.some((s) => s.col === v);

/** Sort comparator. Health/interval are absent on unmonitored rows → NULLS LAST regardless of dir; name is
 *  the stable tiebreak so the order is deterministic. */
function compareSpec(a: SpecCatalogEntry, b: SpecCatalogEntry, col: SpecSortCol, dir: "asc" | "desc"): number {
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

/** URL-synced view + tag + sort state (mirrors useTagFilter's history.replaceState approach — no Suspense
 *  needed). Bare-STRING tags (spec tags are string[], not the {key,value} Tag[] the shared TagFilter uses). */
function useSpecFilters() {
  const [view, setViewState] = useState<SpecView>("unmonitored");
  const [tags, setTags] = useState<string[]>([]);
  const [sort, setSortState] = useState<SpecSort>(DEFAULT_SORT);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("view") === "all") setViewState("all");
    const t = p.get("tags");
    if (t) setTags(t.split(",").map((x) => x.trim()).filter(Boolean));
    const sc = p.get("sort");
    if (sc) {
      const [col, dir] = sc.split(":");
      if (col && isSortCol(col)) setSortState({ col, dir: dir === "desc" ? "desc" : "asc" });
    }
  }, []);

  const write = (v: SpecView, tg: string[], st: SpecSort) => {
    const url = new URL(window.location.href);
    if (v === "all") url.searchParams.set("view", "all");
    else url.searchParams.delete("view");
    if (tg.length) url.searchParams.set("tags", tg.join(","));
    else url.searchParams.delete("tags");
    if (st.col !== DEFAULT_SORT.col || st.dir !== DEFAULT_SORT.dir)
      url.searchParams.set("sort", `${st.col}:${st.dir}`);
    else url.searchParams.delete("sort");
    window.history.replaceState(null, "", url.toString());
  };

  return {
    view,
    tags,
    sort,
    setView: (v: SpecView) => { setViewState(v); write(v, tags, sort); },
    toggleTag: (t: string) => {
      const next = tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t];
      setTags(next);
      write(view, next, sort);
    },
    clearTags: () => { setTags([]); write(view, [], sort); },
    setSort: (col: SpecSortCol) => {
      const next: SpecSort =
        sort.col === col ? { col, dir: sort.dir === "asc" ? "desc" : "asc" } : { col, dir: col === "p95" || col === "interval" ? "desc" : "asc" };
      setSortState(next);
      write(view, tags, next);
    },
  };
}

function CoverageBadge({ coverage }: { coverage: SpecCoverage }) {
  const meta = COVERAGE_META[coverage];
  return (
    <span
      data-testid="spec-coverage"
      data-coverage={coverage}
      className="sw-mono inline-flex w-fit shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
      style={{
        color: meta.tone,
        background: `color-mix(in srgb, ${meta.tone} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${meta.tone} 34%, transparent)`,
      }}
    >
      {meta.label}
    </span>
  );
}

/** ✓ Runnable / ⚠ Orphan. Orphan is NEUTRAL (idle gray) — a known gap, not an alarm (mirrors #84). */
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
 * Action: "Set up monitor" — only on UNMONITORED rows (Active/Paused already have a check). DISABLED
 * for an ORPHAN (runnable=false) with the probe reason + a fix-in-Git hint, so a knowingly-broken spec
 * can't be activated into a monitor that infra-errors every tick.
 */
function ActionCell({
  entry,
  onActivate,
}: {
  entry: SpecCatalogEntry;
  onActivate: (e: SpecCatalogEntry) => void;
}) {
  const { canWrite } = useAuth();
  // Read-only viewers don't see activation (UX only — the API also gates the POST /checks write).
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

function SpecRow({
  entry,
  onActivate,
}: {
  entry: SpecCatalogEntry;
  onActivate: (e: SpecCatalogEntry) => void;
}) {
  return (
    <div
      data-testid={`spec-row-${entry.source_key}`}
      data-coverage={coverageOf(entry)}
      data-runnable={entry.runnable}
      className="grid grid-cols-1 gap-2 px-4 py-3 sm:grid-cols-[1fr_120px_170px_150px_120px_150px] sm:items-center sm:gap-3"
    >
      {/* Spec: id + path */}
      <div className="min-w-0">
        <span className="block truncate text-sm font-medium text-[var(--color-ink)]">{entry.name}</span>
        <span className="sw-mono block truncate text-[11px] text-[var(--color-ink-faint)]">{entry.spec_path}</span>
      </div>

      <CoverageBadge coverage={coverageOf(entry)} />
      <RunnableCell entry={entry} />

      {/* Linked monitor */}
      {entry.check_id != null ? (
        <Link
          href={`/checks/${entry.check_id}`}
          className="truncate text-[13px] text-[var(--color-brand)] hover:underline"
        >
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

/** The filtered/sorted catalog: the always-visible view toggle + count, the (all-view) sort + tag filter,
 *  and the table. Default view is "not set up" so the catalog opens on the specs that need attention. */
function CatalogBody({
  items,
  filters,
  onActivate,
}: {
  items: SpecCatalogEntry[];
  filters: ReturnType<typeof useSpecFilters>;
  onActivate: (e: SpecCatalogEntry) => void;
}) {
  const notSetUp = items.filter((s) => coverageOf(s) === "unmonitored");
  const base = filters.view === "unmonitored" ? notSetUp : items;
  const tagged = filters.tags.length ? base.filter((s) => filters.tags.every((t) => s.tags.includes(t))) : base;
  const shown = [...tagged].sort((a, b) => compareSpec(a, b, filters.sort.col, filters.sort.dir));

  // Distinct bare tags across ALL specs (a stable facet), with counts.
  const tagCounts = new Map<string, number>();
  for (const s of items) for (const t of s.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  const availableTags = [...tagCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div className="space-y-3">
      {/* Control bar — the view toggle + count are ALWAYS visible so the default-filtered state is obvious
          (never a mystery-empty list). */}
      <div className="flex flex-wrap items-center gap-3" data-testid="spec-controls">
        <div
          className="inline-flex rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] p-0.5"
          role="group"
          aria-label="coverage view"
        >
          {([
            ["unmonitored", `Not set up (${notSetUp.length})`],
            ["all", `All (${items.length})`],
          ] as const).map(([v, label]) => (
            <button
              key={v}
              type="button"
              aria-pressed={filters.view === v}
              data-testid={`view-${v}`}
              onClick={() => filters.setView(v)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                filters.view === v
                  ? "bg-[var(--color-panel-2)] text-[var(--color-ink)]"
                  : "text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="sw-mono text-[11px] text-[var(--color-ink-faint)]" data-testid="spec-count">
          Showing {shown.length} {filters.view === "unmonitored" ? "not set up" : filters.tags.length ? "matching" : ""} of{" "}
          {items.length}
        </span>
      </div>

      {/* Sort + tag filter only when showing ALL (the focused not-set-up view stays clean). */}
      {filters.view === "all" && (
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
      )}

      {shown.length === 0 ? (
        filters.view === "unmonitored" ? (
          <EmptyState
            title="All monitors are set up."
            hint="Every spec in the catalog has an active monitor. Switch to “All” to browse them."
          />
        ) : (
          <EmptyState
            title="No specs match these tags."
            hint="No spec carries all the selected tags."
            action={<button onClick={filters.clearTags} className="sw-btn">Clear tags</button>}
          />
        )
      ) : (
        <div className="sw-panel overflow-hidden" data-testid="spec-catalog">
          <div className="hidden grid-cols-[1fr_120px_170px_150px_120px_150px] gap-3 border-b border-[var(--color-border)] px-4 py-2.5 text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)] sm:grid">
            <span>Spec</span>
            <span>Coverage</span>
            <span>Runnable?</span>
            <span>Linked monitor</span>
            <span>Health</span>
            <span>Action</span>
          </div>
          <div className="divide-y divide-[var(--color-border)]">
            {shown.map((entry) => (
              <SpecRow key={entry.source_key} entry={entry} onActivate={onActivate} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function SpecCatalogPage() {
  const { data, isLoading, error } = useSpecCatalog();
  const [activating, setActivating] = useState<SpecCatalogEntry | null>(null);
  const filters = useSpecFilters();

  const when = data?.probed_at ? formatRelative(data.probed_at) : null;

  // Activation creates a check via createCheck() → revalidateChecks(), which now also invalidates the
  // spec-catalog cache (catalog coverage is check-derived). So the row flips Unmonitored→Active LIVE the
  // moment the create succeeds — the page just closes the modal; the refresh is owned by the mutation.
  const onActivated = () => setActivating(null);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="sw-eyebrow">Monitors as code</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Catalog</h1>
        </div>
        {when && (
          <span className="sw-mono text-[10px] text-[var(--color-ink-faint)]">reconciled {when}</span>
        )}
      </header>

      <p className="max-w-2xl text-sm text-[var(--color-ink-dim)]">
        Every monitor declared in Git (the <span className="sw-mono">synthwatch-monitors</span> manifest),
        with its coverage and whether its spec can run. Read-only — drift and setup live on the{" "}
        <Link href="/monitors" className="text-[var(--color-brand)] hover:underline">Monitors</Link> page.
      </p>

      <SignInToEdit />

      {data === undefined ? (
        isLoading ? (
          <div className="py-16"><Spinner label="Loading catalog…" /></div>
        ) : error ? (
          // ★ Loud-not-quiet: a real error (500/network) → visible, never a blank that reads as "no specs".
          // (404 is the `data === null` neutral box below — feature absent, not broken.)
          <ErrorState testId="specs-load-error" message="Couldn’t load the catalog — the API is unreachable. Retry shortly." />
        ) : null
      ) : data === null ? (
        // 404 — the API doesn't serve /api/specs yet. Neutral, not an error.
        <div
          className="rounded-lg px-4 py-3 text-sm text-[var(--color-ink-dim)]"
          style={{ border: "1px solid var(--color-border)", background: "var(--color-bg)" }}
          data-testid="spec-unavailable"
        >
          The spec catalog isn&apos;t available yet — the API doesn&apos;t serve it in this environment.
        </div>
      ) : data.items.length === 0 ? (
        <EmptyState
          title="No specs in the catalog yet."
          hint="The reconcile job populates the catalog from the Git manifest. Run reconcile, then refresh."
        />
      ) : (
        <CatalogBody items={data.items} filters={filters} onActivate={setActivating} />
      )}

      {/* Activation: MonitorForm in activation mode — prefilled + locked spec identity. On success the
          catalog re-reads and the row flips to Active. */}
      <Modal
        open={activating !== null}
        onClose={() => setActivating(null)}
        title={`Set up monitor · ${activating?.name ?? ""}`}
      >
        {activating && (
          <MonitorForm
            activation={activationFrom(activating)}
            onDone={onActivated}
            onCancel={() => setActivating(null)}
          />
        )}
      </Modal>
    </div>
  );
}
