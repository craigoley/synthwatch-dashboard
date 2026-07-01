"use client";

/**
 * Debug-only breadcrumb panel. Renders the in-memory error ring ({@link src/lib/breadcrumbs}) as a
 * copy-pasteable timeline, GATED by {@link isDebugPanelOn} — invisible to normal users, appearing ONLY on an
 * explicit per-channel opt-in: `?debug=errors` (or `?debug=all`), or the sticky key `SYNTHWATCH_DEBUG_ERRORS=1`.
 * It deliberately does NOT ride the blanket `SYNTHWATCH_DEBUG=1` console flag (that leaked the panel on for
 * anyone debugging the runs funnel — #159). It also installs the global error/rejection capture once per tab
 * (harmless, in-memory only) so a trail exists to read even if the panel is opened after the fact.
 */

import { useEffect, useState, useSyncExternalStore } from "react";

import { isDebugPanelOn } from "@/lib/debug";
import {
  clearBreadcrumbs,
  getBreadcrumbs,
  getServerBreadcrumbs,
  installErrorCapture,
  subscribe,
  type Breadcrumb,
} from "@/lib/breadcrumbs";

function fmtLine(b: Breadcrumb): string {
  const time = new Date(b.ts).toISOString().slice(11, 23); // HH:MM:SS.mmm
  const ref = b.digest ? ` (ref: ${b.digest})` : "";
  const route = b.route || "—";
  return `${time}  ${b.source.padEnd(18)} ${route}  ${b.message}${ref}`;
}

export function DebugBreadcrumbs() {
  // Capture always installs (in-memory, no user-visible effect); the PANEL is what's gated.
  useEffect(() => {
    installErrorCapture();
  }, []);

  // isDebugPanelOn reads window — resolve after mount to avoid any hydration mismatch (server + first render
  // null). Stricter than isDebugOn: the panel never rides the blanket SYNTHWATCH_DEBUG console flag (#159 leak).
  const [gated, setGated] = useState(false);
  useEffect(() => {
    setGated(isDebugPanelOn("errors"));
  }, []);

  const entries = useSyncExternalStore(subscribe, getBreadcrumbs, getServerBreadcrumbs);

  if (!gated) return null;

  const text = entries.map(fmtLine).join("\n");

  return (
    <div
      data-testid="debug-breadcrumbs"
      className="sw-panel"
      style={{
        position: "fixed",
        bottom: 12,
        right: 12,
        zIndex: 9999,
        width: "min(520px, calc(100vw - 24px))",
        maxHeight: "40vh",
        display: "flex",
        flexDirection: "column",
        padding: 10,
        borderColor: "color-mix(in srgb, var(--color-brand) 40%, transparent)",
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="sw-mono text-[11px] tracking-wider" style={{ color: "var(--color-brand)" }}>
          BREADCRUMBS · {entries.length}
        </span>
        <div className="flex gap-1.5">
          <button
            type="button"
            className="sw-btn sw-btn-ghost"
            data-testid="debug-breadcrumbs-copy"
            onClick={() => {
              void navigator.clipboard?.writeText(text);
            }}
          >
            Copy
          </button>
          <button
            type="button"
            className="sw-btn sw-btn-ghost"
            data-testid="debug-breadcrumbs-clear"
            onClick={() => clearBreadcrumbs()}
          >
            Clear
          </button>
        </div>
      </div>
      {entries.length === 0 ? (
        <p className="mt-2 text-xs" style={{ color: "var(--color-ink-dim)" }}>
          No client errors captured this session.
        </p>
      ) : (
        <pre
          data-testid="debug-breadcrumbs-log"
          className="sw-mono mt-2 flex-1 overflow-auto text-[11px] leading-relaxed"
          style={{ color: "var(--color-ink-dim)", whiteSpace: "pre", margin: 0 }}
        >
          {text}
        </pre>
      )}
    </div>
  );
}
