"use client";

import { useEffect, useState } from "react";

/**
 * A TRI-STATE collapse preference, persisted per-browser in localStorage under an APP-WIDE key.
 *
 * The plain `usePersistedBoolean` can't express "follow a data-driven default until the user pins it" — a
 * stored `false` is indistinguishable from "never chose". This stores "auto" | "open" | "closed":
 *   - "auto"  (the un-set default): `open` follows `autoOpen`, the STATE-DEPENDENT default (drift>0 → open,
 *             count>0 → open). So the section auto-expands when it has something to show, until the user acts.
 *   - "open"/"closed": an explicit user PIN — wins over `autoOpen` and survives reloads.
 *
 * SSR-safe (mirrors usePersistedBoolean): renders "auto" on the server + first client render, applies the
 * stored pin in a post-mount effect. Storage failures fall back to "auto" silently.
 *
 * ★ The BODY collapses; the SIGNAL never does. This hook governs only the body — callers keep the section
 *   HEADER (the count / ⚠ warning) always visible, so a pinned-closed section still announces new drift.
 */
export function usePersistedCollapse(
  key: string,
  autoOpen: boolean,
): { open: boolean; toggle: () => void } {
  const [pref, setPref] = useState<"auto" | "open" | "closed">("auto");

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === "open" || raw === "closed") setPref(raw);
    } catch {
      /* storage unavailable — stay on the auto (state-dependent) default */
    }
  }, [key]);

  const open = pref === "auto" ? autoOpen : pref === "open";

  const toggle = () => {
    const next = open ? "closed" : "open";
    setPref(next);
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(key, next);
    } catch {
      /* storage unavailable — the toggle still works this session, just won't persist */
    }
  };

  return { open, toggle };
}
