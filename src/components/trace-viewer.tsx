"use client";

import { useEffect, useState } from "react";

import type { TraceSas } from "@/lib/types";

/**
 * The Playwright trace-viewer embed: a toggle button + a .zip download + the self-hosted viewer iframe
 * (public/trace-viewer). The viewer/Download fetch the trace blob DIRECTLY via a short-TTL SAS the API mints
 * (auth-gated) — NOT through a Vercel serverless proxy, which can't stream a 124MB trace (it cuts off at its
 * ~15s maxDuration, truncating the fetch → "Could not load trace"). One path for all trace sizes.
 *
 * ★ The viewer is a STREAMING READER: its service worker lazily range-fetches entries from the SAS URL
 * THROUGHOUT the investigation, so the SAS must stay valid for the whole session (the API TTL is now 30 min,
 * not 2). When it DOES lapse, Azure returns an XML signature 403 INSIDE the cross-origin iframe that reads as
 * "you lack permission" — a forensics tool lying about itself. We can't intercept that cross-origin error, but
 * we DO know `expires_at`, so we surface the lapse PROACTIVELY: past expiry we replace the iframe with a plain
 * "link expired — Re-open" panel, and re-opening mints a FRESH SAS (never re-loads a dead URL into the iframe).
 *
 * The caller supplies `mintSas` (which API endpoint to call — run trace vs monitor success trace) + labels +
 * test-ids. A fresh SAS is minted on each open (if the cached one lapsed), each re-open, and each download.
 */
export function TraceViewer({
  mintSas,
  openLabel,
  iframeTitle,
  viewTestId,
  iframeTestId,
  downloadTestId,
}: {
  /** Mints a short-TTL read-only SAS for THIS trace (e.g. () => getRunTraceSas(run.id)). */
  mintSas: () => Promise<TraceSas>;
  /** Button label when the viewer is collapsed (e.g. "▸ View trace"). Expanded is always "▾ Hide trace". */
  openLabel: string;
  iframeTitle: string;
  viewTestId: string;
  iframeTestId: string;
  downloadTestId?: string;
}) {
  const [open, setOpen] = useState(false);
  // The live SAS: its URL + the epoch-ms it lapses (from expires_at — previously ignored). null = none minted.
  const [sas, setSas] = useState<{ url: string; expiresAtMs: number } | null>(null);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function messageOf(e: unknown): string {
    const raw = e instanceof Error ? e.message : String(e);
    if (/401|403|sign in/i.test(raw)) return "Sign in to view traces.";
    return `Could not load trace: ${raw}`;
  }

  // Mint a fresh SAS and (re)load the viewer. Used on first open, on re-open of a lapsed SAS, and on the
  // explicit "Re-open" after expiry. Drops any stale SAS — never feeds a dead URL to the iframe.
  async function mintFresh() {
    setLoading(true);
    setError(null);
    setExpired(false);
    setSas(null); // drop the (possibly lapsed) SAS BEFORE the await, so the expiry effect can't re-fire on it
    try {
      const s = await mintSas();
      setSas({ url: s.url, expiresAtMs: Date.parse(s.expires_at) });
    } catch (e) {
      setSas(null);
      setError(messageOf(e));
    } finally {
      setLoading(false);
    }
  }

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    // Reuse the cached SAS ONLY while it is still valid; a lapsed one is dropped and re-minted (else the iframe
    // would load an expired URL → the Azure XML 403 the user reads as "access denied").
    if (sas && sas.expiresAtMs > Date.now() && !expired) return;
    await mintFresh();
  }

  // While open on a valid SAS, arm a timer for the exact moment it lapses → flip to the legible expired panel
  // (the viewer's own range-fetches would otherwise start 403ing silently inside the iframe).
  useEffect(() => {
    if (!open || !sas || expired) return;
    const ms = sas.expiresAtMs - Date.now();
    if (ms <= 0) {
      setExpired(true);
      return;
    }
    const t = setTimeout(() => setExpired(true), ms);
    return () => clearTimeout(t);
  }, [open, sas, expired]);

  async function download() {
    setError(null);
    try {
      const sas = await mintSas(); // fresh SAS — starts the direct blob download in a new tab
      window.open(sas.url, "_blank", "noopener");
    } catch (e) {
      setError(messageOf(e));
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="sw-btn sw-btn-sm sw-btn-primary"
          data-testid={viewTestId}
        >
          {open ? "▾ Hide trace" : openLabel}
        </button>
        <button type="button" onClick={download} className="sw-btn sw-btn-sm" data-testid={downloadTestId}>
          ↓ Download (.zip)
        </button>
      </div>

      {error && (
        <p className="mt-2 text-[13px] text-[var(--color-danger)]" data-testid="trace-error">
          {error}
        </p>
      )}

      {open && !error && (
        // Self-hosted viewer fed the ABSOLUTE SAS URL (the viewer resolves ?trace= relative to /trace-viewer/,
        // and the SAS is cross-origin on the blob account — CORS is configured for the dashboard origin). The
        // min-h floor keeps the embed above the vendored viewer's intrinsic 450px min-height.
        <div className="mt-2 overflow-hidden rounded-lg border border-[var(--color-border)]">
          {expired ? (
            // ★ LEGIBLE EXPIRY: NOT "access denied". The credential lapsed; one click re-opens with a fresh one.
            <div className="p-4 text-sm" data-testid={`${iframeTestId}-expired`}>
              <p className="text-[var(--color-ink)]">
                This trace access link expired (traces stay open for 30&nbsp;minutes). Your access hasn’t
                changed — re-open to keep investigating.
              </p>
              <button
                type="button"
                onClick={mintFresh}
                className="sw-btn sw-btn-sm sw-btn-primary mt-2"
                data-testid={`${iframeTestId}-reopen`}
              >
                ↻ Re-open trace
              </button>
            </div>
          ) : loading || !sas ? (
            <div className="p-4 text-sm text-[var(--color-ink-dim)]">Loading trace…</div>
          ) : (
            <iframe
              title={iframeTitle}
              src={`/trace-viewer/index.html?trace=${encodeURIComponent(sas.url)}`}
              className="block h-[70vh] min-h-[480px] w-full bg-white"
              data-testid={iframeTestId}
            />
          )}
        </div>
      )}
    </div>
  );
}
