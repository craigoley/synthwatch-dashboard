"use client";

import { useState } from "react";

import type { ChainStep, Check, HttpMethod } from "@/lib/types";
import {
  AssertionBuilder,
  buildHttpConfigPayload,
  emptyHttpConfig,
  httpConfigFromParts,
  type HttpConfigState,
} from "@/components/assertion-builder";

// ── editor state ─────────────────────────────────────────────────────────────
export interface ExtractRow {
  var: string;
  jsonPath: string;
}
export interface StepState {
  /** Stable client-only id for React keys — survives reorder (NOT sent to the API). */
  id: string;
  name: string;
  method: HttpMethod;
  url: string;
  /** Reuses the single-check editor state: assertions + headers + body + auth. */
  http: HttpConfigState;
  extract: ExtractRow[];
}

const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];

// Monotonic per-session step id — stable across reorders so the keyed
// AssertionBuilder's internal state follows the step, not the slot.
let stepIdSeq = 0;
const nextStepId = () => `step-${(stepIdSeq += 1)}`;

function asMethod(m: string | null | undefined): HttpMethod {
  return METHODS.includes(m as HttpMethod) ? (m as HttpMethod) : "GET";
}

export function emptyStep(): StepState {
  return { id: nextStepId(), name: "", method: "GET", url: "", http: emptyHttpConfig(), extract: [] };
}

// ── (de)serialization between the API steps array and editor state ───────────

function stepFromApi(s: ChainStep): StepState {
  return {
    id: nextStepId(),
    name: s.name ?? "",
    method: asMethod(s.method),
    url: s.url ?? "",
    http: httpConfigFromParts(s.assertions, s.headers, s.body, s.auth),
    extract: (s.extract ?? []).map((e) => ({ var: e.var, jsonPath: e.jsonPath })),
  };
}

export function stepsFromCheck(check: Check | null | undefined): StepState[] {
  return (check?.steps ?? []).map(stepFromApi);
}

/** Build the API steps array from editor state (camelCase nested, as the API expects). */
export function buildStepsPayload(steps: StepState[]): ChainStep[] {
  return steps.map((s) => {
    const { assertions, request_headers, request_body, auth } = buildHttpConfigPayload(s.http);
    // Require BOTH var and jsonPath — a row with a var but empty jsonPath would be
    // sent as { var, jsonPath: "" }, which the API 400s on.
    const extract = s.extract
      .filter((e) => e.var.trim() !== "" && e.jsonPath.trim() !== "")
      .map((e) => ({ var: e.var.trim(), jsonPath: e.jsonPath.trim() }));
    return {
      name: s.name.trim(),
      method: s.method,
      url: s.url.trim(),
      headers: request_headers,
      body: request_body,
      auth,
      assertions,
      extract: extract.length ? extract : null,
    };
  });
}

// ── error routing ────────────────────────────────────────────────────────────

/** Strip the `steps[i].` prefix so the reused AssertionBuilder sees its own keys
 *  ("assertions[j]", "auth", …) and per-step errors route to the right row. */
function stepErrors(errors: Record<string, string>, i: number): Record<string, string> {
  const prefix = `steps[${i}].`;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(errors)) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  }
  return out;
}

// Keys surfaced at the step level (not handled inside AssertionBuilder).
const STEP_LEVEL_KEYS = ["template", "url", "name", "method", "headers", "body", "extract"];

// ── component ────────────────────────────────────────────────────────────────

const SELECT_CLS = "sw-select sw-mono text-[13px]";

export function MultistepBuilder({
  steps,
  onChange,
  errors,
}: {
  steps: StepState[];
  onChange: (s: StepState[]) => void;
  errors: Record<string, string>;
}) {
  const [open, setOpen] = useState<number | null>(0);

  const patchStep = (i: number, patch: Partial<StepState>) =>
    onChange(steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const addStep = () => {
    onChange([...steps, emptyStep()]);
    setOpen(steps.length);
  };
  const removeStep = (i: number) => onChange(steps.filter((_, idx) => idx !== i));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
    setOpen(j);
  };

  const setExtract = (i: number, k: number, patch: Partial<ExtractRow>) =>
    patchStep(i, { extract: steps[i]!.extract.map((e, idx) => (idx === k ? { ...e, ...patch } : e)) });
  const addExtract = (i: number) => patchStep(i, { extract: [...steps[i]!.extract, { var: "", jsonPath: "" }] });
  const removeExtract = (i: number, k: number) =>
    patchStep(i, { extract: steps[i]!.extract.filter((_, idx) => idx !== k) });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="sw-eyebrow">Step chain</span>
        <span className="text-[11px] text-[var(--color-ink-faint)]">runs in order; stops at the first failure</span>
      </div>

      {steps.length === 0 && (
        <p className="rounded-lg border border-dashed border-[var(--color-border)] px-3 py-4 text-center text-xs text-[var(--color-ink-dim)]">
          No steps yet. Add the first request in the chain (e.g. a login).
        </p>
      )}

      {steps.map((step, i) => {
        const se = stepErrors(errors, i);
        const stepLevelKey = STEP_LEVEL_KEYS.find((k) => se[k]);
        const stepLevelErr = stepLevelKey ? se[stepLevelKey] : null;
        const hasErr = Object.keys(se).length > 0;
        // Vars available here = union of vars extracted by all EARLIER steps.
        const available = Array.from(
          new Set(
            steps
              .slice(0, i)
              .flatMap((s) => s.extract.map((e) => e.var.trim()).filter(Boolean)),
          ),
        );
        const isOpen = open === i;
        return (
          <div
            key={step.id}
            className="rounded-lg border bg-[var(--color-bg)]"
            style={{ borderColor: hasErr ? "var(--color-fail)" : "var(--color-border)" }}
          >
            {/* step header */}
            <div className="flex items-center gap-2 px-3 py-2">
              <span className="sw-mono text-[11px] text-[var(--color-ink-faint)]">{i + 1}</span>
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : i)}
                className="flex-1 truncate text-left text-sm text-[var(--color-ink)]"
              >
                {isOpen ? "▾" : "▸"}{" "}
                <span className="sw-mono text-[12px] text-[var(--color-ink-dim)]">{step.method}</span>{" "}
                {step.name.trim() || step.url.trim() || <span className="text-[var(--color-ink-faint)]">untitled step</span>}
              </button>
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                className="sw-btn sw-btn-ghost sw-btn-sm disabled:opacity-30"
                aria-label="move step up"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === steps.length - 1}
                className="sw-btn sw-btn-ghost sw-btn-sm disabled:opacity-30"
                aria-label="move step down"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => removeStep(i)}
                className="sw-btn sw-btn-ghost sw-btn-sm"
                aria-label="remove step"
              >
                ✕
              </button>
            </div>

            {/* Step error (incl. the dangling-{{var}} template error) shows even when
                the card is COLLAPSED — the red border alone doesn't say what's wrong. */}
            {stepLevelErr && (
              <p className="px-3 pb-2 text-[11px]" style={{ color: "var(--color-fail)" }}>
                {stepLevelErr}
              </p>
            )}

            {isOpen && (
              <div className="space-y-3 border-t border-[var(--color-border)] p-3">
                <label className="block">
                  <span className="sw-label">Step name</span>
                  <input
                    className="sw-input text-[13px]"
                    value={step.name}
                    onChange={(e) => patchStep(i, { name: e.target.value })}
                    placeholder="login"
                    aria-label="step name"
                  />
                </label>

                <div className="flex gap-2">
                  <div>
                    <span className="sw-label">Method</span>
                    <select
                      className={SELECT_CLS}
                      value={step.method}
                      onChange={(e) => patchStep(i, { method: e.target.value as HttpMethod })}
                      aria-label="step method"
                    >
                      {METHODS.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                  <label className="flex-1">
                    <span className="sw-label">URL</span>
                    <input
                      className="sw-input sw-mono text-[13px]"
                      value={step.url}
                      onChange={(e) => patchStep(i, { url: e.target.value })}
                      placeholder="https://api.example.com/login"
                      aria-label="step url"
                    />
                  </label>
                </div>

                {/* available-variables helper */}
                <p className="text-[11px] text-[var(--color-ink-faint)]">
                  {available.length > 0 ? (
                    <>
                      Available variables (from earlier steps):{" "}
                      {available.map((v) => (
                        <span key={v} className="sw-mono text-[var(--color-brand)]">
                          {`{{${v}}}`}{" "}
                        </span>
                      ))}
                      — use in URL, headers, or body.
                    </>
                  ) : (
                    <>No variables available yet — extract one below to reference it in later steps.</>
                  )}
                </p>

                {/* per-step assertions + headers/body/auth (reused) */}
                <AssertionBuilder
                  value={step.http}
                  onChange={(http) => patchStep(i, { http })}
                  errors={se}
                />

                {/* extract rules */}
                <div className="rounded-lg border border-[var(--color-border)] p-3">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="sw-eyebrow">Extract → variables</span>
                    <span className="text-[11px] text-[var(--color-ink-faint)]">pull from JSON response</span>
                  </div>
                  <div className="space-y-2">
                    {step.extract.map((row, k) => (
                      <div key={k} className="flex items-center gap-2">
                        <input
                          className="sw-input sw-mono flex-1 text-[13px]"
                          value={row.var}
                          onChange={(e) => setExtract(i, k, { var: e.target.value })}
                          placeholder="token"
                          aria-label="extract variable name"
                        />
                        <span className="text-[11px] text-[var(--color-ink-faint)]">=</span>
                        <input
                          className="sw-input sw-mono flex-1 text-[13px]"
                          value={row.jsonPath}
                          onChange={(e) => setExtract(i, k, { jsonPath: e.target.value })}
                          placeholder="$.access_token"
                          aria-label="extract json path"
                        />
                        <button
                          type="button"
                          onClick={() => removeExtract(i, k)}
                          className="sw-btn sw-btn-ghost sw-btn-sm"
                          aria-label="remove extract rule"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                  <button type="button" onClick={() => addExtract(i)} className="sw-btn sw-btn-sm mt-2">
                    + Add extract rule
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <button type="button" onClick={addStep} className="sw-btn sw-btn-sm">
        + Add step
      </button>
    </div>
  );
}
