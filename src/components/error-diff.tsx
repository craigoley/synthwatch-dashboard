"use client";

import { useState } from "react";

import { useErrorDiff } from "@/lib/client";
import type { ErrorItem } from "@/lib/api-client";
import { Spinner } from "@/components/states";
import { TONE_VAR } from "@/components/status-badge";

/**
 * Error diff (P3) — the payoff of Craig's ask: "see new JS/API/page errors that didn't exist on the last run".
 * This run's errors vs the UNION of the last N settled runs (anti-flap). NEW leads + is expanded (the
 * regression signal); persistent/resolved collapse below. FIRST-PARTY by default — third-party tracker noise
 * (doubleclick/rlcdn/astutebot/bing) is hidden behind a counted toggle so it can't drown the signal. Items
 * arrive already severity-sorted from the API (first-party 5xx first).
 */

const isFirstParty = (i: ErrorItem) => i.origin === "first-party";

// Severity tier → status-law color. sev ≥4 = first-party 5xx/4xx/error (the real regressions) → fail; abort +
// csp/warning → warn; any third-party (sev 1) → neutral. Keeps the status colors' meaning (no false alarms).
function sevTone(sev: number): string {
  if (sev >= 4) return TONE_VAR.fail;
  if (sev >= 2) return TONE_VAR.warn;
  return "var(--color-ink-dim)";
}

// Network status label — "-1 abort" reads clearer than a raw negative code; 4xx/5xx as-is; null for console.
function netStatusLabel(item: ErrorItem): string | null {
  if (item.status == null) return null;
  return item.status < 0 ? `${item.status} abort` : String(item.status);
}

function SeverityBadge({ item }: { item: ErrorItem }) {
  const tone = sevTone(item.severity);
  return (
    <span
      className="sw-mono mt-0.5 shrink-0 rounded px-1 text-[9px] font-semibold uppercase tracking-wider"
      style={{ color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }}
    >
      {item.severity_label}
    </span>
  );
}

function ErrorRow({ item }: { item: ErrorItem }) {
  const net = netStatusLabel(item);
  return (
    <div className="flex items-start gap-2 py-1" data-testid="ediff-row">
      <SeverityBadge item={item} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] leading-snug text-[var(--color-ink)]" title={item.message}>
          {item.message}
        </div>
        <div className="sw-mono mt-0.5 truncate text-[10px] text-[var(--color-ink-faint)]">
          {item.source_host || "—"} · {item.kind}
          {net ? ` · ${net}` : ""}
          {item.count > 1 ? ` · ×${item.count}` : ""}
          {!isFirstParty(item) ? " · 3rd-party" : ""}
        </div>
      </div>
    </div>
  );
}

/** Third-party items behind a counted disclosure — the anti-fatigue control (tracker noise stays hidden). */
function ThirdPartyItems({ items }: { items: ErrorItem[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        data-testid="ediff-thirdparty-toggle"
        className="sw-mono text-[11px] text-[var(--color-ink-faint)] transition hover:text-[var(--color-ink)]"
      >
        {open ? "− hide" : "+"} {items.length} third-party
      </button>
      {open && (
        <div className="mt-1 border-l border-[var(--color-border)] pl-2" data-testid="ediff-thirdparty-list">
          {items.map((i) => (
            <ErrorRow key={i.fingerprint} item={i} />
          ))}
        </div>
      )}
    </div>
  );
}

/** First-party items listed, third-party behind the toggle. */
function Bucket({ items, testId }: { items: ErrorItem[]; testId: string }) {
  const first = items.filter(isFirstParty);
  const third = items.filter((i) => !isFirstParty(i));
  return (
    <div data-testid={testId}>
      {first.map((i) => (
        <ErrorRow key={i.fingerprint} item={i} />
      ))}
      {first.length === 0 && third.length > 0 && (
        <p className="text-[11px] text-[var(--color-ink-dim)]">No first-party errors.</p>
      )}
      <ThirdPartyItems items={third} />
    </div>
  );
}

/** Persistent / Resolved — collapsed by default (below the NEW headline). */
function CollapsedBucket({ label, items, testId }: { label: string; items: ErrorItem[]; testId: string }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div className="mt-2 border-t border-[var(--color-border)] pt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid={`${testId}-toggle`}
        className="flex w-full items-center gap-1.5 text-left text-[12px] font-medium text-[var(--color-ink-dim)]"
      >
        <span className="text-[10px] text-[var(--color-ink-faint)]">{open ? "▾" : "▸"}</span>
        {label} <span className="sw-mono text-[var(--color-ink-faint)]">({items.length})</span>
      </button>
      {open && (
        <div className="mt-1">
          <Bucket items={items} testId={`${testId}-body`} />
        </div>
      )}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="sw-panel p-4" data-testid="error-diff">
      <h3 className="mb-1 text-sm font-semibold text-[var(--color-ink)]">Error diff</h3>
      {children}
    </section>
  );
}

export function ErrorDiff({ checkId, runId }: { checkId: number; runId?: number | null }) {
  const { data, error, isLoading } = useErrorDiff(checkId, runId);

  if (isLoading && data === undefined) {
    return (
      <Shell>
        <Spinner label="Diffing errors…" />
      </Shell>
    );
  }
  if (error) {
    return (
      <Shell>
        <p className="text-[12px] text-[var(--color-ink-dim)]" data-testid="error-diff-error">
          Couldn’t load the error diff right now.
        </p>
      </Shell>
    );
  }
  // 404 → null: no error signals for this run (e.g. a non-browser check, or no trace yet) → self-hide.
  if (!data) return null;

  const newFirst = data.new_errors.filter(isFirstParty).length;
  const runs = data.baseline_run_count;
  const context = `run #${data.run_id} · vs the last ${runs} run${runs === 1 ? "" : "s"}${data.location ? ` · ${data.location}` : ""}`;

  return (
    <Shell>
      <p className="sw-mono mb-2 text-[11px] text-[var(--color-ink-faint)]" data-testid="error-diff-context">
        {context}
      </p>

      {data.truncated && (
        <p
          className="mb-2 rounded border border-[var(--color-warn)] px-2 py-1 text-[11px] text-[var(--color-ink-dim)]"
          style={{ borderColor: `color-mix(in srgb, ${TONE_VAR.warn} 40%, transparent)`, background: `color-mix(in srgb, ${TONE_VAR.warn} 8%, transparent)` }}
          data-testid="error-diff-truncated"
        >
          Some errors were dropped from capture (cap reached) — this diff may be incomplete.
        </p>
      )}

      {/* NEW — leads, always expanded (the regression signal). */}
      <div data-testid="error-diff-new">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[12px] font-semibold text-[var(--color-ink)]">New</span>
          <span className="sw-mono text-[11px] text-[var(--color-ink-faint)]">
            {newFirst} first-party{data.counts.new_third_party > 0 ? ` · ${data.counts.new_third_party} third-party` : ""}
          </span>
        </div>
        {data.new_errors.length === 0 ? (
          <p className="text-[12px] text-[var(--color-pass)]" data-testid="error-diff-empty">
            ✓ No new errors vs the last {runs} run{runs === 1 ? "" : "s"}.
          </p>
        ) : (
          <Bucket items={data.new_errors} testId="error-diff-new-body" />
        )}
      </div>

      <CollapsedBucket label="Persistent" items={data.persistent} testId="error-diff-persistent" />
      <CollapsedBucket label="Resolved" items={data.resolved} testId="error-diff-resolved" />
    </Shell>
  );
}
