# SynthWatch Dashboard — State of the Repo (2026-06-30)

Deep recon. **Read-only — nothing built, no deploy.** Five parallel agents swept a clean `origin/main` worktree (`b964129`). Every claim is `file:line`-cited, **OBSERVED** (read in source) vs **INFERRED**. Next.js App Router on Vercel, pure client over the C# API (`NEXT_PUBLIC_API_BASE_URL`), SWR data layer, auto-deploys on merge.

## TL;DR — health is good; the debt is specific

The codebase is unusually clean: **no `@ts-ignore`/`FIXME`/`HACK` anywhere**, status-color law fully upheld, big lists memoized, error boundaries + auth gate consistent. The "debt" is a short, concrete list, not rot. The five things actually worth doing:

1. **Two ungated write buttons** (Pause/Resume + Edit on check detail) — the only write affordances visible to viewers. Trivial fix.
2. **4 contract fixtures are pinned but never re-captured** — the harness's drift-detection promise silently doesn't run for `getMetrics`/`getAvailabilitySeries`/`getIncident` (the seams with *fabricated* fields). Trivial fix, high leverage.
3. **Reconcile approve/reject/apply (#146) — a destructive write path with zero e2e.**
4. **`MonitorForm` doesn't render field errors for `target_url`/`name`/`interval`** — a parse/API field error on those keys is silently dropped.
5. **Modals have no focus trap/restore** (a11y) — affects login + every create/edit modal.

---

## 1. Page → renders → API-seam map (OBSERVED, cited)

| Route | Renders (key) | API seams read | Controls |
|---|---|---|---|
| **`/`** status/home (`app/page.tsx`) | `FleetSlaSummary` (:135); `CheckCard` grid + 24h badge (:218); shared create surface (:96,133,234); `TagFilter` (:176) | `useChecks` (:74), `useSla("24h")` (:75), `useTags` (:92); `FleetSlaSummary`→`useSla`×4 | status/kind/q URL params; tag filter; "N of M" count (:185) |
| **`/monitors`** (`monitors/page.tsx`) | monitor table + Pause/Edit/Delete (:207); `RunAllControl` (:152); `RedactionFleetSummary` (:168); create surface (:162,287); **demoted** `ReconcileDriftSurface` (:280) | `useChecks({fast})` (:118), `useTags` (:119), `useReconcileDrift` (:123); surface→`useReconcilePlan`, `triggerReconcile`; `updateCheck`/`deleteCheck` | tag filter; Run-all scope = filtered set |
| **`/specs`** catalog (`specs/page.tsx`) | coverage/runnable/health table (:414); activation `MonitorForm` (:490) | `useSpecCatalog`→GET `/specs` (:435); activation→`createCheck`→POST `/checks` | view (not-set-up default)/sort/**bare-string tag filter** (`useSpecFilters` :85) |
| **`/reports`** (`reports/page.tsx`) | `NarrativeCard` (hidden when filtered, :133); scope banner (:137); `IncidentBreakdownCard` (:155); `ReportWebVitals` CWV (:159); fleet trend ×2 (:168); `MonitorReportCard` list (:238) | `useChecks`,`useSla`,`useAvailabilityReport`/`usePerformanceReport(…,selected)` (:61-62),`useTags`; embedded `useNarrative`,`useIncidentBreakdown`,(expanded)`useRuns`/`useMetrics` | window 7/30/90; tag filter (server-scoped `?tag=`); sort (incl. cert); expand |
| **`/incidents`** (`incidents/page.tsx`) | Open (unwindowed) + Resolved (cursor + date-range + load-more); `RcaPanel` inline; `TagFilter` | `useIncidentHistory`×2→GET `/incidents`; `useChecks` (tag lookup, no per-incident fetch :98); `useTags` | DateRange (30d); tag filter; load-more |
| **`/incidents/[id]`** | header+`TagChips`; `PerLocation`; `RcaPanel`; `Timeline`; `Recurrence` | `useIncident(id)`→GET `/incidents/:id`; `useCheckTags` | read-only |
| **`/checks/[id]`** | header (Run-now/Pause/Edit); `LiveStepsChecklist`; kind panels; `CheckSlaPanel`; Metrics (`AvailabilityChart`/`SloPanel`/`LatencyChart`/`MetricsCharts`); `RunHistory` | `useCheck`,`useMetrics`,`runCheckNow`,`updateCheck`; embedded `useSla`×4,`useAvailabilitySeries`,`useRunHistory`,`useRunSteps` | RunHistory date-range; availability window; Run-now |
| **`/status`** (`status/page.tsx`) | `deriveSystemStatus` banner; active incidents; `ComponentRow` list; history | `useChecks`,`useIncidents` (legacy `{open,resolved}`),`useSla`×4 | window 24h/7d/30d/90d |
| **`/notifications`** | `DeliveryBanner`; channels (routed badges, test/edit/delete); routing matrix; `FanOutPreview` | `useChannels`,`useRouting`,`useChecks`,`useTags`,`useDeliveryReadiness`; `setRouting`/`sendChannelTest`/channel CRUD | routing editors; fan-out preview |
| **`/users`** | admin-gated; add/remove editors; access requests | `useEditors`/`useAccessRequests` (admin-only); `addEditor`/`removeEditor`/`dismissAccessRequest` | admin actions |

**Full hook→endpoint table** lives in the recon (29 read hooks + the mutation seams). **Single-consumer seams** (a contract change breaks exactly one surface): `/specs`, `/reconcile/drift`, `/reconcile/plan`, all four `/reports/*`, `/editors`+`/access-requests`, `/notifications/health`, `/checks/:id/availability-series`. **★ Possible orphan:** `useFlows`→GET `/flows` has no found page consumer (INFERRED — verify; remove or wire).

---

## 2. Create-monitor shared surface — CONFIRMED one component (OBSERVED)

`src/components/create-monitor.tsx`: `useCreateMonitor()` (state + `openBlank`/`openPrefilled`/`close`, :18-38) + `<CreateMonitorModal>` (:41-64). **Both** `monitors/page.tsx` (:126,287) and `app/page.tsx` (:96,234) import and mount the *same* hook+modal — not forked. `MonitorChatInput` reused on both (not copied).

**3 entry modes seed ONE `MonitorForm`** (`monitor-form.tsx:372-374`): `prefill ? fromCheck(prefill) : activation ? formFromActivation(activation) : fromCheck(initial)` → blank-create, chat-prefill (prefill/prefillErrors), catalog activation (browser-locked, from `specs/page.tsx:496`). Not forked.

**Guardrails hold:** PREFILL-not-CREATE (`openPrefilled` only sets state; the POST is only in `MonitorForm.onSubmit` via the Create button, :592); VALIDATE-don't-trust (`getParseIntent`→`/checks/parse-intent` validates server-side, returns `valid`/`prefill`/`fieldErrors`). Ping "Reachability (TCP)" (:693), browser→redirect. Chat-input edge cases all handled — **no silent no-op** (`monitor-chat-input.tsx:26-49`).

★ **GAP (debt):** `MonitorForm` renders `fieldErrors` only for `netConfig.port` / steps / assertions (:923,943,792,859). **`target_url`, `name`, `interval_seconds`, `kind`, `timeout_ms`, cert/dns/etc. have no inline error render site** — a parse-intent or API `details` error keyed to those is silently dropped (the create-time top-level banner still shows the generic `err.message`, :638). This is the exact gap that forced #150's e2e to test via `netConfig.port`.

---

## 3. Contract harness — pinned vs unpinned (OBSERVED)

`pnpm contract` → pure-Node Playwright (`playwright.contract.config.ts`), each test stubs `globalThis.fetch` with a captured fixture and runs the **real** mapper. Fixtures captured live via `pnpm capture:contracts` (`contract/capture.mjs`). **~15–17 of ~28 read mappers pinned.**

**PINNED (14 response mappers + 2 gated POSTs + 1 request-only):** `listChecks`, `getIncidents`, `getSla`, `getAvailabilityReport` (incl. the F-01 `incidentsOpened` pin), `getReconcileDrift`, `getSpecCatalog`, `getMetrics` (incl. ★ the fabricated `started_at`/`status` derived-not-read pins), `getIncident` (timeline/recurrence), `getAvailabilitySeries`, `listFlows`, `getPerformanceReport`, `getNarrative`, `getRuns`, `getCheck` + `getAiInsights`, `getBaselineDiff` + `getIncidentBreakdown` (**request shape only**) + the `cache:"no-store"` transport pin + the `setRouting` write pin.

**UNPINNED + carries derived/fabricated fields (the drift risks):**
- `getReconcilePlan` (`:1149`) — **fabricates a whole `plan` object** when the API omits it → a rename shows an empty plan silently.
- `getDeliveryReadiness` (`:1503`) — coerces booleans + a tri-state `?? null` → a rename lies about readiness.
- `getIncidentBreakdown` **response** (`:1860`) — `precision`/`realOutages`/`pctOfTotal` all defaulted; only the *request* is pinned → a rename zeroes the alert-precision tile.
- `getParseIntent` (`:1887`), `mapStep` (`:568`), `getTags`/`getCheckTags` (dual-shape tolerant).

★ **CRITICAL harness gap (INFERRED, high-confidence):** four fixtures consumed by tests are **NOT in `capture.mjs`'s `SEAMS` list** — `metrics_check80`, `availability_series_check80`, `incident_detail_34`, and the `baseline_diff` pair. So `pnpm capture:contracts` **never refreshes them**; the README's promise ("scheduled re-capture catches API drift") silently does not hold for these seams — and they include the very mappers with fabricated fields. They're frozen point-in-time snapshots; live API drift on those would never be caught. Two gated fixtures (`ai_insights_*`, `baseline_diff_*`) are **DTO-derived hand artifacts**, not live captures (a latent F-01 risk until captured with a token).

---

## 4. Reports tiles + tag filters + P4 (OBSERVED)

- **3 tiles** all read `groups[0]`: CWV (`ReportWebVitals` — hides when no browser checks), fleet trend (`ReportSeriesArea`×2 — gated on series length), verdict-breakdown (`IncidentBreakdownCard` — `total===0`→"nothing to grade", `precision===null`→explicit "unavailable", never fake 0%).
- **All 3 are tag-aware:** hooks take `selected`→repeatable `?tag=` (`buildUrl` arrays), folded into the SWR key. A **"Scoped" banner** shows under an active filter (`reports/page.tsx:137`); the fleet narrative is **hidden** when filtered (:133). Honest-empty holds under a no-match tag.
- **Tag filters — 3 share / 1 forks:** reports, home, monitors all use the shared `{key,value}` `TagFilter`/`useTagFilter`/`matchesTags`. The **specs catalog** uses an inline bare-`string[]` variant (`useSpecFilters`, `specs/page.tsx:85`) — a **justified fork-by-necessity** (spec tags are `string[]`, not `Tag[]`), documented, mirroring-not-copying. (Two querystring codecs → minor unify candidate.)
- **★ P4 OPEN:** `groupBy` is still hardcoded `"none"` (`reports/page.tsx:61-62`) and the page reads only `groups[0]`, though api-client + mapper fully support tag-key grouping. The verdict is shown **inline as an aggregate** (precision + buckets), not link-out (this is good, not debt).

---

## 5. Error boundaries · auth gate · SWR (OBSERVED)

- **Boundaries:** `global-error.tsx` (root-layout throw) + root `error.tsx` (catches all undedicated segments) + dedicated `error.tsx` for `/reports`, `/checks/[id]`, `/incidents/[id]`. `/monitors`, `/specs`, `/`, `/incidents`, `/notifications`, `/users`, `/status` fall back to the root panel (fine). No `not-found.tsx` anywhere (minor).
- **Auth gate:** `canWrite = editor|admin` (`auth-provider.tsx:102`), re-validated via `/auth/me`. All writes gated **except** ★ **Pause/Resume + Edit on check detail** (`checks/[id]/page.tsx:414,417`) — visible to viewers (sibling Run-now *is* gated at :402). A viewer entering Edit can trigger a failing tag PUT (`monitor-form.tsx:472` auto-saves). The only write leak.
- **SWR:** idle 15s / run-active 2.5s (`RUN_ACTIVE_POLL_MS`), reconcile 3s while reconciling, reports/tags/SLA no-focus-revalidate; `revalidateFirstPage` default `true`; `cache:"no-store"` on every fetch (`api-client.ts:235`).
- **★ "no-localStorage" is CONTRADICTED:** the session token IS in `localStorage` (`auth.ts:29` key `synthwatch.session`) + in-memory mirror — a *documented, intentional* tradeoff (the cross-origin C# API needs a JS-readable Bearer token; mitigated by opaque server-revocable sessions). The "no storage" claim (`client.ts:11`) is true only for SWR/cache state. Migrate to httpOnly cookie if a same-origin API proxy ever lands (`auth.ts:15`).

---

## 6. Outstanding — prioritized (bug / debt / idea · why · effort)

**P0 — correctness / risk**
1. **[bug] Ungated Pause/Resume + Edit** (`checks/[id]/page.tsx:414,417`) — only viewer-visible write buttons; inconsistent + can fire a failing PUT. Wrap in `canWrite`. **S.**
2. **[debt] 4 fixtures not in `capture.mjs`** — drift safety net silently off for `getMetrics`/`getAvailabilitySeries`/`getIncident`/`baseline_diff` (the fabricated-field seams). Add them to `SEAMS`. **S, high leverage.**
3. **[bug] e2e for reconcile approve/reject/apply (#146)** + dry-run plan (#143) — destructive write path, zero e2e. **M.**
4. **[debt] `MonitorForm` field-error render gap** — `target_url`/`name`/`interval`/etc. errors invisible; weakens validate-don't-trust. Add inline error render for the scalar keys (or a top-level summary of unrendered keys). **M.**

**P1 — quality / a11y**
5. **[debt] Modal focus trap + restore** (`modal.tsx`) — no trap, no focus return; affects login + all create/edit/delete modals. **M.**
6. **[debt] Pin the fabricating unpinned mappers** — `getReconcilePlan`, `getDeliveryReadiness`, `getIncidentBreakdown` **response**, `getParseIntent`, `mapStep` (capture a real fixture + a contract test each). **M.**
7. **[debt] e2e gaps:** `/status` (none), `/users` (no `users.spec`, no non-admin lockout test), Pause/Resume toggle. **M.**
8. **[idea] P4 — wire the group-by control** (per-team reporting) — API+mapper already support it; UI hardcodes `"none"` + reads only `groups[0]`. **M.**

**P2 — polish / ideas**
9. **[perf] N+1 narrative fetch on `/reports`** (one `useNarrative` per `MonitorReportCard`, `monitor-report-card.tsx:192`) — not polling, but a fetch-per-row; batch endpoint or lazy-on-expand. **M.**
10. **[idea] parse-intent conversational refine** — single-shot today; add clarify-missing-field follow-up + richer redirect/field-error UX. **M.**
11. **[debt] Unify the two tag-filter codecs** (Tag[] vs string[]) behind one param-codec; extract a shared `ToggleChip` (role=checkbox pattern repeated 4×). **M, low value.**
12. **[debt] `/users` has zero responsive breakpoints**; `api-client.ts:748` eslint-disable lacks an inline reason; possible orphan `/flows` seam; replace the 2 DTO-derived gated fixtures with live captures; add `not-found.tsx`. **S each.**

**Out of scope (runner/API-owned deferrals, not dashboard debt):** reconcile apply-on-merge + browser spec-execution (the reconcile surface is report-mode + approve/reject only by design).

---

## ★ Top 3 to fix next

1. **Gate Pause/Resume + Edit on check detail (`canWrite`).** It's a genuine correctness/consistency bug (the app's only viewer-visible write buttons), a few lines, and removes a confusing failing-PUT path. Highest value-per-effort. *(`checks/[id]/page.tsx:414,417`)*
2. **Add the 4 orphaned fixtures to `capture.mjs`.** Tiny change that **restores the contract harness's core guarantee** exactly where it matters most — the seams with derived/fabricated fields (`getMetrics` `started_at`/`status`, `getAvailabilitySeries`, `getIncident`). Right now the harness gives false confidence for those. *(`contract/capture.mjs` SEAMS)*
3. **e2e for reconcile approve/reject/apply (#146).** It's a destructive monitors-as-code write path shipped with **zero end-to-end coverage** — the biggest untested-risk surface in the app. *(`reconcile-drift.tsx:288-303` ↔ `e2e/reconcile.spec.ts`)*

Close runners-up: the `MonitorForm` field-error render gap (#4) and modal focus trap (#5).

---

### Appendix — provenance
Five parallel read-only recon agents (pages→seams, create-monitor surface, contract harness, reports/tag-filters, error/auth/SWR + tech-debt sweep) over `origin/main@b964129` in an isolated worktree, 2026-06-30. Nothing built or committed.
