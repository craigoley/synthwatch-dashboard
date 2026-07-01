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

/** Segmented tab bar — reuses the visual language of the existing window toggle (bordered pill, active fill). */
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
      className="inline-flex rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] p-0.5"
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
            className={`rounded-md px-3 py-1 text-xs font-medium transition ${
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
