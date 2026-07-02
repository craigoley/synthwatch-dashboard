"use client";

import { useState } from "react";

import { useEgress } from "@/lib/client";
import { TONE_VAR } from "@/components/status-badge";
import { ErrorState } from "@/components/states";
import { formatLocalDateTime, formatRelative } from "@/lib/format";
import type { EgressRegion } from "@/lib/types";

/**
 * Egress stability (§ static-egress-IP arc) for the /status page. Two jobs from GET /reports/egress:
 *   1. the ALLOWLIST ARTIFACT — the current public egress IP per region, prominent + copy-friendly (this is
 *      what's handed to Wegmans for the login-monitor allowlist);
 *   2. a live SNAT-ROTATION early-warning — distinct_count == 1 is calm/green; ≥ 2 is LOUD (a rotation would
 *      silently break a future allowlisted login monitor, so it must never render as calmly as stability).
 *
 * ★ Null-safe (mirrors PropertyStatusSection / the SLO+deploys self-hide): endpoint absent (404 → null) or
 * zero regions → the section renders NOTHING, so the status page is unaffected until the endpoint deploys.
 */

function CopyButton({ text, testId, label = "Copy" }: { text: string; testId: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      data-testid={testId}
      className="sw-btn sw-btn-ghost shrink-0 text-[11px]"
      aria-label={`Copy ${text}`}
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

function RegionCard({ r }: { r: EgressRegion }) {
  const rotating = r.distinct_count >= 2;
  const tone: "pass" | "fail" = rotating ? "fail" : "pass";
  const current = r.current_ips.length > 0 ? r.current_ips.join(", ") : "—";

  return (
    <div
      className="sw-panel p-4"
      data-testid={`egress-region-${r.location}`}
      style={{ borderColor: `color-mix(in srgb, ${TONE_VAR[tone]} ${rotating ? 55 : 30}%, var(--color-border))` }}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="truncate text-sm font-semibold text-[var(--color-ink)]" title={r.location}>{r.location}</h3>
        {rotating ? (
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-semibold"
            style={{ color: TONE_VAR.fail, background: `color-mix(in srgb, ${TONE_VAR.fail} 16%, transparent)` }}
            data-testid={`egress-rotation-${r.location}`}
          >
            <span aria-hidden>⚠</span> Rotation detected · {r.distinct_count} IPs
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-medium"
            style={{ color: TONE_VAR.pass, background: `color-mix(in srgb, ${TONE_VAR.pass} 12%, transparent)` }}
            data-testid={`egress-stable-${r.location}`}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: TONE_VAR.pass }} /> Stable · 1 IP
          </span>
        )}
      </div>

      {/* The current IP(s) — prominent + copy-friendly (the allowlist artifact). Selectable mono + a Copy button. */}
      <div className="mt-3 flex items-center gap-2">
        <code
          className="sw-mono select-all text-base font-medium text-[var(--color-ink)]"
          data-testid={`egress-ip-${r.location}`}
        >
          {current}
        </code>
        {r.current_ips.length > 0 && <CopyButton text={r.current_ips.join("\n")} testId={`egress-copy-${r.location}`} />}
      </div>

      {rotating ? (
        // ★ LOUD + auto-expanded: every distinct IP with its first-seen (a 2nd IP's first-seen IS the rotation
        // moment). No toggle — a rotation is surfaced immediately, never a click away.
        <div className="mt-3 space-y-1.5" data-testid={`egress-ips-${r.location}`}>
          <p className="text-[11px] font-medium" style={{ color: TONE_VAR.fail }}>
            SNAT pool rotated — allowlist likely stale. IPs seen:
          </p>
          {r.ips.map((ip) => (
            <div key={ip.ip} className="flex flex-wrap items-baseline justify-between gap-x-2 text-[11px]">
              <code className="sw-mono select-all text-[var(--color-ink)]">{ip.ip}</code>
              <span className="text-[var(--color-ink-dim)]">
                first seen{" "}
                <span className="font-medium" style={{ color: TONE_VAR.fail }} data-testid={`egress-firstseen-${ip.ip}`}>
                  {formatLocalDateTime(ip.first_seen)}
                </span>{" "}
                · {ip.run_count} runs
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-[var(--color-ink-dim)]">
          {r.run_count} runs · stable since {formatRelative(r.first_seen)}
        </p>
      )}
    </div>
  );
}

export function EgressStabilitySection() {
  const { data, error } = useEgress("all");
  // ★ Loud-not-silent: a 500/network error shows a visible state (the egress rotation monitor going blank on
  // an incident is the exact silent failure we're killing). A 404 → data null → hide (feature absent, correct).
  if (error) {
    return (
      <section data-testid="egress-section">
        <h2 className="mb-2 text-sm font-semibold tracking-tight text-[var(--color-ink)]">Egress stability</h2>
        <ErrorState testId="egress-error" message="Egress stability failed to load — retry." />
      </section>
    );
  }
  if (!data || data.regions.length === 0) return null;

  const allCurrent = data.regions.flatMap((r) => r.current_ips);

  return (
    <section className="space-y-3" data-testid="egress-section">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-tight text-[var(--color-ink)]">Egress stability</h2>
        {allCurrent.length > 0 && <CopyButton text={allCurrent.join("\n")} testId="egress-copy-all" label="Copy all IPs" />}
      </div>
      <p className="text-[11px] text-[var(--color-ink-faint)]">
        The public egress IP per region — allowlist these. A 2nd IP means the SNAT pool rotated (a rotation would
        silently break an allowlisted login monitor).
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        {data.regions.map((r) => (
          <RegionCard key={r.location} r={r} />
        ))}
      </div>
    </section>
  );
}
