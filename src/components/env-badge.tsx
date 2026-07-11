import { TONE_VAR } from "@/components/status-badge";
import { envOf, isNonProd, type HasEnvironment } from "@/lib/env";

/**
 * The single env-rendering path. An amber pill showing the check's deployment environment (from the
 * authoritative `checks.environment` column), rendered ONLY for non-prod checks — prod shows nothing so the
 * 99% case is visually unchanged. Used everywhere env should be as visible as tags (grid card, monitor detail,
 * report card). Env is never a tag; this is the only place it renders.
 */
export function EnvBadge({ check, className = "" }: { check: HasEnvironment & { id?: number }; className?: string }) {
  if (!isNonProd(check)) return null;
  return (
    <span
      className={`sw-mono rounded px-1 text-[10px] font-semibold uppercase tracking-wider ${className}`}
      style={{ color: TONE_VAR.warn, background: `color-mix(in srgb, ${TONE_VAR.warn} 15%, transparent)` }}
      data-testid={check.id != null ? `env-badge-${check.id}` : "env-badge"}
    >
      {envOf(check)}
    </span>
  );
}
