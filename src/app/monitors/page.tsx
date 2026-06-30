"use client";

import { useState } from "react";
import Link from "next/link";

import { useChecks, updateCheck, deleteCheck, useTags, useReconcileDrift } from "@/lib/client";
import { TagFilter, useTagFilter, matchesTags } from "@/components/tag-filter";
import { ApiRequestError } from "@/lib/api-client";
import { StatusDot } from "@/components/status-badge";
import { Modal } from "@/components/modal";
import { MonitorForm } from "@/components/monitor-form";
import { MonitorChatInput } from "@/components/monitor-chat-input";
import { EmptyState, ErrorState, Spinner } from "@/components/states";
import { ReconcileDriftSurface } from "@/components/reconcile-drift";
import { RunAllControl } from "@/components/run-all";
import { RedactionBadge, RedactionFleetSummary } from "@/components/redaction";
import { useAuth } from "@/components/auth-provider";
import { SignInToEdit } from "@/components/write-gate";
import { formatRelative } from "@/lib/format";
import type { Check, CheckWithStatus } from "@/lib/types";

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
  // SWR-deduped with the component's own useReconcileDrift call (no extra fetch).
  const { data: drift } = useReconcileDrift();
  const { canWrite } = useAuth();
  const { selected, toggle, clear } = useTagFilter();
  const [creating, setCreating] = useState(false);
  const [prefill, setPrefill] = useState<{ fields: Partial<Check>; errors: Record<string, string> } | null>(null);
  const [editing, setEditing] = useState<Check | null>(null);
  const [deleting, setDeleting] = useState<CheckWithStatus | null>(null);
  const [pausingId, setPausingId] = useState<number | null>(null);

  // Monitors filter off their own embedded tags (check.tags), AND of all selected.
  const visible = (data ?? []).filter((c) => matchesTags(c.tags, selected));

  async function togglePause(check: CheckWithStatus) {
    setPausingId(check.id);
    try {
      await updateCheck(check.id, { enabled: !check.enabled });
    } finally {
      setPausingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="sw-eyebrow">Configuration</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Monitors</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Run the CURRENT filtered set in one click — editor-only, capped fan-out, live aggregate progress. */}
          <RunAllControl allChecks={data ?? []} scope={visible} onRunningChange={setBatchRunning} />
          {canWrite && (
            <button onClick={() => setCreating(true)} className="sw-btn sw-btn-primary">
              + New monitor
            </button>
          )}
        </div>
      </header>

      {/* Chat-to-prefill — describe a non-browser monitor; the parse opens the create modal prefilled (editor-only). */}
      {canWrite && (
        <MonitorChatInput
          onPrefill={(fields, errors) => {
            setPrefill({ fields, errors });
            setCreating(true);
          }}
        />
      )}

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
              <button onClick={() => setCreating(true)} className="sw-btn sw-btn-primary">
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
                <span className="sw-mono text-xs text-[var(--color-ink-dim)]">
                  {c.enabled ? "enabled" : "paused"}
                </span>
                <span className="sw-mono text-xs text-[var(--color-ink-faint)]">
                  {formatRelative(c.last_started_at)}
                </span>
                {canWrite ? (
                  <div className="flex flex-wrap gap-1.5 sm:justify-end">
                    <button
                      onClick={() => togglePause(c)}
                      disabled={pausingId === c.id}
                      className="sw-btn sw-btn-ghost sw-btn-sm"
                    >
                      {pausingId === c.id ? "…" : c.enabled ? "Pause" : "Resume"}
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

      {/* ── Demoted below the active monitors: monitors-as-code drift (new/changed/missing vs Git) + the
          catalog cross-link. The manage page LEADS with current monitors; what differs from Git / isn't set
          up yet is secondary context (set-up lives on the Catalog page). Gated on `drift` so an absent
          reconcile endpoint shows no empty labeled block. */}
      {drift && (
        <section className="border-t border-[var(--color-border)] pt-6" aria-label="Monitors as code" data-testid="drift-section">
          <p className="sw-eyebrow mb-3">Monitors as code</p>
          <ReconcileDriftSurface />
        </section>
      )}

      <Modal
        open={creating}
        onClose={() => {
          setCreating(false);
          setPrefill(null);
        }}
        title={prefill ? "New monitor — from your description" : "New monitor"}
      >
        <MonitorForm
          prefill={prefill?.fields ?? null}
          prefillErrors={prefill?.errors ?? null}
          onDone={() => {
            setCreating(false);
            setPrefill(null);
          }}
          onCancel={() => {
            setCreating(false);
            setPrefill(null);
          }}
        />
      </Modal>

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={`Edit · ${editing?.name ?? ""}`}>
        {editing && (
          <MonitorForm initial={editing} onDone={() => setEditing(null)} onCancel={() => setEditing(null)} />
        )}
      </Modal>

      {deleting && <DeleteDialog check={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}
