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

