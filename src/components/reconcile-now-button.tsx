"use client";

import { useEffect, useRef, useState } from "react";

import { useReconcileDrift, triggerReconcile } from "@/lib/client";
import { useAuth } from "@/components/auth-provider";

/**
 * The "Reconcile now" trigger for the HEALTHY (in-sync) status line, where the full ReconcileDriftSurface
 * isn't rendered (there's nothing to show). Self-contained so it doesn't drag in the surface's panel chrome.
 *
 * Behaviour mirrors the surface's own reconcile-now (event-driven, off-cron, #115): editor-gated, fire-and-
 * forget (202, no execution id), then a scoped fast-poll on useReconcileDrift watches `detected_at` advance —
 * "done" = the off-cron job re-ran and rewrote the snapshot. If that re-run finds drift, the page's own
 * useReconcileDrift re-renders the in-sync line into the loud reconcile panel (same shared SWR key). The
 * surface and this button NEVER render at once (in-sync → this; work/error → the surface), so the shared
 * `reconcile-now` testid can't collide.
 */
export function ReconcileNowButton() {
  const { canWrite } = useAuth(); // editor/admin only — the API gates this write; it spends compute
  const [reconciling, setReconciling] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const { data } = useReconcileDrift({ reconciling });
  const baseline = useRef<string | null>(null); // detected_at captured at trigger time
  const detectedAt = data?.detected_at ?? null;

  // Completion: the off-cron job re-synced the snapshot (detected_at advanced) → leave the live state.
  useEffect(() => {
    if (reconciling && detectedAt !== baseline.current) setReconciling(false);
  }, [reconciling, detectedAt]);

  // Safety stop: the ACA job can be slow (cold start) — don't spin forever if no fresh snapshot lands.
  useEffect(() => {
    if (!reconciling) return;
    const t = setTimeout(() => setReconciling(false), 120_000);
    return () => clearTimeout(t);
  }, [reconciling]);

  if (!canWrite) return null;

  async function handleReconcileNow() {
    setTriggerError(null);
    baseline.current = detectedAt; // remember the pre-trigger snapshot so we can detect the re-synced one
    setReconciling(true); // turns on the scoped fast-poll — catches the re-sync live
    try {
      await triggerReconcile(); // 202 fire-and-forget; the fast-poll watches detected_at from here
    } catch {
      // 401/403 handled globally by the api-client interceptor; a 503 (job-start failed)/other → surface.
      setReconciling(false);
      setTriggerError("Couldn’t start the reconcile — try again.");
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      {triggerError && (
        <span data-testid="reconcile-error" className="text-[12px]" style={{ color: "var(--color-fail)" }}>
          {triggerError}
        </span>
      )}
      <button
        type="button"
        onClick={handleReconcileNow}
        disabled={reconciling}
        data-testid="reconcile-now"
        className="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-0.5 text-[12px] font-medium text-[var(--color-ink)] transition hover:bg-[var(--color-panel-2)] disabled:opacity-60"
      >
        {reconciling ? "Reconciling…" : "Reconcile now"}
      </button>
    </span>
  );
}
