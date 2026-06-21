"use client";

import { useRunSteps } from "@/lib/client";
import { TONE_VAR } from "@/components/status-badge";
import { stepStatusToken } from "@/lib/status";
import { formatDuration } from "@/lib/format";
import type { RunStep } from "@/lib/types";

/**
 * Horizontal funnel stage-bar for a run's steps. Each step is a segment colored
 * by outcome, so a failed run shows exactly which step it died at. Segment width
 * is proportional to step duration (with a floor so short steps stay visible).
 */
export function FunnelBar({ runId }: { runId: number }) {
  const { data: steps, isLoading, error } = useRunSteps(runId);

  if (isLoading) {
    return <div className="h-7 w-full animate-pulse rounded bg-[var(--color-panel-2)]" />;
  }
  if (error) {
    return <div className="text-xs text-[var(--color-fail)]">failed to load steps</div>;
  }
  if (!steps || steps.length === 0) {
    return <div className="sw-mono text-xs text-[var(--color-ink-faint)]">no recorded steps</div>;
  }

  return <FunnelBarStatic steps={steps} />;
}

export function FunnelBarStatic({ steps }: { steps: RunStep[] }) {
  const durations = steps.map((s) => s.duration_ms ?? 0);
  const total = durations.reduce((a, b) => a + b, 0) || steps.length;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-7 w-full gap-[2px] overflow-hidden rounded-md">
        {steps.map((s) => {
          const tone = TONE_VAR[stepStatusToken(s.status)];
          const pct = ((s.duration_ms ?? 0) / total) * 100;
          const basis = Math.max(pct, 100 / steps.length / 2);
          return (
            <div
              key={s.id}
              className="group relative flex min-w-[10px] items-center justify-center"
              style={{
                flex: `${basis} 1 0`,
                background: `color-mix(in srgb, ${tone} ${s.status === "skip" ? 14 : 26}%, transparent)`,
                borderTop: `2px solid ${tone}`,
              }}
              title={`${s.name} · ${s.status} · ${formatDuration(s.duration_ms)}`}
            >
              <span className="sw-mono truncate px-1 text-[10px]" style={{ color: tone }}>
                {s.step_index + 1}
              </span>
            </div>
          );
        })}
      </div>
      <ol className="flex flex-wrap gap-x-4 gap-y-1">
        {steps.map((s) => {
          const tone = TONE_VAR[stepStatusToken(s.status)];
          return (
            <li key={s.id} className="flex items-center gap-1.5 text-xs">
              <span className="sw-dot" style={{ background: tone, boxShadow: `0 0 8px -2px ${tone}` }} />
              <span className="text-[var(--color-ink-dim)]">{s.name}</span>
              <span className="sw-mono text-[10px] text-[var(--color-ink-faint)]">
                {formatDuration(s.duration_ms)}
              </span>
            </li>
          );
        })}
      </ol>
      {steps.some((s) => s.status === "fail" && s.error_message) && (
        <div className="mt-1 space-y-1">
          {steps
            .filter((s) => s.status === "fail" && s.error_message)
            .map((s) => (
              <p
                key={s.id}
                className="sw-mono rounded border-l-2 px-2 py-1 text-[11px]"
                style={{
                  borderColor: TONE_VAR.fail,
                  background: "color-mix(in srgb, var(--color-fail) 8%, transparent)",
                  color: "var(--color-fail)",
                }}
              >
                {s.name}: {s.error_message}
              </p>
            ))}
        </div>
      )}
    </div>
  );
}
