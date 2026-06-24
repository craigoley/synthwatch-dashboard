"use client";

import { useEffect, useState } from "react";

import type { Tag, TagInUse } from "@/lib/types";

const eq = (a: Tag, b: Tag) => a.key === b.key && a.value === b.value;

/**
 * Filter semantics: AND across all selected tags — a row must carry EVERY selected
 * tag to show (matches Datadog's default scope behavior). Empty selection = show all.
 */
export function matchesTags(rowTags: Tag[] | undefined, selected: Tag[]): boolean {
  if (selected.length === 0) return true;
  const tags = rowTags ?? [];
  return selected.every((sel) => tags.some((t) => eq(t, sel)));
}

const serialize = (tags: Tag[]) => tags.map((t) => `${t.key}:${t.value}`).join(",");
function parse(qs: string | null): Tag[] {
  if (!qs) return [];
  return qs
    .split(",")
    .map((part) => {
      const i = part.indexOf(":");
      return i > 0 ? { key: part.slice(0, i).trim(), value: part.slice(i + 1).trim() } : null;
    })
    .filter((t): t is Tag => t !== null && t.key !== "" && t.value !== "");
}

/**
 * URL-synced tag selection (shareable/bookmarkable as `?tags=env:prod,team:web`).
 * Uses history.replaceState (not useSearchParams) so no Suspense boundary is needed.
 */
export function useTagFilter() {
  const [selected, setSelected] = useState<Tag[]>([]);

  // Hydrate from the URL on mount (client-only).
  useEffect(() => {
    const fromUrl = parse(new URLSearchParams(window.location.search).get("tags"));
    if (fromUrl.length) setSelected(fromUrl);
  }, []);

  const sync = (next: Tag[]) => {
    setSelected(next);
    const url = new URL(window.location.href);
    if (next.length) url.searchParams.set("tags", serialize(next));
    else url.searchParams.delete("tags");
    window.history.replaceState(null, "", url.toString());
  };

  return {
    selected,
    toggle: (t: Tag) =>
      sync(selected.some((s) => eq(s, t)) ? selected.filter((s) => !eq(s, t)) : [...selected, t]),
    clear: () => sync([]),
  };
}

/**
 * The filter control: in-use tags as toggle chips (the control AND the active-state
 * display in one). Renders nothing when there are no tags to filter by.
 */
export function TagFilter({
  available,
  selected,
  onToggle,
  onClear,
  resultLabel,
}: {
  available: TagInUse[];
  selected: Tag[];
  onToggle: (t: Tag) => void;
  onClear: () => void;
  resultLabel?: string;
}) {
  if (available.length === 0) return null;
  const active = selected.length > 0;
  return (
    <div className="sw-panel space-y-2 p-3" data-testid="tag-filter">
      <div className="flex items-center justify-between gap-3">
        <span className="sw-eyebrow">Filter by tag</span>
        {active && (
          <button
            type="button"
            onClick={onClear}
            data-testid="clear-tag-filter"
            className="sw-mono text-[11px] text-[var(--color-ink-faint)] transition hover:text-[var(--color-ink)]"
          >
            Clear ✕
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {available.map((t) => {
          const on = selected.some((s) => eq(s, t));
          return (
            <button
              key={`${t.key}:${t.value}`}
              type="button"
              role="checkbox"
              aria-checked={on}
              aria-label={`filter ${t.key}:${t.value}`}
              onClick={() => onToggle({ key: t.key, value: t.value })}
              className={`sw-mono inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition ${
                on
                  ? "border-[var(--color-brand-dim)] bg-[color-mix(in_srgb,var(--color-brand)_14%,transparent)] text-[var(--color-ink)]"
                  : "border-[var(--color-border-strong)] bg-[var(--color-bg)] text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
              }`}
            >
              <span>
                <span className="text-[var(--color-ink-faint)]">{t.key}:</span>
                {t.value}
              </span>
              <span className="text-[var(--color-ink-faint)]">{t.count}</span>
            </button>
          );
        })}
      </div>
      {active && resultLabel && (
        <span className="block text-[11px] text-[var(--color-ink-faint)]" data-testid="filter-result">
          {resultLabel}
        </span>
      )}
    </div>
  );
}
