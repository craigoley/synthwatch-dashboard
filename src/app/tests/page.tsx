"use client";

/**
 * The "Tests" area — a SCRATCHPAD that preview-runs an uploaded monitor spec in the low-privilege
 * synthwatch-sandbox job, so an SRE can validate flow structure / selectors / assertions before opening a
 * repo PR. It NEVER creates a monitor — the only path to production stays a PR in synthwatch-monitors.
 *
 * Three roles hold: the repo is truth, this area is a scratchpad, the PR is the only path to prod. So:
 *   • EDITOR/ADMIN-gated on the ROUTE (a preview is code-execution), not merely hidden in nav.
 *   • PASS-1 is UNAUTHENTICATED against a public/non-prod target — an authed monitor's login step fails
 *     VISIBLY (the safe default, said out loud below, not a confusing failure).
 *   • Bounds (rate + concurrency) are surfaced HONESTLY so a 429 is explained, never a mystery.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";

import { useAuth } from "@/components/auth-provider";
import { FunnelBarStatic } from "@/components/funnel-bar";
import { EmptyState } from "@/components/states";
import { SummaryBody } from "@/components/trace-summary";
import { TraceViewer } from "@/components/trace-viewer";
import {
  ApiRequestError,
  createPreview,
  getPreview,
  getPreviewQuota,
  type PreviewPoll,
  type PreviewQuota,
  type PreviewResult,
  type PreviewStep,
} from "@/lib/api-client";
import type { RunStep, RunStepStatus } from "@/lib/types";

const EXAMPLE_SPEC = `import { test, expect, step } from '../../lib/flow';

test('homepage loads', async ({ page }) => {
  await step('open the homepage', async () => {
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  });
  await step('assert the page rendered', async () => {
    await expect(page.locator('body')).toBeVisible();
  });
});
`;

const POLL_MS = 2000;
const MAX_SPEC_BYTES = 256 * 1024;

type RunState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "polling"; token: string; poll: PreviewPoll | null }
  | { phase: "done"; token: string; poll: PreviewPoll }
  | { phase: "error"; message: string; status?: number };

export default function TestsPage() {
  const { canWrite, isAuthed, promptLogin } = useAuth();

  // ── ROUTE GATE (the real one — not just the hidden nav entry). A viewer is BLOCKED here even by URL. ──
  if (!canWrite) {
    return (
      <div className="space-y-6">
        <Header />
        <EmptyState
          title={isAuthed ? "Editors and admins only." : "Sign in to run a preview."}
          hint={
            isAuthed
              ? "Running a preview executes an uploaded spec in a sandbox — it's an editor/admin capability."
              : "A preview compiles and runs an uploaded spec, so it needs an editor or admin session."
          }
          action={
            !isAuthed ? (
              <button onClick={promptLogin} className="sw-btn sw-btn-primary">
                Sign in
              </button>
            ) : undefined
          }
        />
      </div>
    );
  }

  return <TestsWorkbench />;
}

function Header() {
  return (
    <div className="space-y-1">
      <div className="sw-eyebrow">Scratchpad</div>
      <h1 className="text-xl font-semibold text-[var(--color-ink)]">Tests</h1>
      <p className="max-w-2xl text-sm text-[var(--color-ink-dim)]">
        Preview-run a monitor spec in an isolated sandbox to check its flow, selectors, and assertions. This
        never creates a monitor — when it looks good, open a PR in{" "}
        <span className="sw-mono">synthwatch-monitors</span>.
      </p>
    </div>
  );
}

function TestsWorkbench() {
  const [spec, setSpec] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [run, setRun] = useState<RunState>({ phase: "idle" });
  // ★ The poll effect keys on this STABLE token, NOT the whole `run` object — else every 'running' tick's
  //   setRun mints a new `run`, tearing down + re-running the effect and firing GET back-to-back (a hot loop
  //   against a rate-limited endpoint family). It's set when a preview starts, cleared on the terminal poll.
  const [pollToken, setPollToken] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // ── Live bounds — poll a bit faster while a preview is in flight so "N of 3 running" tracks reality. ──
  const active = run.phase === "starting" || run.phase === "polling";
  const { data: quota, mutate: refreshQuota } = useSWR("preview-quota", getPreviewQuota, {
    refreshInterval: active ? 3000 : 20000,
    revalidateOnFocus: true,
  });

  const specBytes = new TextEncoder().encode(spec).length;
  const tooLarge = specBytes > MAX_SPEC_BYTES;
  const canRun = spec.trim().length > 0 && !tooLarge && run.phase !== "starting" && run.phase !== "polling";

  // ── Poll loop: keyed on the STABLE pollToken, so it sets up ONCE per preview and paces at POLL_MS. Each
  //    tick's setRun updates the display WITHOUT re-running this effect (pollToken is unchanged); the terminal
  //    tick clears pollToken, which re-runs the effect into its early return (cleanup stops the interval). ──
  useEffect(() => {
    if (!pollToken) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const poll = await getPreview(pollToken);
        if (cancelled) return;
        if (poll.status === "running") {
          setRun({ phase: "polling", token: pollToken, poll });
        } else {
          setRun({ phase: "done", token: pollToken, poll });
          setPollToken(null);
          void refreshQuota();
        }
      } catch (e) {
        if (cancelled) return;
        setRun({ phase: "error", message: errMessage(e), status: errStatus(e) });
        setPollToken(null);
      }
    };
    const id = setInterval(tick, POLL_MS);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pollToken, refreshQuota]);

  const onRun = useCallback(async () => {
    setRun({ phase: "starting" });
    try {
      const { token } = await createPreview(spec, targetUrl.trim() || undefined);
      setRun({ phase: "polling", token, poll: null });
      setPollToken(token); // starts the poll effect
      void refreshQuota();
    } catch (e) {
      setRun({ phase: "error", message: errMessage(e), status: errStatus(e) });
      void refreshQuota();
    }
  }, [spec, targetUrl, refreshQuota]);

  const onFile = useCallback((file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setSpec(typeof reader.result === "string" ? reader.result : "");
    reader.readAsText(file);
  }, []);

  return (
    <div className="space-y-6">
      <Header />

      <QuotaGauge quota={quota} />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* ── Compose ─────────────────────────────────────────────────────────── */}
        <section className="sw-panel space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-[var(--color-ink)]">Spec</h2>
            <div className="flex items-center gap-2">
              <button type="button" className="sw-btn sw-btn-sm" onClick={() => setSpec(EXAMPLE_SPEC)}>
                Load example
              </button>
              <button
                type="button"
                className="sw-btn sw-btn-sm"
                onClick={() => fileRef.current?.click()}
              >
                Upload file
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".ts,.js,.txt,.mjs"
                className="sr-only"
                aria-label="Upload a spec file"
                onChange={(e) => onFile(e.target.files?.[0])}
              />
            </div>
          </div>

          <label className="block">
            <span className="sw-label">Playwright spec (imports from lib/flow)</span>
            <textarea
              className="sw-textarea mt-1 h-72 w-full font-mono text-[12px] leading-relaxed"
              placeholder="Paste a monitor spec, click Load example, or upload a file…"
              value={spec}
              spellCheck={false}
              onChange={(e) => setSpec(e.target.value)}
              aria-describedby="spec-size"
            />
            <span
              id="spec-size"
              className={`mt-1 block text-[11px] ${tooLarge ? "text-[var(--color-fail)]" : "text-[var(--color-ink-dim)]"}`}
            >
              {(specBytes / 1024).toFixed(1)} KB{tooLarge ? ` — over the ${MAX_SPEC_BYTES / 1024} KB limit` : ""}
            </span>
          </label>

          <label className="block">
            <span className="sw-label">Target URL (optional)</span>
            <input
              className="sw-input mt-1 w-full"
              placeholder="https://example.com"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              inputMode="url"
            />
            <span className="mt-1 block text-[11px] text-[var(--color-ink-dim)]">
              Public / non-prod only. Defaults to <span className="sw-mono">example.com</span>.
            </span>
          </label>

          <UnauthNotice />

          <div className="flex items-center gap-3">
            <button
              type="button"
              className="sw-btn sw-btn-primary"
              disabled={!canRun}
              onClick={onRun}
            >
              {run.phase === "starting"
                ? "Starting…"
                : run.phase === "polling"
                  ? "Running…"
                  : "Run preview"}
            </button>
            {(run.phase === "done" || run.phase === "error") && (
              <button type="button" className="sw-btn" onClick={() => setRun({ phase: "idle" })}>
                Clear
              </button>
            )}
          </div>
        </section>

        {/* ── Result ──────────────────────────────────────────────────────────── */}
        <section className="sw-panel" aria-live="polite">
          <h2 className="mb-4 text-sm font-semibold text-[var(--color-ink)]">Result</h2>
          <ResultView run={run} />
        </section>
      </div>

      <EphemeralFooter />
    </div>
  );
}

/** Honest bounds gauge — "N of 3 running · M of 20 this hour", the same counts the API enforces. */
function QuotaGauge({ quota }: { quota: PreviewQuota | undefined }) {
  return (
    <div className="sw-card flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
      <span className="sw-eyebrow">Limits</span>
      <Meter
        label="running now"
        value={quota?.running}
        max={quota?.maxConcurrent ?? 3}
        hint="concurrent previews"
      />
      <Meter label="this hour" value={quota?.hourly} max={quota?.maxPerHour ?? 20} hint="per-user rate" />
      <span className="text-[12px] text-[var(--color-ink-dim)]">
        Hitting a limit returns a clear message below — it isn&apos;t a mystery.
      </span>
    </div>
  );
}

function Meter({ label, value, max, hint }: { label: string; value: number | undefined; max: number; hint: string }) {
  const v = value ?? 0;
  const atCap = value !== undefined && v >= max;
  return (
    <span className="inline-flex items-baseline gap-1.5" title={hint}>
      <span className={`font-mono text-sm ${atCap ? "text-[var(--color-fail)]" : "text-[var(--color-ink)]"}`}>
        {value === undefined ? "–" : v} of {max}
      </span>
      <span className="text-[12px] text-[var(--color-ink-dim)]">{label}</span>
    </span>
  );
}

/** Set expectations: pass-1 is UNAUTHENTICATED. An authed monitor's login step will fail — say so. */
function UnauthNotice() {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3 text-[12px] leading-relaxed text-[var(--color-ink-dim)]">
      <span aria-hidden="true">ℹ️ </span>
      <span className="font-medium text-[var(--color-ink)]">Runs unauthenticated.</span> A monitor that logs
      in will <span className="font-medium">fail at its login step</span> here — that&apos;s expected. You&apos;re
      testing flow structure, selectors, and assertions, not authenticated behavior. (Authenticated testing is
      a separate, gated capability — no credentials are ever entered here.)
    </div>
  );
}

function ResultView({ run }: { run: RunState }) {
  if (run.phase === "idle") {
    return (
      <p className="text-sm text-[var(--color-ink-dim)]">
        Compose a spec and run a preview. The result — compiled test names, execution status, and captured
        output — appears here.
      </p>
    );
  }
  if (run.phase === "starting" || (run.phase === "polling" && !run.poll)) {
    return <RunningRow label="Starting the sandbox job…" />;
  }
  if (run.phase === "polling") {
    return <RunningRow label="Running the spec in the sandbox…" />;
  }
  if (run.phase === "error") {
    return <ErrorRow message={run.message} status={run.status} />;
  }
  // done
  return <DoneView poll={run.poll} />;
}

function RunningRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-[var(--color-ink)]">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

function ErrorRow({ message, status }: { message: string; status?: number }) {
  const isBound = status === 429;
  return (
    <div className="space-y-2">
      <StatusPill glyph="✕" label={isBound ? "Blocked" : "Couldn't run"} tone="fail" />
      <p className="text-sm text-[var(--color-ink)]">{message}</p>
      {isBound && (
        <p className="text-[12px] text-[var(--color-ink-dim)]">
          You&apos;ve hit a preview limit (see the gauge above). Wait for a slot to free up — an abandoned
          preview releases its slot within a few minutes — then try again.
        </p>
      )}
    </div>
  );
}

function DoneView({ poll }: { poll: PreviewPoll }) {
  const result: PreviewResult | null = poll.result;

  if (poll.status === "timeout") {
    return (
      <div className="space-y-2">
        <StatusPill glyph="⏱" label="Timed out" tone="warn" />
        <p className="text-sm text-[var(--color-ink)]">
          The sandbox produced no result within its timeout window. If the spec is expensive or the job was
          abandoned, try again; a persistent timeout usually means the spec failed to compile or load.
        </p>
      </div>
    );
  }
  if (!result) {
    return (
      <div className="space-y-2">
        <StatusPill glyph="✕" label="Failed" tone="fail" />
        <p className="text-sm text-[var(--color-ink)]">
          The preview ended without a result — the spec likely failed to compile or load (an import outside{" "}
          <span className="sw-mono">lib/flow</span> won&apos;t resolve in the sandbox).
        </p>
      </div>
    );
  }

  // B2: a browser run reports result.status ('pass'|'fail'|'error'). Older / compile-failed results have none.
  const ranBrowser = result.status != null;
  const passed = ranBrowser ? result.status === "pass" : result.ok && result.exitCode === 0;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <StatusPill
          glyph={passed ? "✓" : "✕"}
          label={
            passed
              ? "Passed"
              : result.failedStep
                ? `Failed at "${result.failedStep}"`
                : ranBrowser
                  ? "Failed"
                  : "Spec did not pass"
          }
          tone={passed ? "pass" : "fail"}
        />
        {result.tests[0] && <span className="text-[12px] text-[var(--color-ink-dim)] font-mono">{result.tests[0]}</span>}
      </div>

      {result.error && <p className="text-sm text-[var(--color-ink)]">{result.error}</p>}

      {/* ★ The REAL trace, rendered with the SAME components a check's detail view uses — steps + timings,
          failure screenshot, and network/console signals. Anything the preview can't fill is honestly-absent
          (a dashed "unavailable" block), never a fabricated zero. */}
      {ranBrowser && <TraceView result={result} token={poll.token} />}

      {result.stdout.trim() && <OutputBlock label="Console output" text={result.stdout} />}
      {result.stderr.trim() && <OutputBlock label="Errors" text={result.stderr} tone="fail" />}

      <p className="text-[11px] text-[var(--color-ink-dim)]">
        This is the same trace a real check produces. A login-gated step will show as a failure here because the
        preview runs unauthenticated (see the note above).
      </p>
    </div>
  );
}

function toRunStep(s: PreviewStep): RunStep {
  return {
    id: s.index,
    run_id: 0,
    step_index: s.index,
    name: s.name,
    status: s.status as RunStepStatus,
    duration_ms: s.durationMs,
    error_message: s.errorMessage,
    started_at: "",
  };
}

/** The trace panels — the SAME FunnelBarStatic / SummaryBody / TraceViewer a real check's detail renders. */
function TraceView({ result, token }: { result: PreviewResult; token: string }) {
  const steps = (result.steps ?? []).map(toRunStep);
  const didFail = result.status === "fail" || result.status === "error";
  return (
    <div className="space-y-4">
      <div>
        <div className="sw-label mb-1">Steps</div>
        {steps.length > 0 ? (
          <FunnelBarStatic steps={steps} />
        ) : (
          <Unavailable what="step timeline" why="the flow recorded no steps (it failed before the first step, or declared none)" />
        )}
      </div>

      {didFail && (
        <div>
          <div className="sw-label mb-1">Screenshot at failure</div>
          {result.hasScreenshot ? (
            <PreviewScreenshot token={token} />
          ) : (
            <Unavailable what="failure screenshot" why="none was captured for this run" />
          )}
        </div>
      )}

      <div>
        <div className="sw-label mb-1">Network &amp; console</div>
        {result.traceSignals ? (
          <SummaryBody s={result.traceSignals} />
        ) : (
          <Unavailable what="network/console signals" why="no trace was produced for this run" />
        )}
      </div>

      <div>
        <div className="sw-label mb-1">Playwright trace</div>
        {result.hasTrace ? (
          <TraceViewer
            mintSas={async () => ({
              // A same-origin proxy path (not a SAS) — the API MI streams the private blob; no widening.
              url: `${window.location.origin}/preview-trace/${token}`,
              expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            })}
            openLabel="▸ View Playwright trace"
            iframeTitle={`Playwright trace for preview ${token}`}
            viewTestId="view-preview-trace"
            iframeTestId="preview-trace-viewer"
            downloadTestId="download-preview-trace"
          />
        ) : (
          <Unavailable what="interactive trace" why="no trace.zip (the run produced none, or it exceeded the size cap)" />
        )}
      </div>
    </div>
  );
}

/** Honest-absent (the cost-panel dashed pattern): absent ≠ empty ≠ zero — say what's missing and why. */
function Unavailable({ what, why }: { what: string; why: string }) {
  return (
    <div
      className="rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2"
      style={{ borderLeft: "3px solid var(--color-warn)" }}
    >
      <div className="text-[13px] text-[var(--color-ink-dim)]">No {what}</div>
      <div className="text-[11px] text-[var(--color-ink-dim)]">{why}</div>
    </div>
  );
}

function PreviewScreenshot({ token }: { token: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Unavailable what="failure screenshot" why="the artifact has expired or was removed" />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a streamed same-origin proxy blob, not a static asset
    <img
      src={`/preview-screenshot/${token}`}
      alt="Preview failure screenshot"
      className="max-w-full rounded-md border border-[var(--color-border)]"
      onError={() => setFailed(true)}
    />
  );
}

function OutputBlock({ label, text, tone }: { label: string; text: string; tone?: "fail" }) {
  return (
    <div>
      <div className="sw-label mb-1">{label}</div>
      <pre
        className={`sw-mono max-h-64 overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3 text-[11px] leading-relaxed whitespace-pre-wrap ${
          tone === "fail" ? "text-[var(--color-fail)]" : "text-[var(--color-ink)]"
        }`}
      >
        {text}
      </pre>
    </div>
  );
}

function StatusPill({ glyph, label, tone }: { glyph: string; label: string; tone: "pass" | "fail" | "warn" }) {
  const color =
    tone === "pass" ? "var(--color-pass)" : tone === "warn" ? "var(--color-warn)" : "var(--color-fail)";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] font-medium"
      style={{ borderColor: color, color }}
    >
      <span aria-hidden="true">{glyph}</span>
      {label}
    </span>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--color-border)] border-t-[var(--color-brand)]"
      aria-hidden="true"
    />
  );
}

/** The path to production is explicit and singular: a PR in the monitors repo. Tests are a scratchpad. */
function EphemeralFooter() {
  return (
    <div className="sw-card text-sm text-[var(--color-ink-dim)]">
      <span className="font-medium text-[var(--color-ink)]">This is a scratchpad.</span> A preview never
      creates or changes a monitor. When a spec looks right, commit it to{" "}
      <span className="sw-mono">synthwatch-monitors</span> and open a PR — the repo is the only path to
      production.
    </div>
  );
}

function errMessage(e: unknown): string {
  if (e instanceof ApiRequestError) return e.message;
  return e instanceof Error ? e.message : "Something went wrong.";
}
function errStatus(e: unknown): number | undefined {
  return e instanceof ApiRequestError ? e.status : undefined;
}
