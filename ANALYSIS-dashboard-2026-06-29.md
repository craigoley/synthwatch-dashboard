# SynthWatch Dashboard — Deep Analysis (2026-06-29)

Reference doc. Analysis only — no code changed. Repo: `craigoley/synthwatch-dashboard` (Next.js App Router / Vercel, pure API client over the C# `synthwatch-api`). Head: `a7da478` (main).

**Method:** verified against current source with `file:line` citations, gathered by five parallel read-only agents + direct verification. Every claim tagged **OBSERVED** (read in source) or **INFERRED** (deduced from semantics). Markers from prior plans were treated as suspect and re-verified — several proved stale (see §h).

---

## (a) Executive summary — top 5, ranked

1. **No React error boundary anywhere → whole-route white-screen on any render throw.** (`find src -name error.tsx -o -name global-error.tsx` → none.) An unexpected-shape API payload reaching a component, or any mapper assumption breaking, white-screens the route with no recovery UI. Single highest-impact gap, and it compounds risk #2 (an unanchored mapper that drifts can now take down a whole page). **OBSERVED.** Fix: `app/error.tsx` + `app/global-error.tsx`.

2. **Contract harness: 13/49 seams anchored (~27%); 36 unanchored, several high-risk.** The anchored 13 cover the highest-complexity mappers, but the top unanchored seams are rich nested DTOs with no fixture: **`getIncident`** (10-field timeline + recurrence + rca + per_location), **`getMetrics`** (17-field mapper with two *fabricated* fields), **`getAvailabilitySeries`** (the `upRuns/downRuns` family that already drifted in `/sla`), and **`getSpecCatalog`'s health block** (anchored only at envelope length — the rich item mapping is effectively unanchored). This is the #1 evidence-backed backlog (§b). **OBSERVED.**

3. **F-10 silent pause/enable-toggle is OPEN, in two places.** `togglePause` is `try/finally` with **no `catch`** on both `monitors/page.tsx:128-135` and `checks/[id]/page.tsx:322-330`. A failed enable/pause (the action that silences/unsilences a monitor) shows nothing — the button just stops spinning. These are the only mutations in the app whose failure isn't surfaced. **OBSERVED.**

4. **Accessibility: run/check status is color-only in list rows.** `StatusDot` (`status-badge.tsx:36-38`) conveys pass/warn/fail purely via dot color + a hover-only `title` (invisible to screen readers and touch). The monitors list (`monitors/page.tsx:217`), specs catalog (`specs/page.tsx:101`) and report card (`monitor-report-card.tsx:112`) rely on it as the sole status cue → **WCAG 2.2 §1.4.1 (Use of Color)** violation. **OBSERVED/INFERRED.**

5. **eslint debt: 5 rules disabled, and `no-unused-vars` is fully OFF** so dead code accrues silently (3 dead exports already found: `statusRank`, `runsQuerySchema`, `activationPayload`). Worse, two of the config's own TODO justifications are now **stale** (the cited dead import and stale disable directive no longer exist) — the debt markers have drifted from reality (§d, §h). **OBSERVED.**

---

## (b) Full contract-seam inventory, ranked by drift risk

**Counts (OBSERVED):** 50 exported functions in `src/lib/api-client.ts`; minus the pure URL helper `apiUrl` (`:169`) = **49 API seams**. **13 anchored, 36 unanchored (~27% coverage).** This reconciles the plan's "37 unanchored / 13 anchored": `getSpecCatalog` is anchored only at envelope-length granularity (its rich item/`health` mapping is unasserted), so counting it as effectively-unanchored gives **12 fully anchored + 37 effectively-unanchored = 49**.

### Anchored (13)
| Seam | Def | Anchored by | Pins |
|---|---|---|---|
| `listChecks` | `:634` | `seams:51` | bare array; `openIncidentCount/p95Ms/currentStatus`→snake |
| `getIncidents` | `:957` | `seams:67` | cursor envelope `.items`→`incidents`, `nextCursor` |
| `getSla` | `:1609` | `seams:83` | `upRuns/downRuns`→snake |
| `getAvailabilityReport` | `:1465` | `seams:96` | `incidentsOpened`→`incident_count` (the F-01 drift), series `day/availabilityPct`→`date/value` |
| `getReconcileDrift` | `:1107` | `seams:150` | envelope `.items` length |
| `getSpecCatalog`* | `:1167` | `seams:150` | **length only** — item/health mapping NOT asserted |
| `getPerformanceReport` | `:1555` | `extended:40` | nested `latency`/`webVitals`, series `day/avgMs`, count fallbacks |
| `getNarrative` | `:1527` | `extended:88` | `factPack`→chips (#82) |
| `getRuns` | `:651` | `extended:106,143` | envelope→`runs`, camel→snake, `cache:"no-store"` |
| `getCheck` | `:640` | `extended:124` | rich CheckDetail, nested `recentRuns` |
| `getAiInsights` | `:757` | `ai-insights:43` | flat body (#96/#102), `note` not `message` |
| `getBaselineDiff` | `:892` | `baseline-diff:36` | A/B→this-run/baseline, verdict taxonomy (#118) |
| `setRouting` | `:1295` | `routing-write:38` | write body `{severity,perCheck,tagRules}` w/ `channelIds` (F-05) |

\* effectively partial — see HIGH #3.

### Unanchored, ranked by drift risk

**HIGH (rich nested mapping, no fixture, prior-bug-class):**
1. **`getIncident`** `:1035` — GET `/incidents/{id}`. Richest unanchored read: top-level incident + `timeline[]` (10 renamed fields `:1050-1061`) + `recurrence[]` (`:1062-1068`) + `per_location` + `rca`. No `incident_detail*.json` fixture. The sibling `getIncidents` IS anchored; this detail seam is the gap. **Named priority.**
2. **`getMetrics`** `:929` (mapper `mapMetric` `:536-557`) — envelope unwrap `.items` + **17-field** camel→snake, with **two fabricated fields**: `started_at: raw.capturedAt` (`:540`) and `status: "pass"` hardcoded (`:541`). If the API ever sends `startedAt` or renames any web-vital field, every metrics chart silently nulls. Highest field-count mapper, no fixture. **Named priority.**
3. **`getSpecCatalog` item/health mapping** `:1170-1194` — "anchored" only at `.items.length` (`seams:157`); the per-item rename (`sourceKey/specPath/suggestedIntervalSeconds`) + nested `health` (`currentStatus/p95Ms/openIncidentCount/lastRunAt`) is never asserted. Same `openIncidentCount` field family that caused the F-01 availability drift. Treat as unanchored-HIGH.
4. **`getAvailabilitySeries`** `:1631` — nested `points[]` renaming `availabilityPct/upRuns/downRuns`→snake (`:1639-1644`). Same `upRuns/downRuns` family that drifted in `/sla` (anchored); its sibling is not.
5. **`listFlows`** `:1089` (`mapFlow` `:1079-1086`) — assumes **bare array** while `/incidents`,`/runs`,`/metrics`,`/specs`,`/reconcile` are all envelopes; if `/flows` is ever wrapped → `[]` silently. Renames `entryUrlHint/updatedAt`. No fixture. **Named priority.**

**MEDIUM (real renames/fallbacks, smaller surface):**
6. `getSteps` `:666` — 8-field `mapStep`. 7. `getDeliveryReadiness` `:1436` — `transportConfigured ?? null` masks a rename as permanent "unknown" (§e). 8. `getRouting` (READ) `:1290` — renamed dimension → `{}` silently (the #66/#96 empty-wipe symptom; only the *write* is anchored). 9. `getTags` `:1336` — dual-shape tolerance, comment admits shape "unconfirmed". 10. `getCheckTags`/`setCheckTags` `:1321/:1325` — same "unconfirmed" tolerance. 11. `getLocations` `:1224` — `{locations:[]}` unwrap. 12. `getChannelTestStatus` `:1405` — renamed field degrades to `pending`/null. 13. `listEditors`/`addEditor` `:1753/:1759`. 14. `listAccessRequests` `:1774`. 15. `getCheckLocations`/`setCheckLocations` `:1230/:1236`.

**LOW (passthrough reads / writes with no response mapping):** `listChannels` `:1257`, `createChannel`/`updateChannel` `:1262/:1270`, `createCheck`/`updateCheck` `:1651/:1661` (reuse anchored `mapCheck`), `getSuggestedKeys` `:1343`, `listIncidents` `:988` (delegates to anchored `getIncidents`), `deleteChannel` `:1278`, `deleteCheck` `:1671`, `triggerReconcile` `:1129`, `runCheckNow` `:1393`, `sendChannelTest` `:1373`, `authRequestCode/authVerify/authMe/authLogout/authRequestAccess` `:1681-1721`, `removeEditor` `:1769`, `dismissAccessRequest` `:1780`.

**Recommended anchor order (capture fixture + contract test):** `getIncident` → `getMetrics` → `getSpecCatalog` health → `getAvailabilitySeries` → `listFlows`, then the MEDIUM renames. Capturing `contract/real/{incident_detail,metrics,flows,availability_series,spec_catalog}.json` is the prerequisite for 4 of the 5.

### Already-fragile mappers (silent-fallback hiding a wrong field name)
- `mapMetric` `:540-541` — `started_at`/`status` fabricated, not read from the API.
- `getDeliveryReadiness` `:1443` — `?? null` masks a rename as permanent "unknown".
- `getRouting` `:1292` — `?? {}`/`?? []` renders empty routing on a server rename (READ side of F-05).
- `getTags`/`getCheckTags` `:1318/:1335` — dual-shape tolerance never *fails* on drift; picks the wrong branch → `[]`.
- `getSpecCatalog.health` `:1186-1192` — `openIncidentCount ?? 0`, the exact F-01 field family, length-checked only.

---

## (c) Error-handling tier — F-10..F-17 status (verified against current code)

| Item | Verdict | Evidence |
|---|---|---|
| **F-10** silent pause/enable toggle | **OPEN** | `monitors/page.tsx:128-135` + `checks/[id]/page.tsx:322-330` — `try/finally`, no `catch`; failure swallowed |
| **F-11** infinite skeleton on fetch fail | **MOSTLY FIXED** (1 real residual) | list pages branch on `error` (`page.tsx:141`, `monitors:174`, `incidents:135`, `checks/[id]:315`, `users:113`). Residual: **telemetry block `checks/[id]/page.tsx:533-539`** → perpetual spinner if `useMetrics` keeps erroring (no error branch). |
| **F-12** incident-detail 404 crash | **FIXED** | `incidents/[id]/page.tsx:153-164` — invalid-id/loading/error/`!incident` guards; nested arrays `?? []` |
| **F-13** channel-test poll uncapped | **FIXED** | `notifications/page.tsx:384,407-411` — `maxPolls=30` + timeout + clear-on-unmount/re-click |
| **F-14..17 / dead exports** | **OPEN (3)** | `statusRank` `status.ts:141`, `runsQuerySchema` `schemas.ts:160`, `activationPayload` `specs.ts:53` — exported, referenced nowhere |
| empty `catch {}` swallowing | **FIXED** (all intentional, commented) | `api-client.ts:118/174/241/1715`, localStorage guards, etc. |
| mutation error surfacing | **FIXED except togglePause** | forms/dialogs/saveRouting/run-all all surface; only the 2 `togglePause` don't |

### NEW error-handling gaps (not in the F-list)
| Gap | Severity | File:line |
|---|---|---|
| **No React error boundary → white-screen on any render throw** | **HIGH** | no `app/error.tsx` / `app/global-error.tsx` |
| `togglePause` unhandled rejection ×2 (also = F-10) | MEDIUM | `monitors/page.tsx:128`; `checks/[id]/page.tsx:322` |
| Perpetual telemetry spinner on metrics error | MEDIUM | `checks/[id]/page.tsx:533` |
| Misleading error on **partial** monitor create (check created, then tags/locations fail → "failed to save" but it exists) | LOW | `monitor-form.tsx:582-593` |
| Fetch error **masked as "no data"** | LOW | `charts.tsx:208`, `sla.tsx:113`, `status/page.tsx:104` |
| `JSON.parse` on a malformed non-empty 2xx body not wrapped (would throw) | LOW (INFERRED edge) | `api-client.ts:270` |

---

## (d) ESLint-debt inventory

`eslint.config.mjs` runs flat config with `--max-warnings 0` as the gate. **5 rules disabled**, each with a TODO so debt "stays visible" — but the markers themselves have drifted (§h).

| Rule | State | Reason / what re-enabling surfaces |
|---|---|---|
| `@typescript-eslint/no-unused-vars` | **off** (`:65`) | The worst: dead code accrues invisibly. Already-found dead exports: `statusRank` (`status.ts:141`), `runsQuerySchema` (`schemas.ts:160`), `activationPayload` (`specs.ts:53`). Re-enabling would surface these + any unused imports/params. |
| `@next/next/no-img-element` | **off** (`:61`) | Deliberate `<img>` for failure-screenshot blobs from arbitrary runner hosts (`run-history.tsx:46`). Legit (next/image can't optimize arbitrary hosts) — likely stays off by design, but should be confirmed not blanket. |
| `security/detect-object-injection` | **off** (`:55`) | High-FP rule; ~30 computed-member sinks (`TONE_VAR[token]`, validated-union lookups). All internal constant-keyed, not user input. Reasonable to keep off; per-site disable would be cleaner long-term. |
| `react-hooks/set-state-in-effect` | **off** (`:73`) | Fires on default-expand-latest-run effects. NOTE: the config cites `checks/[id]/page.tsx`, but the live auto-expand setState-in-effect is now `run-history.tsx:211-216` (the `settling`/`expectRun` effects at `checks/[id]/page.tsx:276-308` also qualify). The fix the TODO suggests (derive expanded at render) is sound. |
| `security/detect-non-literal-fs-filename` | **off** for `contract/**` (`:82`) | Fixture paths are fixed literals — true FP. Correct. |
| `reportUnusedDisableDirectives` | **off** (`:42`) | Carve-out for "the stale `eslint-disable-next-line` in `checks/[id]/page.tsx`" — **but no such directive exists there anymore** (§h). The carve-out is now itself stale and can be removed. |

**Inline `eslint-disable` directives (OBSERVED):** `run-history.tsx:256` (exhaustive-deps, legit "re-arm on growth"), `api-client.ts:739` + `debug.ts:25` (no-console, gated diagnostics), and 5× `no-explicit-any` in the contract harness (`seams:32`, `ai-insights:25`, `extended-seams:21`, `routing-write:45`, `baseline-diff:22` — legit test-harness `any`). None look like hidden debt.

---

## (e) UI/UX + state/data-flow findings

### Status-color law — **COMPLIANT** (OBSERVED)
Every status→color render resolves through `TONE_VAR` → `--color-pass/warn/fail/running/idle` or `runStatusMeta`/`stepStatusToken`/`availabilityTone` in `status.ts`. No ad-hoc/hashed/hardcoded status colors. Tags are explicitly **neutral** (`tag-chips.tsx:10-20` documents removing the old hashed palette precisely to protect the law). **Minor hygiene (LOW):** `charts.tsx` series use decorative hex literals (`#45e3c2`,`#f3b13c`,`#5aa6f2`,`#5d6b77`) that *duplicate token values* — not status encodings, but brittle (esp. CLS/CPU reusing the amber `--color-warn` value coincidentally). Tokenize.

### Live-refresh / frozen-window — **FIXED** in the live surface (OBSERVED)
The frozen-`to` mechanism still exists in `useDateRange` (`date-range-control.tsx:36-40` memo deps exclude time → preset `to` captured at mount), but `run-history.tsx:188-189` neutralizes it by **omitting `to`** for live presets (server windows to its own `now()`), keeping `to` only for custom historical ranges. `monitor-report-detail.tsx:61` keeps a frozen `to` **intentionally** (stable SWR key for a non-live reporting window) — LOW/acceptable. No other frozen-window bugs found.

### Mobile / responsive — **FIXED** (OBSERVED)
`app-shell.tsx:108-152`: header is `flex-wrap` on mobile → `sm:flex-nowrap` h-14 on desktop; nav is `order-last w-full overflow-x-auto` (own scrollable row on mobile), tabs `shrink-0 whitespace-nowrap` (scroll, never clip). Email `max-w-[160px] truncate` + `title`. The "header-nav-truncation" class is resolved. **Minor (LOW):** the scrollable mobile nav has no visible scroll affordance (no fade/arrow) — discoverability only.

### A11y — **icon-buttons GOOD, status-by-color GAPS** (OBSERVED/INFERRED)
- **All icon-only buttons have `aria-label`** (`modal.tsx:48`, `toast.tsx:69`, assertion/multistep builders, etc.); decorative glyphs are `aria-hidden`. PASS.
- **MEDIUM — status color-only:** `StatusDot` (`status-badge.tsx:36-38`) uses a hover-only `title`, not an accessible name. Sole status cue in `monitors/page.tsx:217`, `specs/page.tsx:101`, `monitor-report-card.tsx:112`, and collapsed `run-history.tsx:104` rows → WCAG 1.4.1. Fix: visually-hidden text or `aria-label` on `StatusDot`.
- **LOW:** `FleetPulse` (`app-shell.tsx:52-62`) — counts categorized by dot color only ("12 8 40" to a screen reader). Window-toggle buttons (`sla.tsx`, `charts.tsx`) lack `aria-pressed` (visual active state only).

### State / data-flow (OBSERVED)
- **Cadences:** shared `live` = 15s + `revalidateOnFocus` + `keepPreviousData` (`client.ts:108-112`); run-aware fast tick `RUN_ACTIVE_POLL_MS=2500` (`:131`). `useCheck`/`useRunHistory` fast-poll while running, else 15s; `useChecks({fast})` for the run-all batch; `useReconcileDrift({reconciling})` 3s scoped. No runaway cadences.
- **`revalidateFirstPage` default = `true`** (`client.ts:246`, confirmed) — both cursor consumers (`useRunHistory`, `useIncidentHistory`) are newest-first and inherit it correctly; no consumer opts out. The thrice-hit stale-page-0 class is closed.
- **`cache:"no-store"`** forced at the fetch seam (`api-client.ts:226`) — SWR is the only cache layer.
- **Risks:**
  - **MEDIUM-HIGH — `useRunSteps` live path is unwired.** `FunnelBar` calls `useRunSteps(runId)` with no `live` arg (`funnel-bar.tsx:15`, `run-history.tsx:150`) → `refreshInterval:0`. The hook was *designed* to ride the fast cadence (`client.ts:343`) but no caller passes `live`, so an **expanded in-flight run's step checklist does not auto-advance** while the list around it does. Thread `live={runLive}`.
  - **LOW-MEDIUM — auto-expand yanks the user's row while live** (`run-history.tsx:211-216`): a new run on page 0 collapses a manually-expanded older run and jumps to the top. Intentional for the live case, but a "selection doesn't follow the user" edge.
  - **LOW — no `SWRConfig` provider / `dedupingInterval` unset** → relies on SWR's 2000ms default; the 2500ms run tick sits just above it. Works today but implicit; pin it.
  - **LOW — stale-across-navigation** for the no-poll/`revalidateOnFocus:false` hooks with no mutation owner (reports, narrative): a report viewed → navigated away → returned shows the cached snapshot until session end. Acceptable for slow aggregates, but a genuine surface.
  - **LOW — redundant force-revalidate:** `checks/[id]/page.tsx:290-292` fires `revalidateRunHistory` on every status flip atop the run-aware poll. Harmless.

---

## (f) Research — 2026 best practices for monitoring/observability dashboards (cited)

Grounding the dashboard against established SRE/observability practice. SynthWatch already does much of this well; the gaps are noted.

1. **Golden Signals as the fleet layout** — *Google SRE Book* (Beyer et al., 2016, ch. 6: latency, traffic, errors, saturation) and the request-centric **RED method** (Tom Wilkie / Weaveworks: Rate, Errors, Duration). SynthWatch's per-check view is essentially RED (availability/failure rate + latency p50/p95/p99). **Recommendation:** make the *fleet* (home/status) page lead with the golden signals in a fixed hierarchy — current failing count (errors), availability% (the SLI), p95 latency trend — top-left first, so "is anything wrong" is answerable in the NN/g "5-second" glance. `FleetPulse` is the seed of this; promote it.

2. **"Broken NOW vs historically" separation** — NN/g dashboard guidance + the SRE distinction between *current state* and *SLO/trend*. SynthWatch already separates these well (status page / fleet pulse = now; reports + SLO/burn pills = historical). **Keep this boundary sharp**; don't let trend charts creep into the at-a-glance surface.

3. **Alert legibility / fatigue** — *SRE Workbook* (2018, ch. 5: alert on SLOs, multi-window multi-burn-rate; every alert must be actionable). The **verdict badge** (`site-failure` vs `monitor-verification-bug` vs `transient`, #118) is a 2026-relevant best practice: it directly attacks false-positive fatigue by telling the operator whether the red is real. **Recommendation:** surface the verdict at the fleet level too (a "K reds, J are monitor-bugs" rollup), and consider multi-burn-rate SLO alerts (fast-burn page + slow-burn ticket) if not already in the runner.

4. **Accessibility is a 2026 baseline, not a nicety** — **WCAG 2.2 §1.4.1 (Use of Color)** and §1.4.3 (contrast). The `StatusDot`-color-only finding (§e) is a concrete violation; SRE dashboards are operated under stress and on varied displays, so status must be conveyed by **shape/text + color**, not color alone. Cheap, high-value fix.

5. **Honest time-series** — Cleveland/Tufte + Grafana guidance: render missing buckets as **gaps, not zeros** (a 0% dip reads as an outage). SynthWatch already does `connectNulls=false` (verified in the availability chart e2e). Keep it; extend the discipline to any new series.

6. **Synthetic↔trace correlation** — 2026 observability convergence (OpenTelemetry semantic conventions; synthetic + RUM + traces in one pane). SynthWatch already embeds the Playwright trace viewer for failed runs and has baseline-diff RCA — a strong differentiator. **Future direction:** link a failing synthetic run to the corresponding backend trace (if the API ever exposes a trace/correlation id), closing the "why did the synthetic fail" loop from the dashboard.

7. **Resilience of the pane itself** — an observability UI must not white-screen (you look at it *when things are broken*). Maps directly to the missing error boundary (§a #1). An error boundary that degrades a broken widget to an inline "couldn't load this panel" — rather than killing the route — is table stakes for an SRE dashboard.

---

## (g) Tech-debt ledger — ranked

| # | Item | Severity | Effort | Evidence |
|---|---|---|---|---|
| 1 | Add `app/error.tsx` + `app/global-error.tsx` (no error boundary) | HIGH | S | §a#1 |
| 2 | Anchor the HIGH unanchored seams (`getIncident`, `getMetrics`, `getSpecCatalog.health`, `getAvailabilitySeries`, `listFlows`) + capture fixtures | HIGH | M | §b |
| 3 | F-10: surface `togglePause` failures (add `catch` + toast) ×2 | MEDIUM | S | `monitors:128`, `checks/[id]:322` |
| 4 | A11y: give `StatusDot` an accessible name (visually-hidden text) | MEDIUM | S | `status-badge.tsx:36` |
| 5 | Thread `live={runLive}` into `useRunSteps`/`FunnelBar` (stale step checklist) | MEDIUM | S | `run-history.tsx:150`, `funnel-bar.tsx:15` |
| 6 | Telemetry perpetual-spinner: add `useMetrics` error branch | MEDIUM | S | `checks/[id]:533` |
| 7 | Re-enable `no-unused-vars`; delete the 3 dead exports | MEDIUM | M | §d |
| 8 | Fragile silent-fallback mappers (`getRouting` READ, `getDeliveryReadiness`, `getTags`) — anchor or harden | MEDIUM | M | §b/§e |
| 9 | Misleading partial-create error message | LOW | S | `monitor-form.tsx:582` |
| 10 | Tokenize the duplicated hex in `charts.tsx`; pin `dedupingInterval` via `SWRConfig` | LOW | S | §e |
| 11 | Mobile nav scroll affordance; window-toggle `aria-pressed`; FleetPulse per-count labels | LOW | S | §e |
| 12 | Remove the two stale eslint-config TODO carve-outs (§h) | LOW | S | §h |

---

## (h) Plan-contradiction / stale-marker notes

- **Seam count:** the plan said "37 unanchored". Verified = **36 unanchored of 49** (50 exports − `apiUrl`). Reconciles to 37 only if `getSpecCatalog` is counted unanchored (it's anchored at envelope-length only) → **12 fully anchored + 37 effectively-unanchored**. Either framing is defensible; the *substance* (the high-risk five) is unchanged.
- **eslint config TODO #1 is stale:** the comment at `eslint.config.mjs:38-40` and `:63-64` says there's "one dead import in `src/components/app-shell.tsx` (`statusRank`)" — but `app-shell.tsx` does **not** import `statusRank` (it exists only at `status.ts:141`, unused everywhere). The dead-code claim moved/changed; re-verify before acting on the comment.
- **eslint config carve-out #2 is stale:** `reportUnusedDisableDirectives: "off"` (`:42`) is justified by "the stale `eslint-disable-next-line` in `src/app/checks/[id]/page.tsx`" — grep finds **no** such directive there now. The carve-out can be removed and the option re-enabled.
- **`react-hooks/set-state-in-effect` location drift:** the TODO cites `checks/[id]/page.tsx`, but the canonical live auto-expand setState-in-effect is now `run-history.tsx:211-216` (the `checks/[id]` effects at `:276-308` still qualify too). Comment points at a moved target.
- **F-12/F-13 are FIXED** despite being on the F-list — re-verified clean (§c). Trust code over the marker list.
- **F-01 (report series drift)** was already fixed + anchored (`seams.contract.ts:120`, mapper `api-client.ts:1462`) — not re-opened here; noted for completeness since it seeded the contract-anchor discipline.

---

### Appendix — provenance
Gathered by 5 parallel read-only agents (contract harness, error-handling, eslint debt [completed manually after a transient rate-limit], UI/UX, state/data-flow) + direct verification, against `main@a7da478` on 2026-06-29. All `file:line` are as of that commit.
