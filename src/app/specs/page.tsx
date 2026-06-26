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

import { useState } from "react";
import Link from "next/link";

import { useSpecCatalog } from "@/lib/client";
import { EmptyState, Spinner } from "@/components/states";
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
  return s.enabled ? "active" : "paused";
}

const COVERAGE_META: Record<SpecCoverage, { label: string; tone: string }> = {
  active: { label: "Active", tone: "var(--color-pass)" },
  paused: { label: "Paused", tone: "var(--color-idle)" },
  unmonitored: { label: "Unmonitored", tone: "var(--color-ink-faint)" },
};

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

export default function SpecCatalogPage() {
  const { data, isLoading } = useSpecCatalog();
  const [activating, setActivating] = useState<SpecCatalogEntry | null>(null);

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
            {data.items.map((entry) => (
              <SpecRow key={entry.source_key} entry={entry} onActivate={setActivating} />
            ))}
          </div>
        </div>
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
