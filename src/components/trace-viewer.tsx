"use client";

import { useState } from "react";

/**
 * The Playwright trace-viewer embed: a toggle button + a .zip download + the self-hosted viewer
 * iframe (public/trace-viewer), fed a SAME-ORIGIN proxy path so the viewer's fetch() isn't
 * CORS-blocked (see app/trace-proxy/*). ONE embed, shared by failure-run forensics (RunArtifacts)
 * and the monitor's last-known-good SUCCESS trace — so they can't drift apart. Caller supplies the
 * proxy path + labels + test-ids (so each call keeps its own e2e hooks).
 */
export function TraceViewer({
  proxyPath,
  openLabel,
  iframeTitle,
  viewTestId,
  iframeTestId,
}: {
  /** Same-origin proxy path that streams the trace.zip (e.g. /trace-proxy/123 or /trace-proxy/check/74). */
  proxyPath: string;
  /** Button label when the viewer is collapsed (e.g. "▸ View trace"). Expanded is always "▾ Hide trace". */
  openLabel: string;
  iframeTitle: string;
  viewTestId: string;
  iframeTestId: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="sw-btn sw-btn-sm sw-btn-primary"
          data-testid={viewTestId}
        >
          {open ? "▾ Hide trace" : openLabel}
        </button>
        <a href={proxyPath} download className="sw-btn sw-btn-sm">
          ↓ Download (.zip)
        </a>
      </div>
      {open && (
        // Self-hosted viewer fed the SAME-ORIGIN proxy URL (absolute — the viewer resolves ?trace=
        // relative to /trace-viewer/, not this page). The min-h floor keeps the embed above the
        // vendored viewer's intrinsic 450px min-height so it fills cleanly without a double scrollbar.
        <div className="mt-2 overflow-hidden rounded-lg border border-[var(--color-border)]">
          <iframe
            title={iframeTitle}
            src={`/trace-viewer/index.html?trace=${encodeURIComponent(
              (typeof window !== "undefined" ? window.location.origin : "") + proxyPath,
            )}`}
            className="block h-[70vh] min-h-[480px] w-full bg-white"
            data-testid={iframeTestId}
          />
        </div>
      )}
    </div>
  );
}
