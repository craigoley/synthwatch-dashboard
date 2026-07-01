"use client";

/**
 * Top-level catch — fires only when the ROOT LAYOUT itself throws (or app/error.tsx does). It REPLACES the
 * root layout, so it must render its own <html>/<body> and CANNOT rely on globals.css tokens or the app shell
 * being present — styles are inlined with the brand hex values (kept in sync with globals.css). Logs the error
 * (never swallowed) and shows the digest. `reset()` re-renders the root; the link is a hard fallback.
 */

import { useEffect } from "react";

import { record } from "@/lib/breadcrumbs";

const C = {
  bg: "#090c0f",
  panel: "#121922",
  border: "#212c37",
  ink: "#e9eff4",
  inkDim: "#94a3b0",
  inkFaint: "#5d6b77",
  brand: "#45e3c2",
  fail: "#f15b50",
};

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // a fatal render error must always surface, never be swallowed
    console.error("[global-error]", error);
    record("boundary", error.message || String(error), error.digest);
  }, [error]);

  const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          background: C.bg,
          color: C.ink,
          fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          role="alert"
          data-testid="global-error"
          style={{
            maxWidth: 460,
            width: "calc(100% - 32px)",
            padding: 28,
            background: C.panel,
            border: `1px solid ${C.border}`,
            borderRadius: 12,
            textAlign: "center",
          }}
        >
          <div style={{ fontFamily: mono, fontSize: 12, letterSpacing: "0.12em", color: C.fail }}>
            FATAL ERROR
          </div>
          <h1 style={{ margin: "8px 0 0", fontSize: 20, fontWeight: 600 }}>
            SynthWatch hit an unexpected error
          </h1>
          <p style={{ margin: "8px 0 0", fontSize: 14, color: C.inkDim }}>
            The console couldn’t render. Reload to recover — if it persists, the digest below identifies the
            failure.
          </p>
          <div style={{ marginTop: 20, display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={reset}
              data-testid="global-error-reset"
              style={{
                cursor: "pointer",
                padding: "8px 16px",
                fontSize: 13,
                fontWeight: 600,
                color: C.bg,
                background: C.brand,
                border: "none",
                borderRadius: 8,
              }}
            >
              Reload
            </button>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- the root layout threw; a HARD
                reload (not client nav) is the correct recovery, and next/link can't be trusted in this state */}
            <a
              href="/"
              style={{
                padding: "8px 16px",
                fontSize: 13,
                color: C.ink,
                background: "transparent",
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                textDecoration: "none",
              }}
            >
              Go to dashboard
            </a>
          </div>
          {error.digest && (
            <p style={{ marginTop: 12, fontFamily: mono, fontSize: 11, color: C.inkFaint }}>
              ref: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
