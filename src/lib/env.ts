// The single source of truth for a check's DEPLOYMENT ENVIRONMENT (the authoritative `checks.environment`
// column — prod|staging|dev, NOT the `env:` tag). Every surface reads env through these two helpers + the
// shared <EnvBadge>, so the "is this non-prod?" test is defined ONCE (was copy-pasted 4× with drift, one
// null-unsafe). Null-safe by construction: a missing/undefined env is treated as "prod".

/** Anything carrying the authoritative environment column (Check, CheckWithStatus, ReportRow, …). */
export interface HasEnvironment {
  environment?: string | null;
}

/** The check's environment with a safe fallback — undefined/null → "prod". */
export function envOf(x: HasEnvironment): string {
  return x.environment ?? "prod";
}

/** True when the check is NOT in the prod fleet (staging/dev/…). The one definition of "non-prod". */
export function isNonProd(x: HasEnvironment): boolean {
  return envOf(x) !== "prod";
}
