"use client";

import { useState } from "react";

import { useErrorDiff, useErrorMutes } from "@/lib/client";
import { muteError, unmuteError } from "@/lib/api-client";
import type { ErrorItem, ErrorDiff as ErrorDiffData } from "@/lib/api-client";
import { useAuth } from "@/components/auth-provider";
import { Spinner } from "@/components/states";
import { TONE_VAR } from "@/components/status-badge";
import { formatRelative } from "@/lib/format";

/**
 * Error diff (P3) + anti-fatigue (P4) — Craig's ask: "see new JS/API/page errors that didn't exist on the last
 * run". This run's errors vs the UNION of the last N settled runs (anti-flap). NEW leads + is expanded (the
 * regression signal); persistent/resolved collapse below. FIRST-PARTY by default — third-party tracker noise is
 * hidden behind a counted toggle. Items arrive already severity-sorted from the API (first-party 5xx first).
 *
 * P4 adds: (a) DEPLOY ATTRIBUTION — a NEW error shows the deploy it first appeared after ("first seen after
 * deploy abc1234 · 2h ago"), correlation not causation. (b) MUTE — an editor mutes a known/accepted NEW error
 * per-monitor; it leaves NEW and joins a collapsed "N muted" disclosure (never silently dropped) with an unmute
 * action. Mute is per-monitor and persists until unmuted (no localStorage — it's server state).
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

/** The deploy a NEW error first appeared after (P4). Correlation, never causation — worded as "first seen after". */
function DeployAttribution({ item }: { item: ErrorItem }) {
  const d = item.first_seen_after_deploy;
  if (!d) return null;
  const when = d.deployed_at ? formatRelative(d.deployed_at) : "";
  return (
    <div className="sw-mono mt-0.5 text-[10px] text-[var(--color-warn)]" data-testid="ediff-deploy">
      ↑ first seen after {d.sha ? <>deploy <b>{d.sha.slice(0, 7)}</b></> : "a deploy"}
      {d.target_host ? ` · ${d.target_host}` : ""}
      {when ? ` · ${when}` : ""}
    </div>
  );
}

function ErrorRow({ item, action }: { item: ErrorItem; action?: React.ReactNode }) {
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
        <DeployAttribution item={item} />
        {action}
      </div>
    </div>
  );
}

/** Per-NEW-row mute affordance (P4). Editor-only (server-gated regardless). Click → inline note field → mute;
 *  no browser dialog (those block the page). On success the parent revalidates → the row leaves NEW. */
function MuteControl({
  checkId,
  item,
  onChanged,
}: {
  checkId: number;
  item: ErrorItem;
  onChanged: () => Promise<void>;
}) {
  const { canWrite, promptLogin } = useAuth();
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  if (!canWrite) return null;

  async function doMute() {
    setBusy(true);
    setErr(false);
    try {
      await muteError(checkId, item.fingerprint, note);
      await onChanged();
      // component unmounts when the row leaves NEW; no need to reset editing.
    } catch {
      setErr(true);
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        data-testid="ediff-mute-btn"
        className="sw-mono mt-1 text-[10px] text-[var(--color-ink-faint)] transition hover:text-[var(--color-ink)]"
      >
        mute
      </button>
    );
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="note (optional)"
        data-testid="ediff-mute-note"
        className="sw-mono w-40 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[11px]"
      />
      <button
        type="button"
        onClick={doMute}
        disabled={busy}
        data-testid="ediff-mute-confirm"
        className="sw-btn sw-btn-sm"
      >
        {busy ? "Muting…" : "Mute"}
      </button>
      <button
        type="button"
        onClick={() => {
          setEditing(false);
          setNote("");
        }}
        className="sw-mono text-[10px] text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
      >
        cancel
      </button>
      {err && <span className="text-[10px]" style={{ color: TONE_VAR.fail }} onClick={() => void promptLogin()}>couldn’t mute</span>}
    </div>
  );
}

/** Third-party items behind a counted disclosure — the anti-fatigue control (tracker noise stays hidden). */
function ThirdPartyItems({ items, renderAction }: { items: ErrorItem[]; renderAction?: (i: ErrorItem) => React.ReactNode }) {
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
            <ErrorRow key={i.fingerprint} item={i} action={renderAction?.(i)} />
          ))}
        </div>
      )}
    </div>
  );
}

/** First-party items listed, third-party behind the toggle. `renderAction` (P4 mute) applies to every row. */
function Bucket({
  items,
  testId,
  renderAction,
}: {
  items: ErrorItem[];
  testId: string;
  renderAction?: (i: ErrorItem) => React.ReactNode;
}) {
  const first = items.filter(isFirstParty);
  const third = items.filter((i) => !isFirstParty(i));
  return (
    <div data-testid={testId}>
      {first.map((i) => (
        <ErrorRow key={i.fingerprint} item={i} action={renderAction?.(i)} />
      ))}
      {first.length === 0 && third.length > 0 && (
        <p className="text-[11px] text-[var(--color-ink-dim)]">No first-party errors.</p>
      )}
      <ThirdPartyItems items={third} renderAction={renderAction} />
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

/** P4 muted disclosure — collapsed "N muted", listing the muted errors present this run (message + note) with an
 *  unmute action. VISIBLE-on-demand, never invisible: a muted error is out of NEW but still discoverable here. */
function MutedDisclosure({
  checkId,
  items,
  notesByFp,
  onChanged,
}: {
  checkId: number;
  items: ErrorItem[];
  notesByFp: Map<string, string | null>;
  onChanged: () => Promise<void>;
}) {
  const { canWrite } = useAuth();
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div className="mt-2 border-t border-[var(--color-border)] pt-2" data-testid="error-diff-muted">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid="error-diff-muted-toggle"
        className="flex w-full items-center gap-1.5 text-left text-[12px] font-medium text-[var(--color-ink-dim)]"
      >
        <span className="text-[10px] text-[var(--color-ink-faint)]">{open ? "▾" : "▸"}</span>
        Muted <span className="sw-mono text-[var(--color-ink-faint)]">({items.length})</span>
      </button>
      {open && (
        <div className="mt-1" data-testid="error-diff-muted-list">
          {items.map((i) => (
            <MutedRow
              key={i.fingerprint}
              checkId={checkId}
              item={i}
              note={notesByFp.get(i.fingerprint) ?? null}
              canWrite={canWrite}
              onChanged={onChanged}
            />
          ))}
          <p className="sw-mono mt-1.5 text-[10px] text-[var(--color-ink-faint)]">
            Muting is per-monitor and persists until you unmute.
          </p>
        </div>
      )}
    </div>
  );
}

function MutedRow({
  checkId,
  item,
  note,
  canWrite,
  onChanged,
}: {
  checkId: number;
  item: ErrorItem;
  note: string | null;
  canWrite: boolean;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  async function doUnmute() {
    setBusy(true);
    try {
      await unmuteError(checkId, item.fingerprint);
      await onChanged();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex items-start gap-2 py-1" data-testid="ediff-muted-row">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] leading-snug text-[var(--color-ink-dim)]" title={item.message}>
          {item.message}
        </div>
        <div className="sw-mono mt-0.5 truncate text-[10px] text-[var(--color-ink-faint)]">
          {item.source_host || "—"} · {item.kind}
          {note ? ` · “${note}”` : ""}
        </div>
      </div>
      {canWrite && (
        <button
          type="button"
          onClick={doUnmute}
          disabled={busy}
          data-testid="ediff-unmute-btn"
          className="sw-mono mt-0.5 shrink-0 text-[10px] text-[var(--color-ink-faint)] transition hover:text-[var(--color-ink)]"
        >
          {busy ? "…" : "unmute"}
        </button>
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

/**
 * TRUNCATION, BY CLASS — honest AND informative. Stay LOUD (warn tone) when the cap dropped a FIRST-PARTY
 * message (the diff may have lost real signal) OR when the drop CLASS is UNKNOWN — an older API / a dashboard
 * deployed ahead of synthwatch-api#229 omits the class fields, and honest-render forbids rendering an unknown
 * state as a healthy one ("first-party capture is complete" is a claim we can't prove there). Go CALM only when
 * we AFFIRMATIVELY know the drop was third-party (tracker) noise only (`dropped_third_party > 0`).
 */
function TruncationNote({ diff }: { diff: ErrorDiffData }) {
  if (!diff.truncated) return null;
  // Affirmatively third-party-only → calm; first-party capture is genuinely complete.
  if (!diff.first_party_truncated && diff.dropped_third_party > 0) {
    return (
      <p
        className="mb-2 rounded border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-ink-faint)]"
        data-testid="error-diff-truncated-third-party"
      >
        {diff.dropped_third_party} third-party {diff.dropped_third_party === 1 ? "error was" : "errors were"} dropped
        from capture — first-party capture is complete.
      </p>
    );
  }
  // First-party dropped, OR the class is unknown (old API) → LOUD; never imply a completeness we can't prove.
  return (
    <p
      className="mb-2 rounded border border-[var(--color-warn)] px-2 py-1 text-[11px] text-[var(--color-ink-dim)]"
      style={{ borderColor: `color-mix(in srgb, ${TONE_VAR.warn} 40%, transparent)`, background: `color-mix(in srgb, ${TONE_VAR.warn} 8%, transparent)` }}
      data-testid="error-diff-truncated"
    >
      {diff.first_party_truncated
        ? "First-party errors were dropped from capture (cap reached) — this diff may be incomplete."
        : "Some errors were dropped from capture (cap reached) — this diff may be incomplete."}
    </p>
  );
}

export function ErrorDiff({ checkId, runId }: { checkId: number; runId?: number | null }) {
  const { data, error, isLoading, mutate } = useErrorDiff(checkId, runId);
  const { data: mutes, mutate: mutateMutes } = useErrorMutes(checkId);

  // Revalidate BOTH reads after a mute/unmute so the row moves buckets + the notes stay in sync.
  const onChanged = async () => {
    await Promise.all([mutate(), mutateMutes()]);
  };

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
  const notesByFp = new Map((mutes ?? []).map((m) => [m.fingerprint, m.note] as const));

  return (
    <Shell>
      <p className="sw-mono mb-2 text-[11px] text-[var(--color-ink-faint)]" data-testid="error-diff-context">
        {context}
      </p>

      <TruncationNote diff={data} />

      {/* NEW — leads, always expanded (the regression signal). Each row can be muted (editor). */}
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
          <Bucket
            items={data.new_errors}
            testId="error-diff-new-body"
            renderAction={(i) => <MuteControl checkId={checkId} item={i} onChanged={onChanged} />}
          />
        )}
      </div>

      <MutedDisclosure checkId={checkId} items={data.muted} notesByFp={notesByFp} onChanged={onChanged} />
      <CollapsedBucket label="Persistent" items={data.persistent} testId="error-diff-persistent" />
      <CollapsedBucket label="Resolved" items={data.resolved} testId="error-diff-resolved" />
    </Shell>
  );
}

/**
 * ★ The RUN-SCOPED join: the NEW FIRST-PARTY errors captured DURING THIS run, rendered inline on a FAILED
 * run (next to the failed step / error message) so the operator sees the step failure AND the run's new
 * error signal WITHOUT opening the monitor-level <ErrorDiff> panel. (Run 955866: `add-bread` failed while a
 * first-party `Failed to fetch` fired — both facts were already in the UI, in different panels, and nobody
 * joined them.) Reuses the same `getErrorDiff(checkId,{runId})` read + the same rows/badges as the panel.
 *
 * Contract — this IS the point:
 *  - CITES, never GUESSES. Shows only errors actually captured in this run; NEVER asserts a cause — the facts
 *    sit adjacent, the operator concludes. (An inferred cause would be a new lying signal — the one we refuse.)
 *  - FIRST-PARTY only by default; third-party stays behind the existing counted toggle (tracker noise would
 *    drown the signal, exactly as in the panel).
 *  - Per-RUN, not per-step: error items carry no per-occurrence timestamp (steps have `startedAt`; the diff
 *    aggregates by fingerprint), so an error can't be pinned to one step — the honest scope is "this run".
 *  - "No new first-party errors" is stated EXPLICITLY (itself diagnostic — the failure carried no new error
 *    signal), but ONLY when capture was COMPLETE; a truncated capture says so instead of implying "none".
 */
export function RunNewFirstPartyErrors({ checkId, runId }: { checkId: number; runId: number }) {
  const { data, error, isLoading } = useErrorDiff(checkId, runId);
  // Broken ≠ absent: a failed load says so quietly (the monitor-level panel carries the loud state) rather
  // than render a blank that would read as "no errors".
  if (error) {
    return (
      <p className="sw-mono mt-3 text-[11px] text-[var(--color-ink-dim)]" data-testid="run-new-errors-error">
        Couldn’t load this run’s new-error signal.
      </p>
    );
  }
  // Quiet until loaded (the run body already shows the failure), and self-hide when there are NO error
  // signals for this run at all (404 → null: a non-browser check, or a run with no captured trace) — nothing
  // to cite, and we can't distinguish that from "no new errors".
  if ((isLoading && data === undefined) || !data) return null;

  const firstParty = data.new_errors.filter(isFirstParty);
  const third = data.new_errors.filter((i) => !isFirstParty(i));

  return (
    <div
      className="mt-3 rounded border-l-2 px-3 py-2"
      style={{
        borderColor: `color-mix(in srgb, ${TONE_VAR.warn} 45%, transparent)`,
        background: `color-mix(in srgb, ${TONE_VAR.warn} 6%, transparent)`,
      }}
      data-testid="run-new-errors"
    >
      <div className="mb-1 sw-eyebrow">New first-party errors this run</div>
      {firstParty.length > 0 ? (
        <>
          <div data-testid="run-new-errors-list">
            {firstParty.map((i) => (
              <ErrorRow key={i.fingerprint} item={i} />
            ))}
          </div>
          <ThirdPartyItems items={third} />
          {data.truncated && (
            <p className="sw-mono mt-1.5 text-[10px] text-[var(--color-warn)]" data-testid="run-new-errors-truncated">
              ⚠ Error capture was truncated (cap reached) — there may be more first-party errors than shown.
            </p>
          )}
          <p className="sw-mono mt-1.5 text-[10px] text-[var(--color-ink-faint)]">
            Captured during this run — shown next to the failure, not inferred as its cause.
          </p>
        </>
      ) : data.truncated ? (
        <p className="text-[12px] text-[var(--color-ink-dim)]" data-testid="run-new-errors-truncated">
          Error capture was truncated this run (cap reached) — first-party errors may be incomplete, so “no
          new errors” can’t be concluded.
        </p>
      ) : (
        <>
          <p className="text-[12px] text-[var(--color-ink)]" data-testid="run-new-errors-none">
            No new first-party errors this run — the failure was not accompanied by a new error signal.
          </p>
          <ThirdPartyItems items={third} />
        </>
      )}
    </div>
  );
}
