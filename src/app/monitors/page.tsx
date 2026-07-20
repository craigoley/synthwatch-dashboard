"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { useChecks, updateCheck, deleteCheck, useTags, useReconcileDrift, useSpecCatalog } from "@/lib/client";
import { TagFilter, useTagFilter, matchesTags } from "@/components/tag-filter";
import { ApiRequestError } from "@/lib/api-client";
import { StatusDot } from "@/components/status-badge";
import { Modal } from "@/components/modal";
import { MonitorForm } from "@/components/monitor-form";
import { MonitorChatInput } from "@/components/monitor-chat-input";
import { useCreateMonitor, CreateMonitorModal } from "@/components/create-monitor";
import { EmptyState, ErrorState, Spinner } from "@/components/states";
import { ReconcileDriftSurface } from "@/components/reconcile-drift";
import { ReconcileNowButton } from "@/components/reconcile-now-button";
import { CollapsibleSection } from "@/components/collapsible-section";
import { SpecTable, CatalogControls, coverageOf, useSpecFilters, compareSpec } from "@/components/spec-catalog";
import { RunAllControl } from "@/components/run-all";
import { RedactionBadge, RedactionFleetSummary } from "@/components/redaction";
import { useAuth } from "@/components/auth-provider";
import { SignInToEdit } from "@/components/write-gate";
import { usePersistedCollapse } from "@/lib/use-persisted-collapse";
import { asOf, SPEC_CATALOG_STALE_AFTER_MS } from "@/lib/staleness";
import { activationFrom } from "@/lib/specs";
import { formatRelative } from "@/lib/format";
import { daysUntilPurge } from "@/lib/status";
import type { Check, CheckWithStatus, SpecCatalogEntry } from "@/lib/types";

/** New-monitors section freshness — the ~24h reconcile-cron snapshot, "as of <age>" + a beyond-cron ⚠. */
function CatalogStamp({ probedAt }: { probedAt: string | null }) {
  if (!probedAt) return null;
  const { label, stale } = asOf(probedAt, SPEC_CATALOG_STALE_AFTER_MS);
  return (
    <span
      data-testid="new-monitors-stamp"
      className="sw-mono whitespace-nowrap text-[10px] font-normal"
      style={{ color: stale ? "var(--color-warn)" : "var(--color-ink-faint)" }}
    >
      {stale && <span aria-hidden>⚠ </span>}as of {label}
      {stale && " — snapshot may be stale"}
    </span>
  );
}

function DeleteDialog({
  check,
  onClose,
}: {
  check: CheckWithStatus;
  onClose: () => void;
}) {
  const [confirmHard, setConfirmHard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(hard: boolean) {
    setBusy(true);
    setError(null);
    try {
      await deleteCheck(check.id, hard);
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Delete failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Delete · ${check.name}`} width={520}>
      <div className="space-y-5">
        {error && (
          <div
            className="rounded-lg px-3 py-2 text-sm"
            style={{
              background: "color-mix(in srgb, var(--color-fail) 12%, transparent)",
              color: "var(--color-fail)",
            }}
          >
            {error}
          </div>
        )}

        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <div className="text-sm font-medium text-[var(--color-ink)]">Soft delete (recommended)</div>
          <p className="mt-1 text-sm text-[var(--color-ink-dim)]">
            Pauses the monitor by setting <span className="sw-mono">enabled = false</span>. All run history
            and incidents are preserved and it can be resumed later.
          </p>
          <button
            onClick={() => run(false)}
            disabled={busy}
            className="sw-btn mt-3"
          >
            {busy ? "…" : "Soft delete (pause)"}
          </button>
        </div>

        <div
          className="rounded-lg border p-4"
          style={{ borderColor: "color-mix(in srgb, var(--color-fail) 40%, transparent)" }}
        >
          <div className="text-sm font-medium" style={{ color: "var(--color-fail)" }}>
            Hard delete — permanent
          </div>
          <p className="mt-1 text-sm text-[var(--color-ink-dim)]">
            Permanently removes the check row. Depending on the runner&apos;s FK rules this may also remove
            its runs, steps, metrics and incidents. This cannot be undone.
          </p>
          <label className="mt-3 flex items-center gap-2 text-sm text-[var(--color-ink-dim)]">
            <input
              type="checkbox"
              checked={confirmHard}
              onChange={(e) => setConfirmHard(e.target.checked)}
            />
            I understand this is permanent.
          </label>
          <button
            onClick={() => run(true)}
            disabled={busy || !confirmHard}
            className="sw-btn sw-btn-danger mt-3"
          >
            {busy ? "…" : "Hard delete"}
          </button>
        </div>

        <div className="flex justify-end border-t border-[var(--color-border)] pt-4">
          <button onClick={onClose} className="sw-btn">
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default function MonitorsPage() {
  // While a "Run all" batch is in flight, fast-poll the list so the aggregate progress advances live.
  const [batchRunning, setBatchRunning] = useState(false);
  const { data, error, isLoading } = useChecks({ fast: batchRunning });
  const { data: inUseTags } = useTags();
  // For the demoted "Monitors as code" section below the active list (gated so it never shows an empty
  // labeled block when the reconcile endpoint is absent — mirrors ReconcileDriftSurface's own null guard).
  // SWR-deduped with the component's own useReconcileDrift call (no extra fetch). The error matters too:
  // a read-gated 401 / a real failure must show the section so the surface's SignInToView/ErrorState is
  // visible (hiding an errored section would be the silent-swallow #175 forbids).
  const { data: drift, error: driftError } = useReconcileDrift();
  // The spec catalog (git-declared specs) — a ~24h reconcile-cron SNAPSHOT (unlike the live checks above). Its
  // own SWR key ["spec-catalog"] → deduped, and /specs (which fetched it) now redirects here, so NET-ZERO new
  // fetches. undefined = loading, null = 404 (feature absent), object = data.
  // error matters: a real 500/network failure must go LOUD (specs-load-error), never a blank that reads as
  // "no new monitors" (the silent-swallow #175/#177 forbid). A 404 stays data=null → the section hides.
  const { data: catalog, error: catalogError } = useSpecCatalog();
  const { canWrite } = useAuth();
  const { selected, toggle, clear } = useTagFilter();
  const create = useCreateMonitor();
  const [editing, setEditing] = useState<Check | null>(null);
  const [deleting, setDeleting] = useState<CheckWithStatus | null>(null);
  const [pausingId, setPausingId] = useState<number | null>(null);
  const [activating, setActivating] = useState<SpecCatalogEntry | null>(null);
  const [showAllSpecs, setShowAllSpecs] = useState(false);
  const catalogFilters = useSpecFilters();

  // Monitors filter off their own embedded tags (check.tags), AND of all selected.
  const visible = (data ?? []).filter((c) => matchesTags(c.tags, selected));

  // ── Section signals (computed at page level so the collapsed HEADER can always announce them) ──
  // Reconcile: distinct non-orphan source_keys that differ from Git (matches ReconcileDriftSurface's configMonitors).
  const driftCount = drift ? new Set(drift.items.filter((r) => r.drift_type !== "orphan").map((r) => r.source_key)).size : 0;
  // Orphans (Git defines a monitor the runner can't run yet) are a KNOWN GAP, not config drift — but still
  // something, so they keep the reconcile PANEL rather than fold into the "in sync" line.
  const orphanCount = drift ? new Set(drift.items.filter((r) => r.drift_type === "orphan").map((r) => r.source_key)).size : 0;
  // New monitors: the set-difference — git-declared specs with no check yet. Empties to zero when healthy.
  const catalogItems = catalog?.items ?? [];
  const unActivated = catalogItems.filter((s) => coverageOf(s) === "unmonitored").sort((a, b) => a.name.localeCompare(b.name));
  // Full-catalog reveal, tag-filtered + sorted.
  const allFiltered = (catalogFilters.tags.length ? catalogItems.filter((s) => catalogFilters.tags.every((t) => s.tags.includes(t))) : catalogItems)
    .slice()
    .sort((a, b) => compareSpec(a, b, catalogFilters.sort.col, catalogFilters.sort.dir));

  // ── Loud PANEL vs thin STATUS-LINE (the #304 healthy state was two collapsed-but-chromed panels, ~290px+
  //    of "nothing to do" above the table). A section earns a real panel only when it has WORK or errored;
  //    otherwise its state folds into a single thin status row just above the Monitors table. ──
  const driftReady = !!drift && !driftError; // the read succeeded (data, not a 404-null or an error)
  const catalogReady = !!catalog && !catalogError;
  const driftItemCount = drift?.items.length ?? 0; // config drift + orphans
  const showReconcilePanel = !!driftError || driftItemCount > 0; // error (loud) or anything to reconcile
  const showNewMonitorsPanel = !!catalogError || unActivated.length > 0;
  const driftClean = driftReady && driftItemCount === 0; // reconcile ran, nothing differs → the thin line
  const catalogClean = catalogReady && unActivated.length === 0; // every declared spec is monitored → thin line

  // Collapse state (tri-state, per-browser localStorage) for the WORK panels only. autoOpen = OPEN when there's
  // something to show; an explicit toggle pins it. The BODY collapses; the header signal never does (a pinned-
  // closed section still announces the count). Healthy sections don't render a panel at all, so no stale pin can
  // resurrect one. ★ per-browser, not per-user — same open question as the sticky filters; decide together later.
  const reconcile = usePersistedCollapse("synthwatch:monitors-reconcile", driftCount > 0 || orphanCount > 0);
  const newMonitors = usePersistedCollapse("synthwatch:monitors-new-monitors", unActivated.length > 0);

  // /specs → /monitors?from=catalog: force-expand + scroll to the new-monitors section (an explicit intent
  // overrides a pinned-closed state for this visit, without pinning it open).
  const [fromCatalog, setFromCatalog] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("from") !== "catalog") return;
    setFromCatalog(true);
    // Scroll once the section exists (after the catalog resolves and the section renders).
    const el = document.getElementById("new-monitors");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [catalog]);

  async function togglePause(check: CheckWithStatus) {
    setPausingId(check.id);
    try {
      await updateCheck(check.id, { enabled: !check.enabled });
    } finally {
      setPausingId(null);
    }
  }

  // Reversible archive (0071): stops running + badges "archived"; unarchive resumes with the prior
  // enabled/paused state (archive is DISTINCT from pause — it doesn't touch `enabled`). Mirrors togglePause.
  async function toggleArchive(check: CheckWithStatus) {
    setPausingId(check.id);
    try {
      await updateCheck(check.id, { archived: !check.archived_at });
    } finally {
      setPausingId(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* ── 1 · RECONCILE / DRIFT — LOUD only when there's work. #299 flow UNCHANGED inside the surface.
          driftError → the surface renders DIRECTLY (its SignInToView (401) / ErrorState (#175) must never be
          collapse-hidden). Drift/orphans → a disclosure: auto-expanded, header carries the count (a pinned-
          closed body still announces it). In-sync → NO panel; it folds into the thin status line below. ── */}
      {driftError ? (
        <ReconcileDriftSurface />
      ) : showReconcilePanel ? (
        <CollapsibleSection
          id="reconcile"
          label="Reconcile drift"
          testId="reconcile-section"
          open={reconcile.open}
          onToggle={reconcile.toggle}
          header={
            <span className="flex flex-wrap items-baseline gap-x-2">
              {driftCount > 0 ? (
                <span style={{ color: "var(--color-warn)" }}>
                  ⚠ {driftCount} monitor{driftCount === 1 ? "" : "s"} differ from Git
                </span>
              ) : (
                <span className="text-[var(--color-ink-dim)]">
                  {orphanCount} monitor{orphanCount === 1 ? "" : "s"} Git defines the runner can’t run yet
                </span>
              )}
              {drift?.detected_at && (
                <span
                  data-testid="reconcile-stamp"
                  className="sw-mono whitespace-nowrap text-[10px] font-normal text-[var(--color-ink-faint)]"
                >
                  reconciled {formatRelative(drift.detected_at)}
                </span>
              )}
            </span>
          }
        >
          <ReconcileDriftSurface />
        </CollapsibleSection>
      ) : null}

      {/* ── 2 · NEW MONITORS — the un-activated SET-DIFFERENCE (git-declared, no check yet). LOUD only when
          there's at least one to set up (or the catalog read failed → specs-load-error, never a silent hide).
          When every declared spec is monitored → NO panel; it folds into the thin status line below. ── */}
      {catalogError ? (
        <ErrorState testId="specs-load-error" message="Couldn’t load the spec catalog — the API is unreachable. Retry shortly." />
      ) : showNewMonitorsPanel ? (
        <CollapsibleSection
          id="new-monitors"
          label="New monitors"
          testId="new-monitors-section"
          open={newMonitors.open || fromCatalog}
          onToggle={newMonitors.toggle}
          header={
            <span className="flex flex-wrap items-baseline gap-x-2">
              {`${unActivated.length} declared spec${unActivated.length === 1 ? "" : "s"} not yet monitored`}
              <CatalogStamp probedAt={catalog?.probed_at ?? null} />
            </span>
          }
        >
          <SpecTable items={unActivated} onActivate={setActivating} testId="new-monitors-table" />
        </CollapsibleSection>
      ) : null}

      {/* ── STATUS LINE — the HEALTHY state collapses BOTH sections into ONE thin row (no panel chrome): the
          clean signals that didn't earn a panel above, the "as of" snapshot stamp, [Reconcile now], and the
          always-available coverage entry (the full-catalog reveal). Fully in-sync + all-monitored ⇒ this is the
          only thing between the page top and the Monitors table (~40px, not ~450px of stacked panels). ── */}
      {(driftClean || catalogClean || catalogReady) && (
        // The #new-monitors scroll anchor (for /specs?from=catalog) lives on the setup PANEL when it renders,
        // else here on the status line — never both (no duplicate id).
        <div id={showNewMonitorsPanel ? undefined : "new-monitors"} className="scroll-mt-4">
          <div
            data-testid="monitors-status-line"
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-[var(--color-ink-dim)]"
          >
            {driftClean && (
              <span className="inline-flex items-center gap-1.5 text-[var(--color-ink)]">
                <span className="sw-dot sw-dot-pass" aria-hidden />
                In sync with Git
              </span>
            )}
            {catalogClean && (
              <>
                {driftClean && <span aria-hidden className="text-[var(--color-ink-faint)]">·</span>}
                <span>
                  {catalogItems.length} declared spec{catalogItems.length === 1 ? "" : "s"}, all monitored
                </span>
              </>
            )}
            {catalogClean && catalog?.probed_at && (
              <>
                <span aria-hidden className="text-[var(--color-ink-faint)]">·</span>
                <CatalogStamp probedAt={catalog.probed_at} />
              </>
            )}
            {driftClean && (
              <>
                <span aria-hidden className="text-[var(--color-ink-faint)]">·</span>
                <ReconcileNowButton />
              </>
            )}
            {catalogReady && (
              <>
                <span aria-hidden className="text-[var(--color-ink-faint)]">·</span>
                <button
                  type="button"
                  data-testid="browse-catalog"
                  aria-expanded={showAllSpecs}
                  aria-controls="full-catalog"
                  onClick={() => setShowAllSpecs((v) => !v)}
                  className="text-[12px] text-[var(--color-brand)] hover:underline"
                >
                  {showAllSpecs
                    ? "Hide the full spec catalog"
                    : `Browse the full spec catalog (${catalogItems.length} spec${catalogItems.length === 1 ? "" : "s"}) →`}
                </button>
              </>
            )}
          </div>
          {/* The full "All" catalog (Coverage / Runnable / Linked-monitor → /checks/{id} / Health, sort + tags).
              `hidden` keeps it in the DOM (a11y target). */}
          <div id="full-catalog" hidden={!showAllSpecs} className="mt-2 space-y-2" data-testid="full-catalog">
            <CatalogControls filters={catalogFilters} items={catalogItems} />
            <SpecTable items={allFiltered} onActivate={setActivating} testId="full-catalog-table" />
          </div>
        </div>
      )}

      {/* ── 3 · CURRENT MONITORS — the live fleet (verbatim). Not collapsible; the page's primary content. ── */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="sw-eyebrow">Configuration</p>
          <h1 className="mt-1 flex flex-wrap items-baseline gap-x-2 text-2xl font-semibold tracking-tight">
            Monitors
            <span data-testid="monitors-live-stamp" className="sw-mono text-[10px] font-normal text-[var(--color-ink-faint)]">
              · live
            </span>
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Run the CURRENT filtered set in one click — editor-only, capped fan-out, live aggregate progress. */}
          <RunAllControl allChecks={data ?? []} scope={visible} onRunningChange={setBatchRunning} />
          {canWrite && (
            <button onClick={create.openBlank} className="sw-btn sw-btn-primary">
              + New monitor
            </button>
          )}
        </div>
      </header>

      {/* Chat-to-prefill — describe a non-browser monitor; the parse opens the create modal prefilled (editor-only). */}
      {canWrite && <MonitorChatInput onPrefill={create.openPrefilled} />}

      {/* Read-only-by-default: viewers see a sign-in prompt; write affordances are gated on canWrite. */}
      <SignInToEdit />

      {/* Fleet-level B10 redaction posture — a sensitive-but-unredacted gap is loud here. */}
      {data && data.length > 0 && <RedactionFleetSummary checks={data} />}

      {data && data.length > 0 && (
        <TagFilter
          available={inUseTags ?? []}
          selected={selected}
          onToggle={toggle}
          onClear={clear}
          resultLabel={`${visible.length} of ${data.length} monitors match`}
        />
      )}

      {isLoading && !data ? (
        <div className="py-16"><Spinner label="Loading monitors…" /></div>
      ) : error ? (
        <ErrorState message={error instanceof Error ? error.message : "Failed to load monitors."} />
      ) : !data || data.length === 0 ? (
        <EmptyState
          title="No monitors yet."
          hint="Create your first HTTP or browser monitor."
          action={
            canWrite ? (
              <button onClick={create.openBlank} className="sw-btn sw-btn-primary">
                + New monitor
              </button>
            ) : undefined
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState
          title="No monitors match this filter."
          hint="No monitor carries all the selected tags."
          action={
            <button onClick={clear} className="sw-btn">
              Clear filter
            </button>
          }
        />
      ) : (
        <div className="sw-panel overflow-hidden">
          <div className="hidden grid-cols-[1fr_90px_120px_110px_220px] gap-3 border-b border-[var(--color-border)] px-4 py-2.5 text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)] sm:grid">
            <span>Monitor</span>
            <span>Kind</span>
            <span>State</span>
            <span>Last run</span>
            <span className="text-right">Actions</span>
          </div>
          <div className="divide-y divide-[var(--color-border)]">
            {visible.map((c) => (
              <div
                key={c.id}
                className="grid grid-cols-1 gap-2 px-4 py-3 sm:grid-cols-[1fr_90px_120px_110px_220px] sm:items-center sm:gap-3"
                style={{ opacity: c.enabled ? 1 : 0.62 }}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <StatusDot status={c.current_status} />
                  <div className="min-w-0">
                    <Link
                      href={`/checks/${c.id}`}
                      className="block truncate text-sm font-medium text-[var(--color-ink)] hover:text-[var(--color-brand)]"
                    >
                      {c.name}
                    </Link>
                    {(c.flow_name || c.target_url) && (
                      <span className="sw-mono block truncate text-[11px] text-[var(--color-ink-faint)]">
                        {c.flow_name ?? c.target_url}
                      </span>
                    )}
                    {/* B10: a sensitive-but-unredacted monitor must be visible right here, not in a DB query. */}
                    <div className="mt-0.5"><RedactionBadge health={c.redaction_health} /></div>
                  </div>
                </div>
                <span className="sw-mono text-xs uppercase text-[var(--color-ink-dim)]">{c.kind}</span>
                {c.removed_at ? (
                  <span
                    className="sw-mono text-xs"
                    style={{ color: "var(--color-fail)" }}
                    title={`Git-removed — hard-deletes in ${daysUntilPurge(c.removed_at) ?? 0} day(s)`}
                  >
                    removed · purging {daysUntilPurge(c.removed_at) ?? 0}d
                  </span>
                ) : (
                  <span className="sw-mono text-xs text-[var(--color-ink-dim)]">
                    {c.archived_at ? "archived" : c.enabled ? "enabled" : "paused"}
                  </span>
                )}
                <span className="sw-mono text-xs text-[var(--color-ink-faint)]">
                  {formatRelative(c.last_started_at)}
                </span>
                {canWrite ? (
                  <div className="flex flex-wrap gap-1.5 sm:justify-end">
                    {/* A git-removed check is read-only here — its lifecycle is driven by the manifest
                        (re-add in git to cancel the purge), so pause/archive are moot. */}
                    <button
                      onClick={() => togglePause(c)}
                      disabled={pausingId === c.id || c.archived_at != null || c.removed_at != null}
                      className="sw-btn sw-btn-ghost sw-btn-sm"
                    >
                      {pausingId === c.id ? "…" : c.enabled ? "Pause" : "Resume"}
                    </button>
                    <button
                      onClick={() => toggleArchive(c)}
                      disabled={pausingId === c.id || c.removed_at != null}
                      className="sw-btn sw-btn-ghost sw-btn-sm"
                    >
                      {pausingId === c.id ? "…" : c.archived_at ? "Unarchive" : "Archive"}
                    </button>
                    <button onClick={() => setEditing(c)} className="sw-btn sw-btn-ghost sw-btn-sm">
                      Edit
                    </button>
                    <button
                      onClick={() => setDeleting(c)}
                      className="sw-btn sw-btn-ghost sw-btn-sm"
                      style={{ color: "var(--color-fail)" }}
                    >
                      Delete
                    </button>
                  </div>
                ) : (
                  <span aria-hidden />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <CreateMonitorModal {...create.modal} />

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={`Edit · ${editing?.name ?? ""}`}>
        {editing && (
          <MonitorForm initial={editing} onDone={() => setEditing(null)} onCancel={() => setEditing(null)} />
        )}
      </Modal>

      {deleting && <DeleteDialog check={deleting} onClose={() => setDeleting(null)} />}

      {/* Activation (from the New monitors section): MonitorForm in activation mode — prefilled + IDENTITY-LOCKED
          spec_path + source_key (never a free-form create). On success the catalog re-reads and the row leaves
          the un-activated set. */}
      <Modal
        open={activating !== null}
        onClose={() => setActivating(null)}
        title={`Set up monitor · ${activating?.name ?? ""}`}
      >
        {activating && (
          <MonitorForm
            activation={activationFrom(activating)}
            onDone={() => setActivating(null)}
            onCancel={() => setActivating(null)}
          />
        )}
      </Modal>
    </div>
  );
}
