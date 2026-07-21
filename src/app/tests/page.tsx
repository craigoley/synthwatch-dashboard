"use client";

/**
 * The "Tests" area — a SCRATCHPAD that preview-runs an uploaded monitor spec in the low-privilege
 * synthwatch-sandbox job, so an SRE can validate flow structure / selectors / assertions before opening a
 * repo PR. It NEVER creates a monitor — the only path to production stays a PR in synthwatch-monitors.
 *
 * Three roles hold: the repo is truth, this area is a scratchpad, the PR is the only path to prod. So:
 *   • EDITOR/ADMIN-gated on the ROUTE (a preview is code-execution), not merely hidden in nav.
 *   • Credentials are OPTIONAL and EPHEMERAL — typed here, used for ONE run, never stored. Without them a
 *     preview runs unauthenticated and a login-gated step fails visibly; with them the fleet's
 *     sensitive-monitor REDACTION applies (see CredentialsPanel) — trace text, stdout and errors are
 *     scrubbed. The failure screenshot is KEPT either way (runner previewPersistPlan). Both behaviours
 *     are stated inline, so neither reads as a bug.
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

// ★ `credentialed` is captured AT SUBMIT and carried through the run, because the credential fields are
//   cleared the moment the run finishes — so by the time the result renders, the form can no longer tell us
//   whether this run was authenticated. The result view needs it to explain that the output was REDACTED.
type RunState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "polling"; token: string; poll: PreviewPoll | null; credentialed: boolean }
  | { phase: "done"; token: string; poll: PreviewPoll; credentialed: boolean }
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
  // ── OPTIONAL, EPHEMERAL credentials. Held in component state for the duration of ONE run and wiped on the
  //    terminal tick (see clearCredentials). Never persisted to localStorage / sessionStorage / a URL / SWR
  //    cache — this state and the POST body are the only places they ever exist in the browser.
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [bypassToken, setBypassToken] = useState("");
  const [showSecrets, setShowSecrets] = useState(false);
  // ★ DEFAULT TRUE = redact, which is byte-for-byte today's behaviour: the API treats absent and true
  //   identically (`body.redactCredentials != false`), so a user who never touches this control gets
  //   exactly what they got before this existed.
  const [redactCredentials, setRedactCredentials] = useState(true);
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
  // Any non-empty credential makes this a CREDENTIALED (sensitive) run — the same "did anything arrive?"
  // test the API and runner apply, so the inline warning matches what actually happens downstream.
  const credentialed = [username, password, bypassToken].some((v) => v.length > 0);

  // ★ "Used for this run only" is enforced HERE, not just promised in the copy: the moment a run reaches a
  //   terminal state the fields are wiped. A re-run requires retyping — deliberate, and the honest cost of
  //   never holding a credential longer than the run that needed it.
  const clearCredentials = useCallback(() => {
    setUsername("");
    setPassword("");
    setBypassToken("");
    setShowSecrets(false);
  }, []);

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
          setRun((prev) => ({
            phase: "polling",
            token: pollToken,
            poll,
            credentialed: prev.phase === "polling" ? prev.credentialed : false,
          }));
        } else {
          setRun((prev) => ({
            phase: "done",
            token: pollToken,
            poll,
            credentialed: prev.phase === "polling" ? prev.credentialed : false,
          }));
          setPollToken(null);
          clearCredentials(); // ★ terminal → the credential is gone from the browser
          void refreshQuota();
        }
      } catch (e) {
        if (cancelled) return;
        setRun({ phase: "error", message: errMessage(e), status: errStatus(e) });
        setPollToken(null);
        clearCredentials(); // ★ a failed poll is terminal too — never leave a credential sitting in state
      }
    };
    const id = setInterval(tick, POLL_MS);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pollToken, refreshQuota, clearCredentials]);

  const onRun = useCallback(async () => {
    setRun({ phase: "starting" });
    // Snapshot before the await: the fields are wiped on completion, and `credentialed` must describe the run
    // that was actually submitted.
    const wasCredentialed = credentialed;
    try {
      const { token } = await createPreview(
        spec,
        targetUrl.trim() || undefined,
        { username, password, vercelBypassToken: bypassToken },
        redactCredentials,
      );
      setRun({ phase: "polling", token, poll: null, credentialed: wasCredentialed });
      setPollToken(token); // starts the poll effect
      void refreshQuota();
    } catch (e) {
      setRun({ phase: "error", message: errMessage(e), status: errStatus(e) });
      clearCredentials(); // ★ the run never started — do not keep the credential around for a retry
      void refreshQuota();
    }
  }, [spec, targetUrl, username, password, bypassToken, credentialed, redactCredentials, refreshQuota, clearCredentials]);

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

          <CredentialsPanel
            username={username}
            password={password}
            bypassToken={bypassToken}
            showSecrets={showSecrets}
            credentialed={credentialed}
            redactCredentials={redactCredentials}
            onRedactCredentials={setRedactCredentials}
            onUsername={setUsername}
            onPassword={setPassword}
            onBypassToken={setBypassToken}
            onToggleShow={() => setShowSecrets((s) => !s)}
          />

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

/**
 * OPTIONAL credentials — the honest contract, stated where the typing happens.
 *
 * ★ Every claim in this copy is enforced somewhere real, not aspirational:
 *   "used for this run only"  → cleared from React state on the terminal tick (clearCredentials)
 *   "never stored"            → the API writes only spec_sha256; the credential lives in an encrypted blob
 *                               the sandbox deletes on read
 *   "never logged"            → redacted out of stdout / trace / errors by the runner's makeRedactor
 * ★ There is deliberately NO "no screenshot" claim here any more: previewPersistPlan keeps the failure
 *   screenshot for a credentialed preview (a password field renders MASKED, and the Tests area is
 *   editor/admin-only). Claiming otherwise was a false statement about how sensitive data is handled.
 * If one of those stops being true, this copy becomes a lie — so they change together.
 */
function CredentialsPanel({
  username,
  password,
  bypassToken,
  showSecrets,
  credentialed,
  redactCredentials,
  onRedactCredentials,
  onUsername,
  onPassword,
  onBypassToken,
  onToggleShow,
}: {
  username: string;
  password: string;
  bypassToken: string;
  showSecrets: boolean;
  credentialed: boolean;
  redactCredentials: boolean;
  onRedactCredentials: (v: boolean) => void;
  onUsername: (v: string) => void;
  onPassword: (v: string) => void;
  onBypassToken: (v: string) => void;
  onToggleShow: () => void;
}) {
  // ★ Masked by default. The reveal toggle exists because a mistyped credential otherwise fails the login
  //   and reads as a broken selector — in a diagnostic tool that is the expensive failure mode.
  const type = showSecrets ? "text" : "password";
  return (
    <div className="space-y-3 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="sw-label">Credentials (optional)</span>
        <button
          type="button"
          className="sw-btn sw-btn-sm"
          onClick={onToggleShow}
          data-testid="preview-toggle-secrets"
          aria-pressed={showSecrets}
        >
          {showSecrets ? "Hide" : "Show"}
        </button>
      </div>

      <p className="text-[12px] leading-relaxed text-[var(--color-ink-dim)]" data-testid="preview-cred-contract">
        Leave these empty to run <span className="font-medium text-[var(--color-ink)]">unauthenticated</span> —
        a login-gated step will then fail at the login, which is expected. Fill them in to test a real
        authenticated flow.{" "}
        <span className="font-medium text-[var(--color-ink)]">
          Used for this run only. Never stored, never logged.
        </span>
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="sw-label">Username</span>
          <input
            className="sw-input mt-1 w-full"
            type={type}
            value={username}
            onChange={(e) => onUsername(e.target.value)}
            autoComplete="off"
            data-testid="preview-username"
          />
        </label>
        <label className="block">
          <span className="sw-label">Password</span>
          <input
            className="sw-input mt-1 w-full"
            type={type}
            value={password}
            onChange={(e) => onPassword(e.target.value)}
            autoComplete="off"
            data-testid="preview-password"
          />
        </label>
        <label className="block">
          <span className="sw-label">Vercel bypass token</span>
          <input
            className="sw-input mt-1 w-full"
            type={type}
            value={bypassToken}
            onChange={(e) => onBypassToken(e.target.value)}
            autoComplete="off"
            data-testid="preview-bypass-token"
          />
          <span className="mt-1 block text-[11px] text-[var(--color-ink-dim)]">
            For a protected Vercel preview deployment. Paste your own — it is never injected for you.
          </span>
        </label>
      </div>

      {/* ★ Say what CHANGES before the run. What changes is REDACTION of the text channels — the failure
          screenshot is kept exactly as it is for an uncredentialed run (runner previewPersistPlan). */}
      {credentialed && (
        <div
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[12px] leading-relaxed text-[var(--color-ink-dim)]"
          style={{ borderLeft: "3px solid var(--color-warn)" }}
          data-testid="preview-sensitive-notice"
        >
          <span aria-hidden="true">🔒 </span>
          <span className="font-medium text-[var(--color-ink)]">
            This run is treated as sensitive, so its output is redacted.
          </span>{" "}
          The credentials you type are scrubbed out of the trace text, console output and error messages. The
          failure screenshot is still kept — a password field renders masked, so suppressing it cost the
          primary diagnostic and bought little. You get the full trace: the failing step, its timing, and the
          error.
        </div>
      )}

      {/* ★ THE OPT-OUT. Only meaningful on a credentialed run — with no credentials there is nothing to
          redact, so the control is shown only when it can actually do something. DEFAULT ON: unchecking is
          an explicit, audited choice (the API records it in sandbox_preview + audit_log). */}
      {credentialed && (
        <label className="flex items-start gap-2 text-[12px] leading-relaxed" data-testid="preview-redact-toggle-label">
          <input
            type="checkbox"
            className="mt-[3px]"
            checked={redactCredentials}
            onChange={(e) => onRedactCredentials(e.target.checked)}
            data-testid="preview-redact-toggle"
          />
          <span>
            <span className="font-medium text-[var(--color-ink)]">Redact credentials from output</span>{" "}
            <span className="text-[var(--color-ink-dim)]">
              {redactCredentials ? (
                <>On — the default. Your credentials are scrubbed from the trace text, console output and errors.</>
              ) : (
                /* ★ Every claim here is what the code does, checked against the runner and API:
                     - text only: runner swaps makeRedactor for IDENTITY_REDACTOR and keeps the RAW trace zip
                     - the screenshot is NOT affected (previewPersistPlan → failureScreenshot: true always)
                     - artifact lifetime IS shortened (API deletes on view; ~5-min timer sweep otherwise) */
                <>
                  <span className="font-medium text-[var(--color-warn)]">Off — raw output.</span> Your credentials
                  will appear in the trace text, console output and errors. This does not change the failure
                  screenshot, which is kept either way. Artifacts are deleted as soon as you view the result, or
                  within about 5 minutes if you never open it. The choice is recorded against your account.
                </>
              )}
            </span>
          </span>
        </label>
      )}
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
  return <DoneView poll={run.poll} credentialed={run.credentialed} />;
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

function DoneView({ poll, credentialed }: { poll: PreviewPoll; credentialed: boolean }) {
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

      <p className="text-[11px] text-[var(--color-ink-dim)]" data-testid="preview-done-footer">
        This is the same trace a real check produces.{" "}
        {credentialed ? (
          <>
            This run used the credentials you supplied — they were used for this run only and have already been
            cleared. Anything they touched is redacted out of the trace and console output. The failure
            screenshot is kept, the same as an uncredentialed run.
          </>
        ) : (
          <>
            This run was unauthenticated, so a login-gated step shows as a failure here — that&apos;s expected.
            Add credentials above to test the authenticated flow.
          </>
        )}
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
function TraceView({
  result,
  token,
}: {
  result: PreviewResult;
  token: string;
}) {
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
            // ★ ONE branch now, because credentials no longer change screenshot retention. A missing
            //   screenshot means the run simply did not produce one — it is NOT policy, and the old
            //   credentialed-only "suppressed" explanation was false once previewPersistPlan landed.
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
function Unavailable({ what, why, testId }: { what: string; why: string; testId?: string }) {
  return (
    <div
      className="rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2"
      style={{ borderLeft: "3px solid var(--color-warn)" }}
      data-testid={testId}
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
