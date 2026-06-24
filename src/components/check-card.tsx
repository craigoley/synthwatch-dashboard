import Link from "next/link";

import type { CheckWithStatus } from "@/lib/types";
import { StatusBadge, TONE_VAR } from "@/components/status-badge";
import { Sparkline } from "@/components/sparkline";
import { TagChips } from "@/components/tag-chips";
import { AvailabilityValue } from "@/components/sla";
import { runStatusMeta } from "@/lib/status";
import { formatCertExpiry, formatDuration, formatRelative } from "@/lib/format";

const RAIL: Record<string, string> = TONE_VAR;

/** Compact target label for network checks (dns: "A host"; tcp/ping: "host:port"). */
function netLabel(check: CheckWithStatus): string {
  const host = check.target_url;
  if (check.kind === "dns") return `${check.net_config?.recordType ?? "A"} ${host}`;
  if (host.includes(":")) return host; // already host:port
  const port = check.net_config?.port ?? (check.kind === "ping" ? 443 : null);
  return port != null ? `${host}:${port}` : host;
}

export function CheckCard({
  check,
  availability = null,
  availabilityInsufficient = false,
}: {
  check: CheckWithStatus;
  availability?: number | null;
  availabilityInsufficient?: boolean;
}) {
  const meta = runStatusMeta(check.current_status);
  // ★ Regional = some-but-not-all locations failing — a partial blip, visually
  // distinct (amber) from a full outage (red) or healthy (token color).
  const locs = check.locations ?? [];
  const locDown = locs.filter((l) => l.status === "fail" || l.status === "error").length;
  // warn = up-but-degraded; surfaced only when nothing is hard-down (failures win).
  const locDegraded = locs.filter((l) => l.status === "warn").length;
  const regional = locs.length > 1 && locDown > 0 && locDown < locs.length;
  const degraded = locs.length > 1 && locDown === 0 && locDegraded > 0;
  const rail =
    check.open_incident_count > 0
      ? TONE_VAR.fail
      : regional || degraded
        ? TONE_VAR.warn
        : RAIL[meta.token];

  return (
    <Link
      href={`/checks/${check.id}`}
      className="sw-card sw-rail block p-4"
      style={{ ["--rail" as string]: rail, opacity: check.enabled ? 1 : 0.62 }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[15px] font-semibold text-[var(--color-ink)]">{check.name}</h3>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
              {check.kind}
            </span>
            {check.kind === "browser" && check.flow_name && (
              <span className="sw-mono truncate text-[10px] text-[var(--color-ink-dim)]">· {check.flow_name}</span>
            )}
            {(check.kind === "dns" || check.kind === "tcp" || check.kind === "ping") && (
              <span className="sw-mono truncate text-[10px] text-[var(--color-ink-dim)]">· {netLabel(check)}</span>
            )}
            {check.kind === "multistep" && (
              <span className="sw-mono truncate text-[10px] text-[var(--color-ink-dim)]">
                · {check.steps?.length ?? 0} {(check.steps?.length ?? 0) === 1 ? "step" : "steps"}
              </span>
            )}
            {regional && (
              <span
                className="sw-mono text-[10px] uppercase tracking-wider"
                style={{ color: TONE_VAR.warn }}
              >
                · regional {locDown}/{locs.length}
              </span>
            )}
            {degraded && (
              <span
                className="sw-mono text-[10px] uppercase tracking-wider"
                style={{ color: TONE_VAR.warn }}
              >
                · degraded {locDegraded}/{locs.length}
              </span>
            )}
            {!check.enabled && (
              <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
                · paused
              </span>
            )}
          </div>
          {check.kind === "ssl" && (
            <div className="mt-1.5 sw-mono text-[12px]" style={{ color: TONE_VAR[meta.token] }}>
              {formatCertExpiry(check.last_cert_days_remaining) ?? "no cert reading"}
            </div>
          )}
          <TagChips tags={check.tags} className="mt-2" />
        </div>
        {/* Two distinct facts, labeled so they don't read as contradictory:
            the badge is the LATEST run's state; the % is 24h historical uptime. */}
        <div className="flex flex-col items-end gap-1.5">
          <span className="flex items-center gap-1.5">
            <span className="text-[9px] uppercase tracking-wider text-[var(--color-ink-faint)]">latest</span>
            <StatusBadge status={check.current_status} />
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-[9px] uppercase tracking-wider text-[var(--color-ink-faint)]">24h avail</span>
            <AvailabilityValue
              pct={availability}
              insufficient={availabilityInsufficient}
              compact
              className="text-[11px]"
            />
          </span>
        </div>
      </div>

      {check.open_incident_count > 0 && (
        <div
          className="mt-3 flex items-center gap-1.5 rounded px-2 py-1 text-[11px]"
          style={{
            color: TONE_VAR[check.max_open_severity === "critical" ? "fail" : "warn"],
            background: `color-mix(in srgb, ${TONE_VAR[check.max_open_severity === "critical" ? "fail" : "warn"]} 10%, transparent)`,
          }}
        >
          <span className="sw-dot" style={{ background: "currentColor" }} />
          {check.open_incident_count} open incident{check.open_incident_count > 1 ? "s" : ""}
        </div>
      )}

      <div className="mt-4 flex items-end justify-between gap-3">
        <div className="grid grid-cols-2 gap-x-5 gap-y-1">
          <Metric label="p50 24h" value={formatDuration(check.p50_ms)} />
          <Metric label="p95 24h" value={formatDuration(check.p95_ms)} />
        </div>
        <Sparkline points={check.spark} />
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-[var(--color-border)] pt-2.5">
        <span className="sw-mono text-[11px] text-[var(--color-ink-faint)]">
          last run {formatRelative(check.last_started_at)}
        </span>
        <span className="sw-mono text-[11px] text-[var(--color-ink-faint)]">
          {check.runs_24h} runs/24h
        </span>
      </div>
    </Link>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="sw-mono text-[15px] font-medium text-[var(--color-ink)]">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">{label}</div>
    </div>
  );
}
