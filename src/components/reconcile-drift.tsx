"use client";

/**
 * Monitors-as-code drift surface (Phase 6b). Reads the runner-owned reconcile snapshot READ-ONLY and
 * shows how the live monitors differ from Git (the synthwatch-monitors manifest). The reconcile never
 * applies — it runs in REPORT MODE — so this surface has no apply controls (apply is a later runner
 * capability).
 *
 * Two classes, deliberately rendered apart so 3 expected orphans never read as "3 problems":
 *  - new | changed | missing → resolvable CONFIG drift. "Monitor config differs from Git." Apply WOULD
 *    fix these once apply-on-merge is enabled. Surfaced with an amber "attention, not down" tone.
 *  - orphan → a KNOWN GAP: Git defines a monitor the runner can't run yet (browser spec-execution is
 *    deferred to a later phase). NOT config drift, NOT a failure → rendered NEUTRALLY (idle gray, a
 *    "known gap" pill), visually distinct from the config-drift trio.
 *
 * Visibility: data null (404 — endpoint not deployed) or undefined (loading) → the surface hides. An
 * empty snapshot (reconcile ran, nothing differs) renders the positive "in sync with Git" state.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

import { useReconcileDrift, triggerReconcile } from "@/lib/client";
import { useAuth } from "@/components/auth-provider";
import { formatRelative } from "@/lib/format";
import type { DriftRow, DriftType } from "@/lib/types";

/**
 * Cross-link to the spec catalog (Phase 13) — the browse home for ALL specs, where this focused drift
 * banner's "what differs" points you to act. `newCount` (the `new` drift rows = specs Git declares with
 * no live monitor) surfaces the unmonitored count when there is one.
 */
function CatalogLink({ newCount }: { newCount: number }) {
  return (
    <Link
      href="/specs"
      data-testid="drift-catalog-link"
      className="inline-flex items-center gap-1 text-[12px] text-[var(--color-brand)] hover:underline"
    >
      {newCount > 0
        ? `${newCount} spec${newCount === 1 ? "" : "s"} unmonitored — open the catalog`
        : "Browse the spec catalog"}
      <span aria-hidden>→</span>
    </Link>
  );
}

const TYPE_META: Record<DriftType, { label: string; tone: string }> = {
  new: { label: "New", tone: "var(--color-brand)" },
  changed: { label: "Changed", tone: "var(--color-warn)" },
  missing: { label: "Missing", tone: "var(--color-warn)" },
  orphan: { label: "Orphan", tone: "var(--color-idle)" },
};

const asStr = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

/** Human "what differs", derived from the runner-written detail jsonb (shape varies by drift type). */
function summarize(row: DriftRow): string {
  const d = row.detail ?? {};
  switch (row.drift_type) {
    case "new": {
      const name = asStr(d.name) ?? row.source_key;
      const kind = asStr(d.kind);
      return `Defined in Git, no live monitor yet — ${name}${kind ? ` (${kind})` : ""}. Apply would add it.`;
    }
    case "missing": {
      const name = asStr(d.name) ?? row.source_key;
      return `Gone from Git — ${name}. Apply would soft-disable it (never deletes; history is kept).`;
    }
    case "orphan": {
      const flow = asStr(d.flow_name);
      return flow
        ? `Bound flow "${flow}" has no compiled runner module yet — can't be run.`
        : "No compiled runner module yet — can't be run.";
    }
    case "changed":
    default:
      return "Git-managed fields differ from the live monitor.";
  }
}

/** For a `changed` row: the per-field before/after diff the runner recorded (git vs live). */
function changedFields(row: DriftRow): { field: string; git: string; live: string }[] {
  const fields = (row.detail?.fields ?? {}) as Record<string, unknown>;
  if (!fields || typeof fields !== "object") return [];
  return Object.entries(fields).flatMap(([field, v]) => {
    if (!v || typeof v !== "object") return [];
    const pair = v as Record<string, unknown>;
    return [{ field, git: String(pair.git ?? "—"), live: String(pair.live ?? "—") }];
  });
}

function DriftPill({ type }: { type: DriftType }) {
  const meta = TYPE_META[type];
  return (
    <span
      className="sw-mono shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
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

function DriftRowItem({ row }: { row: DriftRow }) {
  const fields = row.drift_type === "changed" ? changedFields(row) : [];
  return (
    <div
      className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-start sm:gap-3"
      data-testid="drift-row"
      data-drift-type={row.drift_type}
      data-source-key={row.source_key}
    >
      <DriftPill type={row.drift_type} />
      <div className="min-w-0 flex-1">
        <span className="sw-mono block truncate text-[13px] font-medium text-[var(--color-ink)]">
          {row.source_key}
        </span>
        <p className="mt-0.5 text-[13px] text-[var(--color-ink-dim)]">{summarize(row)}</p>
        {fields.length > 0 && (
          <ul className="mt-1.5 space-y-1">
            {fields.map((f) => (
              <li key={f.field} className="sw-mono text-[11px] text-[var(--color-ink-faint)]">
                <span className="text-[var(--color-ink-dim)]">{f.field}</span>{" "}
                <span title="value in Git">git «{f.git}»</span>{" "}
                <span aria-hidden>→</span>{" "}
                <span title="current live value">live «{f.live}»</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function ReconcileDriftSurface() {
  // ── "Reconcile now": event-driven, off-cron trigger (the #115-proven path). Mirrors the runCheckNow
  //    live-progress UX — disabled while running, fast-polls for completion, re-enables when the snapshot
  //    re-syncs. Reconcile is fire-and-forget (202, no execution id), so "done" = the drift snapshot's
  //    detected_at advancing past the pre-trigger value (the off-cron job re-ran and rewrote the snapshot).
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

  async function handleReconcileNow() {
    setTriggerError(null);
    baseline.current = detectedAt; // remember the pre-trigger snapshot so we can detect the re-synced one
    setReconciling(true); // turns on the scoped fast-poll (useReconcileDrift) — catches the re-sync live
    try {
      await triggerReconcile(); // 202 fire-and-forget; the fast-poll watches detected_at from here
    } catch {
      // 401/403 are handled globally by the api-client interceptor; a 503 (job-start failed)/other → surface.
      setReconciling(false);
      setTriggerError("Couldn't start the reconcile — try again.");
    }
  }

  const reconcileControl = canWrite ? (
    <div className="flex items-center gap-2">
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
        className="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2.5 py-1 text-xs font-medium text-[var(--color-ink)] transition hover:bg-[var(--color-panel-2)] disabled:opacity-60"
      >
        {reconciling ? "Reconciling…" : "Reconcile now"}
      </button>
    </div>
  ) : null;

  if (!data) return null; // loading (undefined) or endpoint absent (null) → hide cleanly

  const config = data.items.filter((r) => r.drift_type !== "orphan");
  const orphans = data.items.filter((r) => r.drift_type === "orphan");
  const configMonitors = new Set(config.map((r) => r.source_key)).size;
  // `new` drift = a manifest spec with no live monitor = an Unmonitored spec in the catalog.
  const newCount = new Set(config.filter((r) => r.drift_type === "new").map((r) => r.source_key)).size;
  const when = data.detected_at ? formatRelative(data.detected_at) : null;

  // Truly empty — the reconcile ran and nothing differs. Positive, not an error.
  if (data.items.length === 0) {
    return (
      <section className="sw-panel p-4" data-testid="reconcile-drift">
        <div className="flex flex-wrap items-center justify-between gap-2" data-testid="drift-insync">
          <div className="flex items-center gap-2.5">
            <span className="sw-dot sw-dot-pass" />
            <span className="text-sm font-medium text-[var(--color-ink)]">In sync with Git</span>
            <span className="text-[13px] text-[var(--color-ink-dim)]">
              No monitors differ from the manifest.
            </span>
          </div>
          <div className="flex items-center gap-2">
            {when && (
              <span className="sw-mono text-[10px] text-[var(--color-ink-faint)]">reconciled {when}</span>
            )}
            {reconcileControl}
          </div>
        </div>
        <div className="mt-2"><CatalogLink newCount={newCount} /></div>
      </section>
    );
  }

  return (
    <section className="space-y-3" data-testid="reconcile-drift">
      {(reconcileControl || when) && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {when && (
            <span className="sw-mono text-[10px] text-[var(--color-ink-faint)]">reconciled {when}</span>
          )}
          {reconcileControl}
        </div>
      )}

      {/* ── Resolvable config drift (new / changed / missing) ── amber "attention, not down". ── */}
      {config.length > 0 ? (
        <div className="sw-panel overflow-hidden" data-testid="drift-config">
          <div
            className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3"
            style={{ borderColor: "color-mix(in srgb, var(--color-warn) 34%, var(--color-border))" }}
          >
            <div className="flex items-center gap-2.5">
              <span className="sw-dot sw-dot-warn" />
              <span className="text-sm font-medium" style={{ color: "var(--color-warn)" }}>
                {configMonitors} monitor{configMonitors === 1 ? "" : "s"} differ from Git
              </span>
            </div>
            <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
              report mode · not applied
            </span>
          </div>
          <p className="px-4 pt-2.5 text-[12px] text-[var(--color-ink-dim)]">
            Monitor config differs from the Git manifest. Reconcile runs in report mode — nothing is
            applied here; apply-on-merge is a later capability.
          </p>
          <div className="mt-1 divide-y divide-[var(--color-border)]">
            {config.map((r) => (
              <DriftRowItem key={`${r.drift_type}:${r.source_key}`} row={r} />
            ))}
          </div>
        </div>
      ) : (
        // No config drift but orphans exist — make the "config is fine" half explicit and positive.
        <div className="sw-panel flex flex-wrap items-center gap-2.5 px-4 py-3" data-testid="drift-insync">
          <span className="sw-dot sw-dot-pass" />
          <span className="text-sm font-medium text-[var(--color-ink)]">Config in sync with Git</span>
          <span className="text-[13px] text-[var(--color-ink-dim)]">
            No monitor config differs from the manifest.
          </span>
        </div>
      )}

      {/* ── Known gap (orphans) ── NEUTRAL, visually distinct from config drift: not an alarm. ── */}
      {orphans.length > 0 && (
        <div
          className="sw-panel overflow-hidden"
          data-testid="drift-orphans"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-3">
            <div className="flex items-center gap-2.5">
              <span className="sw-dot sw-dot-idle" />
              <span className="text-sm font-medium text-[var(--color-ink-dim)]">
                Known gap · {orphans.length} monitor{orphans.length === 1 ? "" : "s"} Git defines but the
                runner can&apos;t run yet
              </span>
            </div>
            <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
              expected
            </span>
          </div>
          <p className="px-4 pt-2.5 text-[12px] text-[var(--color-ink-faint)]">
            These aren&apos;t config drift or a failure. Each is a Git-defined monitor whose flow has no
            compiled runner module yet — browser spec-execution is deferred to a later phase.
          </p>
          <div className="mt-1 divide-y divide-[var(--color-border)]">
            {orphans.map((r) => (
              <DriftRowItem key={`orphan:${r.source_key}`} row={r} />
            ))}
          </div>
        </div>
      )}

      {/* Cross-link to the catalog (Phase 13) — coexist: this banner alerts, the catalog is the browse home. */}
      <div><CatalogLink newCount={newCount} /></div>
    </section>
  );
}
