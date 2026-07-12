"use client";

import { useState } from "react";
import { setEnvironmentOverride } from "@/lib/client";
import { useAuth } from "@/components/auth-provider";
import { envOf } from "@/lib/env";
import type { Check } from "@/lib/types";
import type { EnvValue } from "@/lib/api-client";

const ENVS: EnvValue[] = ["prod", "staging", "dev"];

/**
 * The per-check environment control (env PR-3) on the monitor detail page. Shows the EFFECTIVE env + WHY it's
 * that (a manual override, or derived from the git manifest / domain-map), and lets an editor set or CLEAR the
 * override. The override is dashboard-owned and SURVIVES reconcile (in neither reconcile write allow-list);
 * clearing it reverts to the derived env.
 */
export function EnvironmentControl({ check }: { check: Check }) {
  const { canWrite, promptLogin } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const effective = envOf(check);
  const override = check.environment_override ?? null;
  const derived = check.environment; // the git-derived env (manifest ?? domain-map ?? prod)

  async function set(env: EnvValue | null) {
    if (!canWrite) return promptLogin();
    setBusy(true);
    setErr(null);
    try {
      await setEnvironmentOverride(check.id, env);
    } catch {
      setErr("Couldn’t update the environment — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="sw-eyebrow">Environment</span>
        <span className="sw-mono text-sm text-[var(--color-ink)]">{effective}</span>
      </div>

      <p className="text-[12px] text-[var(--color-ink-dim)]">
        {override != null ? (
          <>
            <span style={{ color: "var(--color-warn)" }}>Manually overridden</span> to <b>{override}</b>
            {derived !== override && <> — the derived env is <b>{derived}</b>.</>} This override survives reconcile.
          </>
        ) : (
          <>
            <b>Derived</b> as <b>{derived}</b> (from the monitor’s manifest env, else the domain→env map, else
            prod). No manual override set.
          </>
        )}
      </p>

      {canWrite && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {ENVS.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => set(e)}
              disabled={busy}
              data-testid={`env-set-${e}`}
              className="sw-btn sw-btn-sm"
              style={
                e === override
                  ? { color: "var(--color-brand)", borderColor: "color-mix(in srgb, var(--color-brand) 40%, transparent)" }
                  : undefined
              }
            >
              {e}
            </button>
          ))}
          <button
            type="button"
            onClick={() => set(null)}
            disabled={busy || override == null}
            data-testid="env-clear-override"
            className="sw-btn sw-btn-sm sw-btn-ghost"
          >
            Clear override
          </button>
        </div>
      )}

      {err && <p className="mt-1.5 text-[11px]" style={{ color: "var(--color-fail)" }}>{err}</p>}

      <p className="mt-2 text-[11px] text-[var(--color-ink-faint)]">
        An override wins over the manifest/domain-map env and never gets clobbered by a reconcile. Manage the
        domain→env rules in{" "}
        <a href="/settings/environments" className="underline hover:text-[var(--color-brand)]">Settings → Environments</a>.
      </p>
    </div>
  );
}
