/**
 * ONE staleness helper, shared by every "as of <age> (+ ⚠ stale)" stamp — the threshold is a PARAMETER, not
 * a hard-coded copy (two helpers computing staleness in two places is the drift shape we keep fixing). Used
 * by the cost panel (Azure daily pull, 48h) and the spec-catalog freshness stamp (~24h reconcile cron, 26h).
 */

/** Azure Cost Management pulls once a day; flag "may be stale" past ~2× that cadence. */
export const AZURE_STALE_AFTER_MS = 48 * 60 * 60 * 1000;

/** The spec catalog is a ~24h reconcile-cron snapshot. Flag past 26h — one interval + a 2h grace, so a
 *  genuinely-missed cron cycle is loud, but a snapshot taken just before a refresh isn't a false ⚠. */
export const SPEC_CATALOG_STALE_AFTER_MS = 26 * 60 * 60 * 1000;

/**
 * "as of <age>" + a staleness flag, from an ISO timestamp and a staleness threshold (ms). Absent/unparseable
 * ⇒ treated as stale (an unknown age is not a fresh age). Age label: "just now" < 1h, "Nh ago" < 48h, else "Nd ago".
 */
export function asOf(
  iso: string,
  staleAfterMs: number,
  now: number = Date.now(),
): { label: string; stale: boolean } {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return { label: "unknown", stale: true };
  const ageMs = now - t;
  const h = Math.floor(ageMs / 3.6e6);
  const label = ageMs < 3.6e6 ? "just now" : h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
  return { label, stale: ageMs > staleAfterMs };
}
