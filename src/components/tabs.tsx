"use client";

import { useEffect, useState } from "react";

export interface TabDef {
  id: string;
  label: string;
}

/**
 * URL-synced tab state (?tab=<id>). Mirrors useGroupBy/useTagFilter: history.replaceState (no Suspense, no
 * router push), reads the param on mount so a deep-link / back-forward lands on the right tab. The fallback tab
 * carries no query param (clean default URL); any other tab writes ?tab=<id>.
 */
export function useTab(ids: readonly string[], fallback: string) {
  const [tab, setTabState] = useState(fallback);
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t && ids.includes(t)) setTabState(t);
  }, [ids]);
  const setTab = (t: string) => {
    setTabState(t);
    const url = new URL(window.location.href);
    if (t && t !== fallback) url.searchParams.set("tab", t);
    else url.searchParams.delete("tab");
    window.history.replaceState(null, "", url.toString());
  };
  return { tab, setTab };
}

/**
 * Segmented tab bar — reuses the visual language of the existing window toggle (bordered pill, active fill).
 *
 * ★ MOBILE: the row WRAPS (max-w-full flex-wrap) instead of overflowing the viewport. The old inline-flex
 * row clipped at phone width with no scroll affordance — "Cost" rendered half-bisected by the screen edge,
 * a hidden-navigation failure (a tab you can't see doesn't exist). Wrapping means NOTHING is ever hidden:
 * all six labels are short enough for two rows at 390px, matching the app header's own wrap-to-two-rows
 * mobile solution (app-shell.tsx) rather than inventing a scroll+fade mechanism for six short labels.
 * Buttons get a ≥44px touch target on mobile (min-h-11), reset to the original compact height from sm: up.
 */
export function TabBar({
  tabs,
  active,
  onSelect,
  label = "Sections",
}: {
  tabs: TabDef[];
  active: string;
  onSelect: (id: string) => void;
  label?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="inline-flex max-w-full flex-wrap gap-y-0.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] p-0.5"
    >
      {tabs.map((t) => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={isActive}
            data-testid={`reports-tab-${t.id}`}
            onClick={() => onSelect(t.id)}
            className={`min-h-11 rounded-md px-3 py-1 text-xs font-medium transition sm:min-h-0 ${
              isActive
                ? "bg-[var(--color-panel-2)] text-[var(--color-ink)]"
                : "text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
