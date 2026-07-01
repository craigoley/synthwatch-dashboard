"use client";

/**
 * Shared recovery UI for Next App-Router route-segment error boundaries (app/error.tsx + the segment ones).
 * It renders INSIDE the root layout, so the app shell + nav stay alive — a render throw degrades to an inline
 * panel, not a white screen. The error is ALWAYS logged (never swallowed — a boundary that hides the error is
 * its own black box) and the Next `digest` is shown so a user can quote it. `reset()` re-renders the segment.
 */

import { useEffect } from "react";
import Link from "next/link";

import { record } from "@/lib/breadcrumbs";

export interface RouteError extends Error {
  digest?: string;
}

export function ErrorFallback({
  error,
  reset,
  title,
  detail,
}: {
  error: RouteError;
  reset: () => void;
  title?: string;
  detail?: string;
}) {
  useEffect(() => {
    // never swallow a render error; surface it for debugging
    console.error("[error-boundary]", error);
    record("boundary", error.message || String(error), error.digest);
  }, [error]);

  return (
    <div
      className="sw-panel p-6"
      style={{ borderColor: "color-mix(in srgb, var(--color-fail) 40%, transparent)" }}
      role="alert"
      data-testid="error-boundary"
    >
      <div className="sw-mono text-xs tracking-wider" style={{ color: "var(--color-fail)" }}>
        ERROR
      </div>
      <h2 className="mt-1 text-base font-semibold text-[var(--color-ink)]">
        {title ?? "Couldn’t load this view"}
      </h2>
      <p className="mt-1 max-w-prose text-sm text-[var(--color-ink-dim)]">
        {detail ??
          "Something went wrong rendering this page. The rest of the app still works — use the nav above, or retry."}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" onClick={reset} className="sw-btn sw-btn-primary" data-testid="error-retry">
          Retry
        </button>
        <Link href="/" className="sw-btn sw-btn-ghost">
          Go to dashboard
        </Link>
      </div>
      {error.digest && (
        <p className="mt-3 sw-mono text-[11px] text-[var(--color-ink-faint)]" data-testid="error-digest">
          ref: {error.digest}
        </p>
      )}
    </div>
  );
}
