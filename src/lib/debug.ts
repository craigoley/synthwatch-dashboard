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

/** Emit one [runs-debug] funnel line (no-op unless the "runs" debug channel is enabled). */
export function runsDebug(stage: string, data?: Record<string, unknown>): void {
  if (!isDebugOn("runs")) return;
  // eslint-disable-next-line no-console -- intentional, gated diagnostic output
  console.log(`[runs-debug] ${stage}`, data ?? {});
}
