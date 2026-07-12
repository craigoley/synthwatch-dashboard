"use client";

import { useState } from "react";

import type { TraceSas } from "@/lib/types";

/**
 * The Playwright trace-viewer embed: a toggle button + a .zip download + the self-hosted viewer iframe
 * (public/trace-viewer). The viewer/Download fetch the trace blob DIRECTLY via a short-TTL SAS the API mints
 * (auth-gated) — NOT through a Vercel serverless proxy, which can't stream a 124MB trace (it cuts off at its
 * ~15s maxDuration, truncating the fetch → "Could not load trace"). One path for all trace sizes.
 *
 * The caller supplies `mintSas` (which API endpoint to call — run trace vs monitor success trace) + labels +
 * test-ids. A fresh SAS is minted on each open and each download (each is single-blob, read-only, ~2 min).
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
  const [sasUrl, setSasUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function messageOf(e: unknown): string {
    const raw = e instanceof Error ? e.message : String(e);
    if (/401|403|sign in/i.test(raw)) return "Sign in to view traces.";
    return `Could not load trace: ${raw}`;
  }

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (sasUrl) return; // already minted for this mount
    setLoading(true);
    setError(null);
    try {
      const sas = await mintSas();
      setSasUrl(sas.url);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setLoading(false);
    }
  }

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
          {loading || !sasUrl ? (
            <div className="p-4 text-sm text-[var(--color-ink-dim)]">Loading trace…</div>
          ) : (
            <iframe
              title={iframeTitle}
              src={`/trace-viewer/index.html?trace=${encodeURIComponent(sasUrl)}`}
              className="block h-[70vh] min-h-[480px] w-full bg-white"
              data-testid={iframeTestId}
            />
          )}
        </div>
      )}
    </div>
  );
}
