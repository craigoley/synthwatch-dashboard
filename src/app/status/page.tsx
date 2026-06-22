"use client";

import { useMemo, useState } from "react";

import { useChecks, useIncidents, useSla } from "@/lib/client";
import { AvailabilityValue } from "@/components/sla";
import { TONE_VAR } from "@/components/status-badge";
import { Spinner } from "@/components/states";
import { componentStatus, deriveSystemStatus } from "@/lib/status";
import { formatLocalDateTime, formatRelative, formatSpan } from "@/lib/format";
import type { CheckWithStatus, IncidentWithCheck, SlaWindow } from "@/lib/types";

const WINDOWS: SlaWindow[] = ["24h", "7d", "30d"];
const WINDOW_LABEL: Record<SlaWindow, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };

// Worst-first so any problem components surface at the top.
const RANK: Record<string, number> = { fail: 0, warn: 1, pass: 2, running: 2, idle: 3 };

function Logo() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9.5" stroke="var(--color-brand)" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="2.4" fill="var(--color-brand)" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" stroke="var(--color-brand)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function StatusGlyph({ token }: { token: "pass" | "warn" | "fail" }) {
  const c = TONE_VAR[token];
  return (
    <span
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
      style={{ background: `color-mix(in srgb, ${c} 16%, transparent)`, color: c }}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        {token === "pass" && <path d="M20 6 9 17l-5-5" />}
        {token === "warn" && <><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></>}
        {token === "fail" && <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>}
      </svg>
    </span>
  );
}

export default function StatusPage() {
  const [window, setWindow] = useState<SlaWindow>("24h");
  const { data: checks, isLoading } = useChecks();
  const { data: incidents } = useIncidents();
  const w24 = useSla("24h");
  const w7 = useSla("7d");
  const w30 = useSla("30d");
  const slaByWindow = { "24h": w24.data, "7d": w7.data, "30d": w30.data } as const;

  const enabled = useMemo(() => (checks ?? []).filter((c) => c.enabled), [checks]);
  const system = deriveSystemStatus(checks ?? []);
  const sla = slaByWindow[window];
  const uptimeByCheck = useMemo(() => {
    const m = new Map<number, { pct: number | null; insufficient: boolean }>();
    for (const row of sla?.items ?? []) m.set(row.check_id, { pct: row.availability_pct, insufficient: row.insufficient_data });
    return m;
  }, [sla]);

  const sortedComponents = useMemo(() => {
    const rank = (c: CheckWithStatus) => RANK[componentStatus(c).token] ?? 3;
    return [...enabled].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  },
    [enabled],
  );

  const updatedAt = useMemo(() => {
    const times = (checks ?? []).map((c) => c.last_started_at).filter(Boolean) as string[];
    return times.sort().at(-1) ?? null;
  }, [checks]);

  return (
    <div className="min-h-dvh">
      <div className="mx-auto max-w-3xl space-y-10 px-4 py-12 sm:py-16">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Logo />
            <span className="text-[15px] font-semibold tracking-tight">
              Synth<span className="text-[var(--color-brand)]">Watch</span>{" "}
              <span className="text-[var(--color-ink-dim)]">Status</span>
            </span>
          </div>
          <span className="flex items-center gap-1.5">
            <span className="sw-dot sw-dot-running" />
            <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">Live</span>
          </span>
        </header>

        {isLoading && !checks ? (
          <div className="py-20"><Spinner label="Loading status…" /></div>
        ) : (
          <>
            {/* Overall status banner */}
            <section
              className="sw-panel flex items-center gap-4 p-5"
              style={{ borderColor: `color-mix(in srgb, ${TONE_VAR[system.token]} 45%, var(--color-border))` }}
            >
              <StatusGlyph token={system.token} />
              <div>
                <h1 className="text-xl font-semibold tracking-tight" style={{ color: TONE_VAR[system.token] }}>
                  {system.label}
                </h1>
                <p className="mt-0.5 text-sm text-[var(--color-ink-dim)]">
                  {updatedAt ? `Updated ${formatRelative(updatedAt)}` : "Awaiting first checks"}
                </p>
              </div>
            </section>

            {/* Active incidents (prominent) */}
            {incidents && incidents.open.length > 0 && (
              <section className="space-y-3">
                <SectionTitle>Active incidents</SectionTitle>
                {incidents.open.map((i) => (
                  <IncidentCard key={i.id} incident={i} active />
                ))}
              </section>
            )}

            {/* Components / per-service status */}
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <SectionTitle>Components</SectionTitle>
                <div className="inline-flex rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] p-0.5">
                  {WINDOWS.map((win) => (
                    <button
                      key={win}
                      type="button"
                      onClick={() => setWindow(win)}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                        window === win
                          ? "bg-[var(--color-panel-2)] text-[var(--color-ink)]"
                          : "text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
                      }`}
                    >
                      {win}
                    </button>
                  ))}
                </div>
              </div>

              <div className="sw-panel divide-y divide-[var(--color-border)] overflow-hidden">
                {sortedComponents.length === 0 ? (
                  <div className="px-4 py-6 text-sm text-[var(--color-ink-dim)]">No components are being monitored yet.</div>
                ) : (
                  sortedComponents.map((c) => (
                    <ComponentRow key={c.id} check={c} uptime={uptimeByCheck.get(c.id)} window={window} />
                  ))
                )}
              </div>
              <p className="px-1 text-[11px] text-[var(--color-ink-faint)]">
                Uptime shown over the last {WINDOW_LABEL[window]}. &quot;Building baseline&quot; means not enough history yet.
              </p>
            </section>

            {/* Incident history (resolved) */}
            <section className="space-y-3">
              <SectionTitle>Incident history</SectionTitle>
              {incidents && incidents.resolved.length > 0 ? (
                <div className="space-y-2">
                  {incidents.resolved.slice(0, 10).map((i) => (
                    <IncidentCard key={i.id} incident={i} />
                  ))}
                </div>
              ) : (
                <div className="sw-panel px-4 py-5 text-sm text-[var(--color-ink-dim)]">
                  No incidents in recent history.
                </div>
              )}
            </section>

            <footer className="pt-4 text-center text-[11px] text-[var(--color-ink-faint)]">
              Powered by SynthWatch · synthetic monitoring
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-semibold tracking-tight text-[var(--color-ink)]">{children}</h2>;
}

function ComponentRow({
  check,
  uptime,
  window,
}: {
  check: CheckWithStatus;
  uptime: { pct: number | null; insufficient: boolean } | undefined;
  window: SlaWindow;
}) {
  const cs = componentStatus(check);
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="sw-dot" style={{ background: TONE_VAR[cs.token], boxShadow: `0 0 8px -2px ${TONE_VAR[cs.token]}` }} />
        <span className="truncate text-sm font-medium text-[var(--color-ink)]">{check.name}</span>
      </div>
      <div className="flex shrink-0 items-center gap-5">
        <span className="hidden items-center gap-1.5 sm:flex" title={`Uptime over ${WINDOW_LABEL[window]}`}>
          <AvailabilityValue
            pct={uptime?.pct ?? null}
            insufficient={uptime?.insufficient ?? false}
            className="text-[13px]"
          />
        </span>
        <span className="text-[13px] font-medium" style={{ color: TONE_VAR[cs.token] }}>
          {cs.label}
        </span>
      </div>
    </div>
  );
}

function IncidentCard({ incident, active = false }: { incident: IncidentWithCheck; active?: boolean }) {
  const tone = incident.severity === "critical" ? TONE_VAR.fail : TONE_VAR.warn;
  return (
    <div
      className="sw-panel sw-rail p-4"
      style={{ ["--rail" as string]: active ? tone : "var(--color-idle)" }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--color-ink)]">{incident.check_name}</span>
          <span
            className="sw-mono rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider"
            style={{ color: tone, background: `color-mix(in srgb, ${tone} 12%, transparent)` }}
          >
            {active ? incident.severity : "resolved"}
          </span>
        </div>
        <span className="sw-mono text-[11px] text-[var(--color-ink-faint)]">
          {active
            ? `started ${formatRelative(incident.opened_at)}`
            : `${formatLocalDateTime(incident.resolved_at)} · ${formatSpan(incident.opened_at, incident.resolved_at)}`}
        </span>
      </div>
      {incident.summary && (
        <p className="mt-1.5 text-sm text-[var(--color-ink-dim)]">{incident.summary}</p>
      )}
    </div>
  );
}
