"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Staleness visibility for the fetch-once aggregate panels (SLO/MTTR/trust — no poll). A tab left open shows
 * hour-old data with nothing signaling it; this pairs an honest "fetched HH:MM" stamp with a manual refresh
 * (SWR `mutate`). ★ The label is "fetched" — CLIENT fetch time — because these endpoints return no server
 * "as of" timestamp; it says when the BROWSER last got the data, not when the DATA was computed.
 */

/**
 * The wall-clock time (ms) of the panel's last successful fetch — stamped on the first load and on every
 * completed revalidation (isValidating true→false), so a manual refresh advances it even when the data is
 * byte-identical (SWR keeps the same reference then, so keying on `data` alone would miss it).
 */
export function useFetchedAt(isValidating: boolean, hasData: boolean): number | null {
  const [at, setAt] = useState<number | null>(null);
  const prevValidating = useRef(isValidating);
  const initialized = useRef(false);
  useEffect(() => {
    const completed = prevValidating.current && !isValidating; // a fetch just finished
    prevValidating.current = isValidating;
    if (hasData && (completed || !initialized.current)) {
      initialized.current = true;
      setAt(Date.now());
    }
  }, [isValidating, hasData]);
  return at;
}

function hhmm(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Small, unobtrusive "fetched HH:MM · ↻" caption. Renders nothing until the first fetch lands. */
export function StalenessStamp({
  fetchedAt,
  onRefresh,
  refreshing,
  testId,
}: {
  fetchedAt: number | null;
  onRefresh: () => void;
  refreshing: boolean;
  /** e.g. "fleet-slo" → stamp testid `fleet-slo-fetched`, button `fleet-slo-refresh`. */
  testId?: string;
}) {
  if (fetchedAt == null) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] text-[var(--color-ink-faint)]">
      <span data-testid={testId ? `${testId}-fetched` : undefined} title="Client fetch time — not a server 'as of' timestamp">
        fetched {hhmm(fetchedAt)}
      </span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        aria-label="Refresh"
        data-testid={testId ? `${testId}-refresh` : undefined}
        className="rounded px-1 leading-none text-[var(--color-ink-dim)] transition hover:text-[var(--color-ink)] disabled:opacity-50"
      >
        <span className={refreshing ? "inline-block sw-spin" : "inline-block"} aria-hidden>↻</span>
      </button>
    </span>
  );
}
