# Blocker + scope — credential-refs UI & auth-gated raw traces (2026-07-08)

Branch `feat/creds-ui-and-gated-traces`. **This was scoped as a build, but both features depend on API
"Prompt 2" DTOs + "runner 1b" that DO NOT EXIST yet** (verified against the LIVE API + the api/runner
source, below). Building the UI now means inventing two API contracts and mocking them — the exact
mock-vs-real divergence class this repo has been burned by ~4× recently (getRegionHealth `region`↔`location`,
egress per-IP granularity, ai-insights nested↔flat, the sandbox runs-DTO). So this PR is **docs-only**: it
proves the gap, documents the ready dashboard side, and specifies the exact contract each feature needs so
the build lands with no open questions. **OBSERVED** = curled/read this pass; **INFERRED** = reasoned.

## The dependency is unmet (OBSERVED — live API + source)

### Feature 1 (credential-refs UI) — no API contract exists
- Live `GET /checks` check DTO carries **no credentials field**: keys are `…auth, netConfig, steps, locations,
  tags, sourceKey, specPath, sensitive, hasRedactPatterns, redactionHealth` — nothing cred-shaped (`auth` is
  the existing HTTP request-auth, and it's `null`). (curl `synthwatch-api.azurewebsites.net/api/checks`.)
- The api repo has **no credentials concept** on any branch: `git log --all` for
  `credential|login-cred|cred-ref|CredentialRef` → nothing; no `check_credentials` table/entity/field. The
  `Check` entity has no credentials member.

### Feature 2 (auth-gated raw trace + redacted fallback) — two preconditions unmet
- **`trace_signals` is NOT a run read DTO.** `TraceSignalsDto` (`Dtos/TraceSignalsDto.cs`) exists but is used
  **only internally** — AI insights (`AiInsightsFunctions.cs:66`) + baseline/location diff
  (`LocationDiffFunctions.cs`) + `TraceExtractor`/`TraceSignalsDiff`. It is not surfaced on any run read
  endpoint. The live run DTO keys are `id, checkId, status, …, screenshotUrl, traceUrl, location, retryCount,
  sandbox` — **no `trace_signals`, no step timeline** (curl `/checks/343/runs`).
- **The runner persists NO trace for sensitive monitors today** — `runner/redact.ts:56,65`:
  `tracePersistPlan(sensitive, status)` → "A SENSITIVE monitor persists NONE of them". So `trace_url` is null
  for sensitive **by design**. The task's own precondition — *"once runner 1b populates trace_url for
  sensitive"* — is a FUTURE runner change (1b) that has not shipped.

**→ There is no contract to anchor to for either feature. Fabricating one is the false-green trap.**

## What is READY on the dashboard (so the build is small once unblocked) — OBSERVED

### Feature 1 — the pattern to mirror already exists
- Ref-only secret UI: `CheckAuth` (`types.ts`) is `{ type, token_env, password_env, header, value_env }` —
  **env-var REF NAMES only, never values**; edited via `AssertionBuilder` (the auth section: "Enter the env
  var name, not the secret", `assertion-builder.tsx:399-464`). A per-monitor credential-refs editor mirrors
  this 1:1 — roles → ref names, values are ACA secrets, never shown/entered.
- Gating: `useAuth().canWrite` (editor/admin) already gates every mutating monitor control
  (`checks/[id]/page.tsx`, monitor-form). Reuse verbatim.

### Feature 2 — the host + the gate already exist
- Host: `RunArtifacts` (`run-history.tsx:28`) renders the screenshot + `TraceViewer`; today it returns
  `null` when `run.trace_url` is null (`:36-37`) — exactly the sensitive case. This is where "trusted → raw
  trace; else → redacted summary" slots in.
- The trusted gate: `useAuth()` session — `Role = "admin" | "editor" | "anonymous"` (`auth.ts:19`). "Trusted
  / logged-in" = a valid session (role ≠ anonymous). (Note: the artifact PROXIES already require a
  session-mirrored cookie — `trace-proxy`/`screenshot-proxy` 401 without it — so an anonymous viewer already
  can't fetch the raw artifact; the UI gate makes that explicit + serves the redacted summary instead.)
- Sensitive/redaction machinery: `check.sensitive`, `redaction_health`, `RedactionBadge` all present.

## The exact contract each feature needs from Prompt 2 / runner 1b (so unblock = trivial)

### Feature 1 — API must add a per-check credential-refs field
- On `CheckSummaryDto` + `CheckDetailDto` (read) and the check write body: a `credentials` field mapping
  **cred role → env-var ref name** (ref names only; values are ACA secrets). Suggested shape (mirror
  `CheckAuth`): `credentials: [{ role: string, ref_env: string }]` (or `Record<role, ref_env>`). The API
  must **echo ref names only**, never resolve/return values (mirror the `request_headers` readback gate
  #162). Once defined, the dashboard: add the field to the `Check` type + `mapCheck`, a `CredentialRefs`
  editor mirroring the `AssertionBuilder` auth section, wired into `monitor-form` under `canWrite`.

### Feature 2 — runner 1b + an API run read-path add
1. **runner 1b:** persist a REDACTED trace (+ screenshot) for sensitive monitors → `trace_url`/`screenshot_url`
   populated (redacted) on the runs row. (Flip `tracePersistPlan` for sensitive from NONE → redacted.)
2. **API run read DTO:** surface the redacted structural summary on the run — `trace_signals`
   (`NetworkSummaryDto` + `ConsoleSummaryDto`, already defined) + the step timeline — so an untrusted viewer
   gets option-a data. Confirm whether the raw `trace_url` for a sensitive run should be gated server-side too
   (the proxy already needs a session; decide if a redacted-summary-only response is served to anonymous).
- Then the dashboard: add `trace_signals` (tolerant) to the `Run` type + `mapRun`; in `RunArtifacts`, if
  `run` is sensitive → `useAuth()` trusted → render the raw `TraceViewer`; else → render a redacted-summary
  panel (network/console summary + step timeline). Test: trusted→raw, anonymous→summary.

## Recommendation
Land **api Prompt 2** (credential-refs DTO + sensitive-trace read path) and **runner 1b** (persist redacted
sensitive traces) — or pin their exact DTO shapes here — first. The dashboard side is then a small, coherent
one-PR build (both features touch monitor-config + run-detail): mirror `CheckAuth`/`AssertionBuilder` for
creds; gate `RunArtifacts` on the session for traces. I did **not** build against a guessed contract; doing so
would ship green e2e over a prod-broken feature. Ready to build the moment the contract exists.

## Appendix — commands run
- `curl …/api/checks` → check keys (no credentials field).
- `curl …/api/checks/343/runs` → run keys `…traceUrl, location, retryCount, sandbox` (no trace_signals).
- api `git log --all` for credential/trace read DTO → none.
- `TraceSignalsDto` usages → AI-insights/diff internal only (`AiInsightsFunctions.cs:66`, `LocationDiffFunctions.cs`).
- `runner/redact.ts:56` → "A SENSITIVE monitor persists NONE of them" (trace_url null for sensitive by design).
