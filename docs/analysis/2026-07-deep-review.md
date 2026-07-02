# SynthWatch Dashboard — Deep Review (2026-07)

**Repo:** `craigoley/synthwatch-dashboard` · **Base:** `main @ ffc0263` · **Date:** 2026-07-02
**Scope:** docs-only analysis. No fixes applied. Local `pnpm build`/`tsc`/lint/audit only — no Vercel CLI mutations, no remote DB/API connections.
**Evidence contract:** every claim cites `file:line` at `ffc0263`. Severity is only assigned after an attempt to falsify the claim against the code (noted inline). Where behavior depends on the C# API or the runner repo (`craigoley/synthwatch`, `synthwatch-api`), it is flagged **cross-repo unverifiable here** rather than asserted.

**Recon / prior-analysis diff:** no `docs/analysis/**` exists before this document (verified: `git log --all -- 'docs/**'` is empty). The one prior analysis artifact is `CONTRACT-DRIFT-FINDINGS.md` (repo root), from the contract re-capture arc (#169); §2 diffs against it. The F-01 series-cluster bug class referenced throughout ("dashboard read `{date,value}`, API sent `{day,...}`, charts rendered empty") is the motivating precedent for §2.

---

## 1. SYSTEM MAP AS-OBSERVED

### 1.1 Architecture in one paragraph

This app has **no backend of its own**. `next.config.ts:5-7` and `src/lib/api-client.ts:6-10` state it, and grep confirms it: zero DB-driver imports anywhere in `src/**` (no `pg`/`postgres`/`prisma`/`@vercel/postgres` hits). Every read and write goes through one seam — `src/lib/api-client.ts` (2,185 lines) — to the standalone C# API at `NEXT_PUBLIC_API_BASE_URL` (`api-client.ts:163`). The only server-side code is the root layout (`src/app/layout.tsx:34`, no `"use client"`), the intentionally-inert `/throw-test` page, and two streaming trace-proxy route handlers (§1.4). Everything else is `"use client"` pages fetching via SWR hooks defined in `src/lib/client.ts`.

Consequence for caching analysis: **Next.js route caching is irrelevant to data freshness here.** The build prerenders 12 static HTML *shells* (build output: `○ (Static)` for `/`, `/incidents`, `/monitors`, `/notifications`, `/reports`, `/specs`, `/status`, `/trust`, `/users`, `/_not-found`); all data arrives client-side after hydration. No page exports `dynamic`/`revalidate`/`fetchCache` (grep: the only segment-config exports in the repo are the two trace-proxy `route.ts` files). The HTTP layer is also removed as a staleness source: `request()` forces `cache: "no-store"` on every fetch (`api-client.ts:247`), a deliberate fix for the #129 browser-cache bug. **SWR configuration is therefore the sole determinant of staleness**, and it is analyzed per-route below.

### 1.2 Route inventory

| Route | Rendering | Data fetching (all via `src/lib/api-client.ts`; hook → interval) |
|---|---|---|
| `/` | client (`src/app/page.tsx:1`) | `useChecks` 15 s + focus; `useSla("24h")` 15 s + focus; `useTags` no-poll; `FleetSlaSummary` adds `useSla` ×4 windows (`sla.tsx:65-68`), each 15 s + focus |
| `/monitors` | client | `useChecks({fast})` — **2.5 s during a "Run all" batch**, else 15 s (`monitors/page.tsx:118`); `useTags`; `useReconcileDrift` 3 s while reconciling, else 0 (`client.ts:575`) |
| `/incidents` | client | `useIncidentHistory(open)` + `(resolved, range)` — 15 s + focus, cursor-paginated (`client.ts:324`); `useChecks` 15 s; `useTags` |
| `/incidents/[id]` | client | `useIncident` 15 s + focus; `useCheckTags` no-poll |
| `/checks/[id]` | client | `useCheck` — **2.5 s while a run is live/expected, else 15 s** (`client.ts:163-165`); `useMetrics` 15 s; `useRunHistory` 2.5 s live / 15 s idle with a 6 s settle window (`checks/[id]/page.tsx:305-319`) and 90 s expectRun cap (`:293-297`); `useRunSteps` 2.5 s live / 0 terminal; `useSla` ×4; `useAvailabilitySeries` 15 s; `useDeploys` no-poll; `useTrustDetail` **no-poll, no-focus** (`client.ts:531-537`) |
| `/reports` | client | `useChecks` + `useSla(window)` 15 s + focus; `useAvailabilityReport`/`usePerformanceReport`/`useIncidentBreakdown`/`useSloReport`/`useMttrReport`/`useNarrative` — **all no-poll, no-focus** (`client.ts:478-511, 547-560`) |
| `/notifications` | client | `useChannels`/`useRouting`/`useDeliveryReadiness` no-poll; test-send polled imperatively at 2 s, 60 s timeout (`notifications/page.tsx:38-39`) |
| `/specs` | client | `useSpecCatalog` no-poll (404 → null self-hide) |
| `/status` | client | see §1.3 |
| `/trust` | client | see §1.3 |
| `/users` | client | `useEditors`/`useAccessRequests`, gated on `isAdmin`, no-poll (`client.ts:602-616`) |
| `/throw-test` | **server** (`throw-test/page.tsx` — no directive) | none; throws on `?boom=1` to exercise error boundaries |
| `/trace-proxy/[id]` | route handler, `force-dynamic`, nodejs (`route.ts:12-13`) | server→server stream of `GET {API}/runs/{id}/trace`; responds `cache-control: private, max-age=300` (`route.ts:38`) |
| `/trace-proxy/check/[id]` | route handler, `force-dynamic`, nodejs | same, upstream `GET {API}/checks/{id}/success-trace` |

Base SWR "live" config: `refreshInterval: 15_000, revalidateOnFocus: true, keepPreviousData: true` (`client.ts:129-133`); run-aware fast poll `RUN_ACTIVE_POLL_MS = 2500` (`client.ts:152-154`).

### 1.3 Freshness-sensitive surfaces: staleness as arithmetic

SWR (defaults: `refreshWhenHidden: false`) pauses interval polling while the tab is hidden and resumes on visibility; `revalidateOnFocus` additionally fires an immediate revalidation on refocus. So two numbers matter per surface: worst-case staleness **while visible** (= one poll interval + one fetch RTT) and worst-case **after refocus** (≈ RTT if focus-revalidation is on; up to one full interval if it is off; unbounded if neither exists).

**Status page (`/status`)** — `src/app/status/page.tsx:55-60` + `src/components/status-board.tsx:67-69` + `src/components/egress-stability.tsx:113`:

| Panel | Hook & config | Worst case, tab visible | Worst case, after refocus |
|---|---|---|---|
| Overall banner, components list, incidents, SLA strips | `useChecks`/`useIncidents`/`useSla` — 15 s poll, focus-revalidate ON | **15 s + RTT** | ≈ RTT (immediate) |
| "By property" rollup | `useStatus` — 15 s poll, focus-revalidate OFF (`client.ts:539-545`) | **15 s + RTT** | **up to 15 s + RTT** |
| Egress stability | `useEgress` — 60 s poll, focus-revalidate OFF (`client.ts:515-521`) | **60 s + RTT** | **up to 60 s + RTT** |

These are dashboard-added staleness only; end-to-end staleness additionally includes the runner's check interval and any API-side view refresh cadence (cross-repo, not measurable here).

**Trust / §D1 scorecard (`/trust`, and the per-check TrustCard on `/checks/[id]`)** — `useTrustReport`/`useTrustDetail` have **no `refreshInterval` and `revalidateOnFocus: false`** (`client.ts:524-537`). Arithmetic: staleness = *time since mount*. A tab left open for `t` hours shows data `t` hours old; nothing short of navigating away, switching the window toggle (new SWR key), or a hard reload refreshes it. **Worst-case staleness is unbounded.** The `client.ts:523` comment declares this intentional ("trust is a slow-moving audit view"), but the same page renders `generated_at` from data that will silently diverge from the wall clock. The D1 scorecard was called freshness-sensitive in this review's brief; as built it is the *least* fresh surface in the app.

**Reports page mixed freshness** — on `/reports`, `useChecks`/`useSla` tiles update every 15 s while `useSloReport`/`useMttrReport`/`useAvailabilityReport`/`usePerformanceReport` panels beside them are frozen at mount (no poll, no focus). Two adjacent numbers derived from the same runs can disagree by an arbitrary interval. Same unbounded-staleness arithmetic as trust applies to every report aggregate.

### 1.4 Trace-proxy handlers

Both handlers (`src/app/trace-proxy/[id]/route.ts`, `.../check/[id]/route.ts`) are narrow streaming proxies that exist to make the self-hosted Playwright trace viewer's `fetch()` same-origin (Playwright #38622; comments at `[id]/route.ts:3-11`). They validate `id` as `^\d+$` (`route.ts:19`), forward **no credentials** (`route.ts:26` — `accept` header only), map upstream failure to 404/502, and add a 5-minute *private* browser cache (`route.ts:38`). Security implications in §4.

---

## 2. TYPE BOUNDARY AUDIT

This is where the F-01 series-cluster bug lived: `mapSeries` now carries the scar tissue as a comment — "The API serves series with `day` (not `date`) and a metric-specific value field" (`api-client.ts:1532-1537`) — and a contract test proves the wrong field collapses to constant-null.

### 2.a Boundary inventory: where every type comes from

**Structure.** All typed data crosses exactly one seam: `request<T>()` at `api-client.ts:217-295`, whose return is a **blind cast** — `return (text ? JSON.parse(text) : null) as T` (`api-client.ts:291`). There is **no runtime schema validation anywhere in the repo**: grep for `.parse(`/`safeParse` over `src/**` finds only `JSON.parse` (`api-client.ts:291`, `auth.ts:49`). Every `T` is a **hand-written** `Raw*` interface (e.g. `RawCheck` `api-client.ts:308-344`, `RawRunsPage` `:381-385`, `RawSlaResponse` `:466-470`) or an untyped `Record<string, unknown>` for the newer report endpoints (`getSloReport` `:1870`, `getStatus` `:1835`, `getTrustReport` `:1802`, etc.). Each raw shape is then mapped camel→snake into the hand-written domain types of `src/lib/types.ts` by a mapper function.

**The zod schemas do not run.** `src/lib/schemas.ts` defines real schemas (`createCheckSchema:84`, `updateCheckSchema:125`, `runsQuerySchema:160`) — but every import of them is `import type ... z.infer` (`api-client.ts:99`, `client.ts:74`, `specs.ts:2`). No `.parse()` call exists. They are compile-time types wearing a runtime-validator's clothes; `runsQuerySchema` has no importer at all. Even the write inputs they were written for go out via `toCamelBody(input as Record<string, unknown>)` (`api-client.ts:1989-2006`) unparsed — validation is delegated to the API's field-keyed 400s.

**Count: 62 exported async fetch functions** in `api-client.ts` (verified: `grep -c "^export async function"` = 62). Per-function classification (full table gathered during this review; representative citations):

| Validation class | Count | What it means | Examples |
|---|---|---|---|
| **Full runtime parse** | **0** | zod/schema parse of the response | — |
| **Partial** | **41** | taxonomy allowlist and/or `Number()/String()/Boolean()` coercion and/or `?? []`-tolerant mapping | `listChecks` (REDACTION_HEALTHS allowlist `:514`), `getAiInsights` (AI_SEVERITIES `:718-724`), `getBaselineDiff` (DIFF_VERDICTS `:855-898`), `getStatus` (STATES `:1843-1846`), `getTrustReport` (TRUST_CHIPS `:1763,1797`), `getSloReport` (burnState guard `:1889`) |
| **Blind cast only** | **21** | `request<T>` result used as-is | `getSteps` `:687` (rename-only, no tolerance), `triggerReconcile` `:1176`, `listChannels` `:1331`, all five `auth*` functions `:2018-2058`, the void writes (`deleteCheck`, `removeEditor`, …) |

The blind casts cluster in write/auth endpoints with thin response shapes (`{message}`, `{requestId}`, void); **every data-rendering read seam is at least Partial — but none is Full**. Partial is precisely the property that made F-01 silent: coercion and `??` defaults convert shape drift into rendered zeros and empty arrays.

Two fetch sites exist outside the seam — the trace-proxy route handlers (`trace-proxy/[id]/route.ts:26`, `trace-proxy/check/[id]/route.ts:23`) — both stream binary zips; no JSON shape to validate. No component calls `fetch` directly.

**Contract-test coverage** (the compensating control): `contract/*.contract.ts` run the *real mapper functions* against *captured real API responses* (`contract/real/*.json`) with `fetch` stubbed (`contract/README.md`), asserting the mapped domain object against the fixture's actual field names. ~20 of 62 fetch functions are exercised (listChecks, getCheck, getRuns, getIncidents, getSla, getAvailabilityReport, getPerformanceReport, getNarrative, getReconcileDrift, getSpecCatalog, getAiInsights, getBaselineDiff, getMetrics, getIncident, getAvailabilitySeries, listFlows, setRouting write-body, getSloReport, getDeploys, getIncidentBreakdown request-shape). They run on every push/PR as the first step of the required hermetic Playwright job (`.github/workflows/e2e.yml:37-38`, gated by `ci-gate.yml`). Two structural gaps: (1) **~42 seams have no contract anchor** — including `getRouting`'s *read* (only its write body is pinned by `routing-write.contract.ts`, the F-05 silent-wipe guard), `getTrustReport`/`getTrustDetail`, `getStatus`, `getMttrReport`, `getEgressReport`; (2) captures are **frozen snapshots** — `pnpm capture:contracts` refreshes them manually (`contract/capture.mjs`), and there is **no scheduled capture workflow**, so live API-side drift is caught only when someone remembers to re-capture (last done in #169, which found no drift).

**Diff vs the prior analysis doc (`CONTRACT-DRIFT-FINDINGS.md`, 2026-06-28):** its centerpiece findings are all remediated in the current tree — F-01 fixed and test-anchored (`api-client.ts:1536-1537` + `seams.contract.ts` "teeth" test), F-02/F-03/F-04 fixed with fallbacks (`:1564`, `:1689`), F-05 mitigated (write body anchored; API now 400s malformed routing writes per `:1356-1357`; the read remains unanchored), F-06/F-07 covered by `high-risk-seams.contract.ts`, F-08/F-09 mock drift fixed (`e2e/mock.ts:583-585`). The doc cites pre-refactor line numbers throughout and should be marked superseded. Its lower-severity UX items (F-10 swallowed pause-toggle errors, F-11 report-detail ignoring SWR errors, F-12 incident 404 boundary, F-13 uncapped channel-test poll, F-14 stale-window flash) were not re-verified exhaustively here and should be treated as open.

### 2.b Silent-wrong census: boundaries that render empty/zero instead of erroring

For a monitoring product, a blank panel that *means* "API shape drifted" but *reads* "all quiet" is the worst failure mode. Three sub-classes, from the audit:

**(A) `?? []` on collection envelopes → renders as "no data".** 19 read seams do this, including every freshness-critical surface: `getRuns` `:680`, `getMetrics` `:951`, `getIncidents` `:987`, `getSla` `:1706`, `getSloReport` `:1878`, `getMttrReport` `:1919,1942,1947`, `getStatus` `:1844,1854`, `getTrustReport` `:1808`, `getTrustDetail` `:1822`, `getEgressReport` `:1748`, `getAvailabilityReport` `:1551`, `getPerformanceReport` `:1642`, `getAvailabilitySeries` `:1976`, `getDeploys` `:1721`, `getIncidentBreakdown` `:2126`. If the API renames `items`→anything, the status page shows zero properties, the SLA table empties, run history reads "no runs" — no error anywhere. (For `getReconcileDrift`/`getSpecCatalog` empty-is-meaningful is intentional and documented, `:1117-1118`.)

**(B) `?? 0` / `?? null` on required numerics → renders as zeros/dashes.** `mapSeries` `:1537` (`availabilityPct ?? avgMs ?? null` — the F-01 shape, now test-pinned but still silent by construction), `getStatus` counts `:1841-1851`, `getSloReport` budgets `:1876-1892` (a drifted `burnState` degrades to `"none"` → the burn pill shows "—" even mid-page-worthy-burn, `fleet-slo.tsx:106-108`), `getTrustReport` retry counts `:1766-1779` (unknown `trust` → `"unverified"` chip `:1797`), `getChannelTestStatus` `:1488` (unknown status reads as `"pending"` forever).

**(C) Bare `catch { return null }` → section self-hides on ANY error, not just 404.** Seven seams swallow 500s, network failures, and JSON parse errors identically to "endpoint not deployed": `getDeploys` `:1718`, `getEgressReport` `:1737`, `getTrustReport` `:1805`, `getTrustDetail` `:1816`, `getStatus` `:1838`, `getSloReport` `:1873`, `getMttrReport` `:1914`. Contrast the disciplined 404-only guards that rethrow everything else (`getReconcileDrift` `:1137-1140`, `getReconcilePlan`, `getSpecCatalog`, `getAvailabilityReport` `:1695-1698`). Concretely: if `/reports/slo` starts returning 500, the Error-budget section quietly disappears from `/reports` (`fleet-slo.tsx:136` `if (!data) return null`) — on the exact day someone most needs it. **Falsification attempt:** checked whether any component distinguishes these states — none can; `null` is the only signal the hooks receive. Assessed **Major** (silent-wrong on a monitoring surface), though it is an explicit design trade-off ("self-hide, never crash the status page", `:1731-1738`).

One more silent bound worth naming: `listIncidents` (`api-client.ts:1000-1015`) fetches resolved incidents as a **single page of 200 over a 365-day lookback with no cursor follow-through**. The comment argues incidents are sparse so 200 ≈ all; if the fleet ever exceeds 200 resolved incidents in the lookback, the status page history, the availability-chart incident overlay, and the 90d report detail silently lose the oldest ones. Not currently wrong — but it fails silently at scale, the theme of this section.

### 2.c ONE systemic fix: runtime parsing at the seam, rolled out by risk tier

Three candidates, evaluated against *this* codebase:

- **Generated types from the API** (OpenAPI → `Raw*` layer). Attacks hand-written-interface drift at the source, but (i) it is compile-time only — it cannot catch deploy skew, the case where the dashboard build predates/postdates the API deploy, which the codebase already defends against at runtime (`retryCount?` tolerance `:374`, `burn_state` defaulting `:1888`); (ii) it requires the C# repo to emit and version a spec — cross-repo coordination this review can't even read; (iii) F-01 would only have been caught *if* regeneration were enforced in CI. Weakest fit.
- **More contract tests.** The infra exists, is proven (it killed F-01–F-09), and is CI-gated. But snapshots are frozen: they verify the mapper against *yesterday's* API, and the README itself flags the staleness problem. Doubling coverage still leaves production drift invisible until re-capture. Necessary, not sufficient.
- **Runtime parsing at the boundary** — the right systemic fix here, for three codebase-specific reasons: (1) **zod 4 is already a dependency and already models this domain** (`schemas.ts`) — it is currently dead weight at runtime; (2) there is **exactly one choke point** (`request<T>` `api-client.ts:217`), so the mechanism is a one-function change: `request(path, params, init, { schema })` that `safeParse`s and throws a `ShapeDriftError` (an `ApiRequestError` sibling) on mismatch — SWR then surfaces a real error state instead of a fake empty; (3) it converts precisely the failure class this product cannot tolerate — silent-wrong — into loud-broken, at runtime, in production, on the first drifted response.

**Migration path** (incremental, no big-bang):
1. Add the optional `schema` parameter to `request()`; no call sites change behavior yet.
2. Tier 1 (the unanchored catch-all seams — highest silent risk, ~8 functions): `getStatus`, `getTrustReport`, `getTrustDetail`, `getMttrReport`, `getEgressReport`, `getSloReport`, `getDeploys`, plus the `getRouting` read (wipe-risk). Write their `Raw*` zod schemas by transcribing the existing interfaces/mappers; run in **warn mode** first (log + fall through) for a release, then strict.
3. While there, narrow the seven bare `catch { return null }` to 404-only (mechanical; the disciplined pattern already exists in-file to copy).
4. Tier 2: the contract-tested seams — reuse the same schemas *inside* the contract tests (parse the captured fixture), so snapshots and runtime guards can never disagree.
5. Tier 3: leave the thin write/auth responses blind; nothing renders from them.
6. Keep the contract suite as the pre-merge cross-repo gate and add a scheduled (weekly) `capture:contracts` workflow that opens a PR on diff — closing the staleness gap the README already documents.

This keeps the existing adapter architecture intact (schemas validate the `Raw` layer; mappers stay), costs one seam function + ~8 schemas up front, and gives the dashboard the property a monitor must have: **when its own inputs break, it says so.**

---

## 3. SLO / ANALYTICS MATH VERIFICATION

### 3.0 Where the math actually lives

Independent re-derivation starts with a scoping fact: **the dashboard computes none of the core numbers.** Burn rate, error budget, MTTR, availability percentages, and percentiles all arrive precomputed from the C# API, which in turn reads the runner repo's SQL (`sla_availability_<window>` views, `types.ts:415`; the `slo_burn_status` table, `types.ts:473-475`; runner migrations referenced by number only, e.g. `0035`/`0048` at `types.ts:118,256`). **No SQL is vendored in this repo** (glob `**/*.sql` → zero files); the shared SQL's migration source lives in `craigoley/synthwatch`, which is outside this session's repository scope — so **dashboard-assumptions-vs-SQL agreement is cross-repo unverifiable here**, and is flagged as Open Question Q1 (§7). What *can* be verified here is (a) the dashboard's stated assumptions (the `types.ts` doc comments are the de-facto contract), (b) their internal algebraic consistency, and (c) every piece of arithmetic the client does perform. That is done below. One cross-repo control does exist and passes in CI: `scripts/check-enum-coverage.mjs` parses the runner's real `db/schema.sql` `CHECK` constraints and diffs them against `types.ts` unions (`.github/workflows/enum-coverage.yml` checks out `craigoley/synthwatch` for it) — enums are drift-guarded; formulas are not.

### 3.1 Error budget & burn rate (P5) — derivation

The contract stated at `types.ts:463-478`:

```
budget        = (1 − target) × completed          // allowed down-runs
consumed      = down-runs
remaining     = budget − consumed                  // negative = blown
remaining_pct = remaining / budget                 // null when insufficient_data
burn_rate     = (down / total) / (1 − target)      // pooled, informational
burn_state    ∈ {fast, slow, none}                 // from slo_burn_status; the page verdict
reported_burn = max at-floor burn of firing window
```

**Internal consistency check (derivation):** substituting, `remaining/budget = (budget − down)/budget = 1 − down/((1−target)·completed) = 1 − burn_rate` (when `total = completed`). So the two server fields are algebraically locked: `remaining_pct ≡ 1 − burn_rate`. The client never trusts `remaining_pct`; it recomputes the fraction itself — `remainingFraction = r.remaining / r.budget` guarded by `budget <= 0 → null` (`fleet-slo.tsx:23-25`) — which is consistent with the identity and immune to a drifted `remaining_pct`. ✓

**Client-side arithmetic verified line-by-line:**
- Tone bands: blown (`remaining < 0`) → fail; `remaining/budget ≤ 0.2` → warn; else pass; `insufficient_data || budget ≤ 0` → idle (`fleet-slo.tsx:17-21`). Same thresholds duplicated in the check-detail `SloPanel` (`sla.tsx:234-243`). ✓ consistent pair.
- Bar width clamps to [0,100] (`fleet-slo.tsx:26`); a blown budget renders the word "blown", not a negative percent (`:56,93`). ✓
- Burn thresholds **are labels, not math**: "1h ≥ 14.4×" and "6h + 30m ≥ 6×" appear only in strings (`fleet-slo.tsx:103,125`); the verdict is the server's `burn_state`. 14.4× and 6× are the standard Google-SRE multi-window constants (14.4 = 30d budget · 2% consumed in 1h; 6 = 5% in 6h) — *whether the SQL actually implements those windows is Q1*.
- Division-by-zero: every division in the SLO path is guarded (`budget <= 0` at `fleet-slo.tsx:18,24`; `hasBudget = Number.isFinite(slo.budget) && slo.budget > 0` at `sla.tsx:235`). The MTTR sparkline seeds `Math.max(..., 1)` before dividing (`fleet-mttr.tsx:87`). No unguarded division exists in these files. ✓

**Findings (each falsified against code before rating):**
- **[M-1, Minor — silent-wrong class]** The fleet table's column header says **"Burn (pooled)"** (`fleet-slo.tsx:173`) but the pill in that column renders `row.reported_burn` (`fleet-slo.tsx:98`) — which `types.ts:475` defines as the *location-aware at-floor burn of the firing window*, explicitly **not** the pooled number (`types.ts:472` reserves "pooled" for `burn_rate`, which the UI no longer displays anywhere). The P5-PR2 comment (`fleet-slo.tsx:9-11`) confirms the pill was deliberately switched off the pooled value; the header wasn't. A reader doing capacity math from that column would attribute the wrong semantics to the multiplier.
- **[M-2, Minor — stale contract doc]** `types.ts:459-461` still says burn pills "stay on the check-detail SloPanel … the follow-up PR", contradicting `types.ts:473-475` and `fleet-slo.tsx:97-98` where that follow-up landed. The doc comments are the closest thing to a cross-repo contract (§3.0) — they should not disagree with themselves.
- **[M-3, Minor — drift-masking default]** A missing/unknown `burnState` degrades to `"none"` (`api-client.ts:1888-1889`) and the pill renders "—, within budget" (`fleet-slo.tsx:106-116`). Deliberate back-compat for older APIs, but it means a *renamed* field would silently display "no burn" during an actual fast burn — §2.b(B) instance.

### 3.2 MTTR — derivation

Contract (`types.ts:539-543`): MTTR = time-to-resolve over **resolved** incidents only; open incidents excluded from mean/median but surfaced as `open_count`; `mean_seconds`/`median_seconds` are `null` on insufficient data, never 0; `mttd_proxy_seconds = consecutive_failures × interval` is labeled a detection-lag **proxy**, not measured MTTD. The exclusion of open incidents biases MTTR *downward* during a long ongoing outage (the worst incident isn't in the average until it resolves) — inherent to the definition chosen, honest as documented, and visible because `open_count` is shown alongside (`fleet-mttr.tsx:48-50,163`).

Client arithmetic, verified: seconds→ms once for the formatter (`fmtDur`, `fleet-mttr.tsx:19-20`, null → "—" never "0s" ✓); classification bar `pct(b.pct_of_total)` is `Math.round(fraction × 100)` (`:21,69`) — server supplies the fraction; trend bars normalize `mean/max×100` with the `max(...,1)` zero-guard and a ≥2-bucket requirement (`:83-97`). Empty-series: `!data → null`, `total_incidents === 0` → hide-or-honest-message (`:114-124`). ✓ All guards present.

- **[M-4, Info — precision inconsistency]** MTTR percentages round to whole percent (`fleet-mttr.tsx:21`) while SLO uses 0–1 decimals (`fleet-slo.tsx:56,93`) and SLA availability uses 2 (`formatPct` default, `format.ts:95-98`). Cosmetic, but three precisions for sibling metrics on one reports page.

### 3.3 Availability & status derivation

`availability_pct` is server-computed (run-weighted views; `types.ts:437-448` explicitly says the fleet rollup "replaces the old client-side count summation"); `mapSla`/`mapFleet` pass it through with **zero arithmetic** (`api-client.ts:611-635`). The only client derivations are: tone bands at ≥99.9 pass / ≥99 warn / else fail, null/NaN → idle (`status.ts:69-74`); and the system rollup — any enabled check that is down+critical or has an open critical incident → major; any down/degraded/warning → partial; else operational (`status.ts:125-138`), with `infra_error` deliberately mapped to warn, not fail (`status.ts:21-24`). Logic verified sound; short-circuit on first critical is order-independent. ✓

- **[M-5, Minor — rounding can overstate]** `formatPct` is bare `toFixed` (`format.ts:95-98`): availability 99.996% renders **"100.00%"**, and an SLO target of 0.9999 renders **"100.0%"** via the 0-or-1-digit rule at `fleet-slo.tsx:83`. A status page that prints 100.00% while the underlying window contains failures overstates health — the inverse of this codebase's own "never a fake %" principle (`types.ts:477`). Tone banding is computed on the unrounded value (`status.ts:70-73`), so only the printed number, not the color, is affected. Falsification: checked for a floor/clamp anywhere in the format path — none exists.
- **[M-6, Info]** Timezone handling is clean by construction: SLA/SLO/MTTR windows are opaque server tokens (`"24h"|"7d"|"30d"|"90d"` — `api-client.ts:1703,1872,1913`); no `Date.now`/`toISOString` exists in any math path (grep-verified across `fleet-slo.tsx`, `fleet-mttr.tsx`, `sla.tsx`, `status.ts`). Client-clock windows exist only on cursor lists (`format.ts:18-23`, `date-range-control.tsx:22-24` — day boundaries pinned to UTC, documented). The MTTR trend labels slice the server ISO string (`fleet-mttr.tsx:95,102`), i.e. UTC calendar dates — a viewer west of UTC sees "tomorrow's" date label in the evening; display-only.

### 3.4 Verdict

The dashboard's own arithmetic is **correct and defensively guarded** — every division has a zero/insufficient-data guard, empty series degrade to honest states, and the client deliberately re-derives `remaining/budget` rather than trusting a redundant server field. The material risks are not miscalculation but **mislabeling** (M-1) and **provenance**: all load-bearing formulas live in SQL this repo can neither see nor test, with only enum drift (not formula drift) CI-guarded, and the burn thresholds existing here only as tooltip prose. A monitoring product whose math is subtly wrong is worse than no product — today the place that wrongness would enter is the unverified seam to `slo_burn_status` and the `sla_availability_*` views, not this codebase.

---

## 4. SECURITY-ADJACENT SURFACE

### 4.1 Secrets: what exists, and the bundle proof

**The Vercel bypass token is not referenced anywhere in this repo.** Case-insensitive grep for `bypass`, `x-vercel`, `VERCEL_AUTOMATION` across all source/config/workflow files returns only comments about HTTP-cache bypass and CI branch protection (`api-client.ts:243`, `auto-merge.yml:49`) — no `VERCEL_AUTOMATION_BYPASS_SECRET`, no `x-vercel-protection-bypass` header, no `vercel.json`. If a bypass token exists for this deployment, it lives in another repo (presumably the runner, to probe the protected preview) or in Vercel settings — Open Question Q3.

Complete `process.env` inventory:

| Name | Where | Exposure |
|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | `.env.example:11`, `api-client.ts:163`, both trace-proxy routes (`[id]/route.ts:15`), `next.config.ts` comment | **Client-inlined by design** (it's the public API origin, not a secret) |
| `SYNTHWATCH_API_TOKEN` | `contract/capture.mjs:80,86,110` | Dev-tooling only; never in app code; "NEVER hardcoded/committed" (`capture.mjs:77`); capture skips if unset |
| `SYNTHWATCH_API_BASE`, `SYNTHWATCH_AI_RUN_ID`, `SYNTHWATCH_BASELINE_RUN_ID`, `RUNNER_SCHEMA`, `CI` | capture/enum-coverage scripts, playwright configs | non-secret tooling config |
| `CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN` | `.github/workflows/*` via `secrets.` | CI-scoped, never in app runtime |

**Bundle proof (performed, not assumed):** after `pnpm build`, grepping the emitted client output — `grep -rhoE "NEXT_PUBLIC_[A-Z_]+" .next/static` returns exactly one name, `NEXT_PUBLIC_API_BASE_URL`; greps for `bypass`/`x-vercel-protection`/`VERCEL_AUTOMATION`/token-value patterns return zero secret hits (the only matches are the `token_env` *field name* of the check-auth config and the literal `authorization` header name in the compiled api-client). No secret names or values reach the client bundle. (Local build ran without env vars set, so the inlined base-URL value is the empty-string default — which also demonstrates `.env.example:161`'s "MUST be set in every deployed environment" footgun: a build with the var missing produces same-origin requests against an origin that has no backend.)

### 4.2 Auth architecture (the access_requests model)

Auth is **client-side UX over an API-enforced boundary**, stated explicitly at `auth.ts:12-13`, `write-gate.tsx:6-9`, `users/page.tsx:4-8`. OTP email login → `POST /auth/verify` mints an opaque bearer session (`api-client.ts:2018-2049`); roles `admin | editor | anonymous` (`auth.ts:19`); admins manage an editor allowlist plus an `access_requests` queue (`api-client.ts:2090-2119`). The token lives in **`localStorage`** (`synthwatch.session`, `auth.ts:29,71-79`) — a documented trade-off (`auth.ts:10-16`): the API is a different origin authenticating by header, so the token must be JS-readable; mitigations are opacity + server-side revocability + 30-day expiry. It is attached header-only on every request (`api-client.ts:226,249-253`), never in URLs or logs. The interceptor maps 401 → clear session + re-login prompt, 403 → permission toast without clearing (`api-client.ts:271-281`), `/auth/*` exempt. E2E coverage genuinely exercises this: token injection on writes, 401→re-login, 403→toast, enumeration-safe login and request-access copy (`e2e/auth.spec.ts:117,121-154,186-199`).

### 4.3 Route-protection coverage: the honest answer is "none, by design"

Checked: **no `middleware.ts` exists** (root or `src/`), the root layout does no gating (`layout.tsx:34-45`), and `AppShell` only hides nav chrome (`app-shell.tsx:18,128`). Therefore **every one of the 13 pages renders for anonymous visitors**; the product is read-open (it *is* a status page) and write-gated at the API. Per-route:

- All read pages (`/`, `/status`, `/incidents*`, `/checks/[id]`, `/reports`, `/trust`, `/specs`, `/monitors`, `/notifications`): no gate; write affordances hidden via `canWrite` (`write-gate.tsx:18-20`); writes 401/403 server-side.
- `/users`: renders a shell for everyone; data queries are `enabled`-gated on client `isAdmin` (`users/page.tsx:19-21,66-81`) and the API 403s non-admins on `/editors` + `/access-requests`. Client gating is UX only — acceptable *only because* the API is the boundary.
- `/throw-test`: public but inert (throws on `?boom=1` to exercise error boundaries; no data, no side effects).
- **`/trace-proxy/[id]` and `/trace-proxy/check/[id]`: unauthenticated and enumerable — the one finding that matters.** Verified by direct read: the handlers validate only `^\d+$` (`[id]/route.ts:19`), forward **no credentials** upstream (`:26` — `accept: application/zip` only), and stream the response to any caller, with `cache-control: private, max-age=300` (`:38`). Whether anonymous users can therefore download arbitrary Playwright traces (which contain full request/response bodies, console output, and screenshots of the monitored flows — including "sensitive" checks, which the redaction feature exists for) depends entirely on whether the upstream C# `GET /runs/{id}/trace` endpoint independently authenticates. The proxy's own comments say the upstream authenticates *to blob storage* via managed identity (`:25`) — that is the API's credential, not the caller's. **Rated: Major if the upstream is open; unverifiable here without probing the live API (out of scope for this docs-only run). Open Question Q2 — the single highest-priority follow-up of this review.** SSRF exposure is nil (digits-only id, fixed base).

### 4.4 Defense-in-depth gaps (report-only)

1. **No CSP / security headers anywhere** — `next.config.ts` defines no `headers()`; no `vercel.json`. The localStorage-token trade-off (§4.2) explicitly leans on XSS hygiene, and there is no header-level backstop behind it. External screenshot URLs render via plain `<img>` with no allow-list (noted in `next.config.ts:9-12` comments).
2. **Zero dashboard-layer enforcement** means any future page that renders sensitive data client-side before the API 403 lands would leak; today no such page exists (verified: `/users` gates its queries on `isAdmin` before fetching).
3. Supply-chain posture is otherwise strong: CodeQL, Semgrep, OSV (PR + scheduled), dependency-review, and eslint-plugin-security workflows all present (`.github/workflows/`), `pnpm audit` clean (§5).

