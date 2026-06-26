/**
 * Pure formatting helpers — safe to import from server or client components.
 * All timestamps from the API are UTC ISO strings; these render them in the
 * viewer's local timezone (no stored preference, no browser storage).
 */

export function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * ISO from/to for a relative look-back of `days` — the date-range a cursor list sends
 * (runs now, incidents next). Shared so every cursor+date-range surface bounds its
 * query the same way.
 */
export function lookbackRange(days: number, now = Date.now()): { from: string; to: string } {
  return {
    from: new Date(now - days * 86_400_000).toISOString(),
    to: new Date(now).toISOString(),
  };
}

/** Local date + time, e.g. "Jun 20, 14:32:05". */
export function formatLocalDateTime(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** Compact relative time, e.g. "12s ago", "4m ago", "3h ago", "2d ago". */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  const d = parseDate(iso);
  if (!d) return "never";
  const diff = Math.round((now - d.getTime()) / 1000);
  if (diff < 0) return "just now";
  if (diff < 60) return `${diff}s ago`;
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** Milliseconds → human latency, e.g. "842ms", "1.42s", "1m 03s". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${String(sec).padStart(2, "0")}s`;
}

/** Bytes → human size, e.g. "934 B", "1.4 MB". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

/**
 * Human cert-expiry string from the structured days-remaining the API now
 * exposes (run.cert_days_remaining / check.last_cert_days_remaining). Negative =
 * expired. Returns null when there is no cert reading.
 */
export function formatCertExpiry(days: number | null | undefined): string | null {
  if (days === null || days === undefined) return null;
  if (days < 0) return `cert expired ${Math.abs(days)}d ago`;
  if (days === 0) return "cert expires today";
  return `cert expires in ${days}d`;
}

/** Availability/percentage, e.g. "99.95%". Dash when unknown. */
export function formatPct(pct: number | null | undefined, digits = 2): string {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return "—";
  return `${pct.toFixed(digits)}%`;
}

/**
 * Check interval is STORED + TRANSPORTED in SECONDS (DB `interval_seconds`, API `intervalSeconds`),
 * but the UI speaks MINUTES (users think in minutes, not "300 seconds"). These convert at that boundary.
 */
/** Minutes → whole seconds for the API payload (5 → 300). Rounds so fractional minutes stay exact-ish. */
export function minutesToSeconds(minutes: number): number {
  return Math.round(minutes * 60);
}
/**
 * Seconds → a tidy minutes string for inputs/display: 300 → "5", 90 → "1.5". Never lies about a legacy
 * non-whole-minute value (shows the true fraction) while keeping whole minutes clean.
 */
export function secondsToMinutesLabel(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return "";
  const m = seconds / 60;
  return Number.isInteger(m) ? String(m) : String(Number(m.toFixed(2)));
}

/** Compact integer with thousands separators. */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString();
}

/** Duration between two instants in human terms (for incidents). */
export function formatSpan(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
  now = Date.now(),
): string {
  const start = parseDate(startIso);
  if (!start) return "—";
  const end = parseDate(endIso)?.getTime() ?? now;
  const sec = Math.max(0, Math.round((end - start.getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const remMin = min % 60;
  if (h < 24) return `${h}h ${remMin}m`;
  const days = Math.floor(h / 24);
  return `${days}d ${h % 24}h`;
}
