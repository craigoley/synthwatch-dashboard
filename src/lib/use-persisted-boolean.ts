"use client";

import { useEffect, useState } from "react";

/**
 * A boolean UI preference persisted in localStorage under an APP-WIDE key (not per-route), so it's shared
 * across pages and survives reloads — e.g. "metrics section collapsed" applies to every monitor page.
 *
 * SSR-safe (this is Next.js): renders `defaultValue` on the server AND the first client render so the
 * hydrated markup matches, then applies the stored value in a post-mount effect. A one-frame settle
 * (default → stored) is acceptable; a hydration mismatch is not. Storage failures (private mode / blocked)
 * fall back to the default silently.
 */
export function usePersistedBoolean(
  key: string,
  defaultValue: boolean,
): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(defaultValue);

  // Apply the stored preference after mount (browser-only) — never read localStorage during render.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === "true" || raw === "false") setValue(raw === "true");
    } catch {
      /* storage unavailable — keep the default */
    }
  }, [key]);

  const set = (next: boolean) => {
    setValue(next);
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(key, String(next));
    } catch {
      /* storage unavailable — preference won't persist this session, but the UI still toggles */
    }
  };

  return [value, set];
}
