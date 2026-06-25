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

import { useReconcileDrift } from "@/lib/client";
import { formatRelative } from "@/lib/format";
import type { DriftRow, DriftType } from "@/lib/types";

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
  const { data } = useReconcileDrift();
  if (!data) return null; // loading (undefined) or endpoint absent (null) → hide cleanly

  const config = data.items.filter((r) => r.drift_type !== "orphan");
  const orphans = data.items.filter((r) => r.drift_type === "orphan");
  const configMonitors = new Set(config.map((r) => r.source_key)).size;
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
          {when && (
            <span className="sw-mono text-[10px] text-[var(--color-ink-faint)]">reconciled {when}</span>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-3" data-testid="reconcile-drift">
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
    </section>
  );
}
