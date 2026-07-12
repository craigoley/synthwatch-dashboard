"use client";

import { useState } from "react";
import { setEnvironmentOverride } from "@/lib/client";
import { useAuth } from "@/components/auth-provider";
import { envOf } from "@/lib/env";
import type { Check } from "@/lib/types";
import type { EnvValue } from "@/lib/api-client";

const ENVS: EnvValue[] = ["prod", "staging", "dev"];

/**
 * The per-check environment control (env PR-3), demoted from a standalone card to a CONFIG CHIP in the
 * detail page's config row — environment is configuration, not a KPI (derived correctly and never touched
 * on almost every monitor), so it lives in the config layer with the override ONE tap away.
 *
 * ★ The exception stays loud: when a manual override is set, the chip itself renders warn-toned with an
 * explicit OVERRIDDEN marker — visible on load, without opening anything. An override is a deliberate
 * deviation that survives reconcile; it must never be invisible. The derived (normal) case is neutral.
 *
 * Tap the chip → an inline disclosure (same conditional-render mechanism as the Metrics section) with
 * EVERYTHING the old card had: the derivation explainer, the set/clear override controls, and the
 * precedence + Settings→Environments guardrail copy. Deferred, not removed. Tap-driven (mobile-first) —
 * the title tooltip only supplements on desktop. Renders as a fragment inside the config row's flex-wrap:
 * the chip sits inline with its peers; the open panel is `order-last w-full`, a full-width row BELOW them.
 */
export function EnvironmentControl({ check }: { check: Check }) {
  const { canWrite, promptLogin } = useAuth();
  const [open, setOpen] = useState(false);
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
    <>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="env-disclosure"
        data-testid="env-chip"
        className="inline-flex cursor-pointer items-baseline gap-1.5 whitespace-nowrap"
        title={
          override != null
            ? `Manually overridden to ${override} — tap for the override controls`
            : `Derived as ${derived} — tap to see why, or to set a manual override`
        }
      >
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">Environment</span>
        <span
          className="sw-mono text-[12px]"
          style={{ color: override != null ? "var(--color-warn)" : "var(--color-ink)" }}
        >
          {effective}
        </span>
        {override != null && (
          <span
            className="text-[10px] font-medium uppercase tracking-wider"
            style={{ color: "var(--color-warn)" }}
            data-testid="env-chip-overridden"
          >
            · overridden
          </span>
        )}
        <span aria-hidden className="text-[10px] text-[var(--color-ink-faint)]">ⓘ</span>
      </button>

      {open && (
        <div
          id="env-disclosure"
          data-testid="env-disclosure"
          className="order-last mt-1 w-full border-t border-[var(--color-border)] pt-2.5"
        >
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
      )}
    </>
  );
}
