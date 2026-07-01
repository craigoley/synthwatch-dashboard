/**
 * Gated debug logging — diagnose live-update funnels in PRODUCTION without any behavior change for normal
 * users. OFF by default; emits structured console lines only when explicitly enabled per-browser.
 *
 * Turn ON (either):
 *   localStorage.setItem("SYNTHWATCH_DEBUG", "1")   // sticky across reloads + navigations
 *   …or append ?debug=runs  (or ?debug=all)         // just this tab/URL
 * Then open DevTools → Console and watch the [runs-debug] funnel during the flow (e.g. a "Run now").
 * Turn OFF: localStorage.removeItem("SYNTHWATCH_DEBUG") (or drop the query param).
 */
export function isDebugOn(channel: string): boolean {
  if (typeof window === "undefined") return false; // SSR — never log on the server
  try {
    if (window.localStorage?.getItem("SYNTHWATCH_DEBUG") === "1") return true;
    const d = new URLSearchParams(window.location.search).get("debug");
    return d === "all" || d === "1" || d === channel;
  } catch {
    return false;
  }
}

/**
 * Gate for VISIBLE debug UI (e.g. the breadcrumb overlay panel) — deliberately STRICTER than isDebugOn.
 *
 * isDebugOn honours the blanket, sticky `SYNTHWATCH_DEBUG=1` flag, which is the general switch for the
 * INVISIBLE console channels (runsDebug etc.). A persistent on-screen panel must NOT ride that flag: a user
 * who set it once to debug the runs funnel would then get the panel forced on for every page, forever (the
 * #159 leak). So a panel opts in only via an EXPLICIT signal for its own channel:
 *   • the URL param  ?debug=<channel>  or  ?debug=all   (per-tab), or
 *   • a channel-specific sticky key    SYNTHWATCH_DEBUG_<CHANNEL>=1  (e.g. SYNTHWATCH_DEBUG_ERRORS).
 * OFF by default, and — critically — OFF even when the blanket SYNTHWATCH_DEBUG=1 is set.
 */
export function isDebugPanelOn(channel: string): boolean {
  if (typeof window === "undefined") return false; // SSR / first paint — never render the panel on the server
  try {
    if (window.localStorage?.getItem(`SYNTHWATCH_DEBUG_${channel.toUpperCase()}`) === "1") return true;
    const d = new URLSearchParams(window.location.search).get("debug");
    return d === "all" || d === channel;
  } catch {
    return false;
  }
}

/** Emit one [runs-debug] funnel line (no-op unless the "runs" debug channel is enabled). */
export function runsDebug(stage: string, data?: Record<string, unknown>): void {
  if (!isDebugOn("runs")) return;
  // intentional, gated diagnostic output
  console.log(`[runs-debug] ${stage}`, data ?? {});
}
