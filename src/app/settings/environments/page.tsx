"use client";

/**
 * env PR-3 — the domain→environment MAP management page. Lists the ordered inference rules (priority asc)
 * with add/edit/remove, makes the precedence explicit (override > manifest > inferred > prod), and lists the
 * checks that currently carry a manual OVERRIDE (so a wrong override is discoverable + revertible on the
 * monitor's own page). ★ Read/write is editor-gated server-side; hiding controls for non-editors is UX only.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { useAuth } from "@/components/auth-provider";
import { useChecks } from "@/lib/client";
import {
  getEnvDomainMap,
  createEnvDomainRule,
  updateEnvDomainRule,
  deleteEnvDomainRule,
  ApiRequestError,
  type EnvDomainRule,
  type EnvValue,
} from "@/lib/api-client";
import { EmptyState, ErrorState, Spinner } from "@/components/states";
import { envOf } from "@/lib/env";

const ENVS: EnvValue[] = ["prod", "staging", "dev"];

export default function EnvironmentsPage() {
  const { canWrite, isAuthed, promptLogin } = useAuth();
  const [rules, setRules] = useState<EnvDomainRule[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Add-form state.
  const [pattern, setPattern] = useState("");
  const [environment, setEnvironment] = useState<EnvValue>("staging");
  const [priority, setPriority] = useState("100");

  const load = useCallback(async () => {
    setLoadErr(null);
    try {
      setRules(await getEnvDomainMap());
    } catch (e) {
      if (e instanceof ApiRequestError && (e.status === 401 || e.status === 403)) setRules([]); // gated → show sign-in
      else setLoadErr("Couldn’t load the environment map.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function run(fn: () => Promise<unknown>) {
    if (!canWrite) return promptLogin();
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setErr(e instanceof ApiRequestError ? e.message : "Something went wrong — try again.");
    } finally {
      setBusy(false);
    }
  }

  const add = () =>
    run(async () => {
      await createEnvDomainRule({ pattern: pattern.trim().toLowerCase(), environment, priority: Number(priority) || 100 });
      setPattern("");
    });

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Environments</h1>
      <p className="mt-1.5 text-sm text-[var(--color-ink-dim)]">
        How a monitor’s target host maps to an environment (prod / staging / dev). Precedence, highest first:{" "}
        <b>manual override</b> (per monitor) → <b>manifest</b> env (declared in git) → <b>domain map</b> (below)
        → <b>prod</b> (default).
      </p>

      {/* ★ Guardrail: editing the map only affects checks that DON'T declare env in git and DON'T have an override. */}
      <div
        className="mt-4 rounded-md border px-4 py-3 text-[12px]"
        style={{
          borderColor: "color-mix(in srgb, var(--color-warn) 30%, transparent)",
          background: "color-mix(in srgb, var(--color-warn) 8%, transparent)",
          color: "var(--color-ink-dim)",
        }}
      >
        Editing the map changes the <b>inferred</b> env — it re-tags only monitors that <b>don’t</b> declare an
        environment in their manifest <b>and don’t</b> have a manual override. It does not re-tag everything, and
        it never clobbers a manual override. Changes take effect on the next reconcile.
      </div>

      {/* The ordered rules. */}
      <section className="mt-6">
        <div className="mb-2 sw-eyebrow">Domain → environment rules (lowest priority wins)</div>
        {loadErr ? (
          <div>
            <ErrorState message={loadErr} />
            <button type="button" onClick={() => void load()} className="sw-btn sw-btn-sm mt-2">Retry</button>
          </div>
        ) : rules === null ? (
          <Spinner label="Loading the environment map…" />
        ) : rules.length === 0 && !isAuthed ? (
          <EmptyState title="Sign in to view the environment map." />
        ) : (
          <div className="overflow-hidden rounded-lg border border-[var(--color-border)]">
            <div className="grid grid-cols-[1fr_110px_90px_auto] gap-2 border-b border-[var(--color-border)] bg-[var(--color-panel-2)] px-4 py-2 text-[11px] uppercase tracking-wider text-[var(--color-ink-faint)]">
              <span>Pattern</span>
              <span>Environment</span>
              <span>Priority</span>
              <span className="text-right">{canWrite ? "Actions" : ""}</span>
            </div>
            {rules.length === 0 ? (
              <div className="px-4 py-6 text-sm text-[var(--color-ink-faint)]">No rules yet.</div>
            ) : (
              rules.map((r) => <RuleRow key={r.id} rule={r} canWrite={canWrite} busy={busy} onChanged={load} setErr={setErr} promptLogin={promptLogin} />)
            )}
          </div>
        )}

        {/* Add a rule. */}
        {canWrite && (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-[var(--color-ink-faint)]">Pattern (host or *.suffix)</span>
              <input
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder="*.staging.wegmans.com"
                data-testid="env-rule-pattern"
                className="sw-mono w-64 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-[var(--color-ink-faint)]">Environment</span>
              <select value={environment} onChange={(e) => setEnvironment(e.target.value as EnvValue)} className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm">
                {ENVS.map((e) => <option key={e} value={e}>{e}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-[var(--color-ink-faint)]">Priority</span>
              <input value={priority} onChange={(e) => setPriority(e.target.value)} inputMode="numeric" className="w-20 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm" />
            </label>
            <button type="button" onClick={add} disabled={busy || pattern.trim() === ""} data-testid="env-rule-add" className="sw-btn sw-btn-sm sw-btn-primary">
              Add rule
            </button>
          </div>
        )}
        {err && <p className="mt-2 text-[12px]" style={{ color: "var(--color-fail)" }}>{err}</p>}
      </section>

      <OverriddenChecks />
    </main>
  );
}

function RuleRow({
  rule,
  canWrite,
  busy,
  onChanged,
  setErr,
  promptLogin,
}: {
  rule: EnvDomainRule;
  canWrite: boolean;
  busy: boolean;
  onChanged: () => Promise<void>;
  setErr: (s: string | null) => void;
  promptLogin: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [pattern, setPattern] = useState(rule.pattern);
  const [environment, setEnvironment] = useState<EnvValue>(rule.environment);
  const [priority, setPriority] = useState(String(rule.priority));
  const [local, setLocal] = useState(false);

  async function act(fn: () => Promise<unknown>) {
    if (!canWrite) return promptLogin();
    setLocal(true);
    setErr(null);
    try {
      await fn();
      await onChanged();
      setEditing(false);
    } catch (e) {
      setErr(e instanceof ApiRequestError ? e.message : "Couldn’t save the rule.");
    } finally {
      setLocal(false);
    }
  }

  if (editing) {
    return (
      <div className="grid grid-cols-[1fr_110px_90px_auto] items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <input value={pattern} onChange={(e) => setPattern(e.target.value)} className="sw-mono rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[13px]" />
        <select value={environment} onChange={(e) => setEnvironment(e.target.value as EnvValue)} className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1 py-1 text-[13px]">
          {ENVS.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
        <input value={priority} onChange={(e) => setPriority(e.target.value)} inputMode="numeric" className="w-16 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[13px]" />
        <div className="flex justify-end gap-1.5">
          <button type="button" disabled={busy || local} onClick={() => act(() => updateEnvDomainRule(rule.id, { pattern: pattern.trim().toLowerCase(), environment, priority: Number(priority) || 100 }))} className="sw-btn sw-btn-sm sw-btn-primary">Save</button>
          <button type="button" onClick={() => setEditing(false)} className="sw-btn sw-btn-sm sw-btn-ghost">Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[1fr_110px_90px_auto] items-center gap-2 border-b border-[var(--color-border)] px-4 py-2 last:border-b-0" data-testid={`env-rule-${rule.id}`}>
      <span className="sw-mono truncate text-[13px] text-[var(--color-ink)]">{rule.pattern}</span>
      <span className="sw-mono text-[13px] text-[var(--color-ink-dim)]">{rule.environment}</span>
      <span className="sw-mono text-[13px] text-[var(--color-ink-faint)]">{rule.priority}</span>
      <div className="flex justify-end gap-1.5">
        {canWrite && (
          <>
            <button type="button" onClick={() => setEditing(true)} className="sw-btn sw-btn-sm sw-btn-ghost">Edit</button>
            <button type="button" disabled={busy || local} onClick={() => act(() => deleteEnvDomainRule(rule.id))} className="sw-btn sw-btn-sm sw-btn-ghost" style={{ color: "var(--color-fail)" }}>Delete</button>
          </>
        )}
      </div>
    </div>
  );
}

/** The checks that carry a manual override — so a wrong override is discoverable (and fixable on its page). */
function OverriddenChecks() {
  const { data: checks } = useChecks();
  const overridden = (checks ?? []).filter((c) => c.environment_override != null);
  if (overridden.length === 0) return null;
  return (
    <section className="mt-8">
      <div className="mb-2 sw-eyebrow">Monitors with a manual override ({overridden.length})</div>
      <div className="overflow-hidden rounded-lg border border-[var(--color-border)]">
        {overridden.map((c) => (
          <Link
            key={c.id}
            href={`/checks/${c.id}`}
            className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-2 last:border-b-0 hover:bg-[var(--color-panel-2)]"
          >
            <span className="truncate text-sm text-[var(--color-ink)]">{c.name}</span>
            <span className="sw-mono shrink-0 text-[12px] text-[var(--color-ink-dim)]">
              {envOf(c)} <span className="text-[var(--color-ink-faint)]">(override; derived {c.environment})</span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
