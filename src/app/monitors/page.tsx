"use client";

import { useState } from "react";
import Link from "next/link";

import { useChecks, updateCheck, deleteCheck, useTags } from "@/lib/client";
import { TagFilter, useTagFilter, matchesTags } from "@/components/tag-filter";
import { ApiRequestError } from "@/lib/api-client";
import { StatusDot } from "@/components/status-badge";
import { Modal } from "@/components/modal";
import { MonitorForm } from "@/components/monitor-form";
import { EmptyState, ErrorState, Spinner } from "@/components/states";
import { ReconcileDriftSurface } from "@/components/reconcile-drift";
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
  const { data, error, isLoading } = useChecks();
  const { data: inUseTags } = useTags();
  const { selected, toggle, clear } = useTagFilter();
  const [creating, setCreating] = useState(false);
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
        <button onClick={() => setCreating(true)} className="sw-btn sw-btn-primary">
          + New monitor
        </button>
      </header>

      {/* Monitors-as-code drift (Phase 6b) — read-only; hides until the reconcile endpoint serves. */}
      <ReconcileDriftSurface />

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
            <button onClick={() => setCreating(true)} className="sw-btn sw-btn-primary">
              + New monitor
            </button>
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
                  </div>
                </div>
                <span className="sw-mono text-xs uppercase text-[var(--color-ink-dim)]">{c.kind}</span>
                <span className="sw-mono text-xs text-[var(--color-ink-dim)]">
                  {c.enabled ? "enabled" : "paused"}
                </span>
                <span className="sw-mono text-xs text-[var(--color-ink-faint)]">
                  {formatRelative(c.last_started_at)}
                </span>
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
              </div>
            ))}
          </div>
        </div>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title="New monitor">
        <MonitorForm onDone={() => setCreating(false)} onCancel={() => setCreating(false)} />
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
