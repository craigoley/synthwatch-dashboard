"use client";

/**
 * B10 redaction-health surface (synthwatch-api #121) — the DETECTION surface for a sensitive monitor running
 * UNREDACTED (the leak class that hid for months, found only by a manual DB query). Read-only display of the
 * API's redaction_health field. null → no badge (legacy responses / non-sensitive).
 */

import type { CheckWithStatus, RedactionHealth } from "@/lib/types";

/** Per-check badge. misconfigured = LOUD (the leak state); ok = subtle "Redacted"; n/a or null = nothing. */
export function RedactionBadge({ health }: { health: RedactionHealth | null }) {
  if (health === "misconfigured") {
    return (
      <span
        data-testid="redaction-badge"
        data-health="misconfigured"
        title="Marked sensitive but NO redaction patterns — runs persist UNREDACTED; secrets may leak into traces/screenshots."
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold"
        style={{
          color: "var(--color-fail)",
          background: "color-mix(in srgb, var(--color-fail) 14%, transparent)",
          border: "1px solid color-mix(in srgb, var(--color-fail) 40%, transparent)",
        }}
      >
        ⚠ Redaction misconfigured — secrets may persist
      </span>
    );
  }
  if (health === "ok") {
    return (
      <span
        data-testid="redaction-badge"
        data-health="ok"
        title="Sensitive monitor with redaction patterns wired."
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--color-ink-faint)]"
      >
        🔒 Redacted
      </span>
    );
  }
  return null; // n/a or null → no badge
}

/**
 * Fleet-level B10 indicator: "N sensitive / M actually redacted" so a GAP (sensitive but unredacted) is
 * visible at a glance. LOUD when any monitor is misconfigured; subtle otherwise (incl. the all-clear and the
 * "no sensitive monitors" states, so the fleet-wide redaction posture is always explicit).
 */
export function RedactionFleetSummary({ checks }: { checks: CheckWithStatus[] }) {
  // Only count checks whose API actually reported redaction health (null = legacy → not counted).
  const known = checks.filter((c) => c.redaction_health !== null);
  if (known.length === 0) return null; // pre-#121 API → nothing to show

  const sensitive = known.filter((c) => c.sensitive).length;
  const redacted = known.filter((c) => c.redaction_health === "ok").length;
  const misconfigured = known.filter((c) => c.redaction_health === "misconfigured").length;

  if (misconfigured > 0) {
    return (
      <div
        data-testid="redaction-fleet"
        data-state="gap"
        className="flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-[13px]"
        style={{
          color: "var(--color-fail)",
          background: "color-mix(in srgb, var(--color-fail) 10%, transparent)",
          border: "1px solid color-mix(in srgb, var(--color-fail) 34%, transparent)",
        }}
      >
        <span className="font-semibold">
          ⚠ {misconfigured} of {sensitive} sensitive monitor{sensitive === 1 ? "" : "s"} run UNREDACTED
        </span>
        <span className="text-[var(--color-ink-dim)]">— secrets may persist in traces/screenshots</span>
      </div>
    );
  }

  return (
    <div
      data-testid="redaction-fleet"
      data-state={sensitive > 0 ? "all-redacted" : "none-sensitive"}
      className="sw-mono text-[11px] text-[var(--color-ink-faint)]"
    >
      {sensitive > 0
        ? `🔒 ${sensitive} sensitive monitor${sensitive === 1 ? "" : "s"}, all redacted (${redacted}/${sensitive})`
        : "No monitors marked sensitive"}
    </div>
  );
}
