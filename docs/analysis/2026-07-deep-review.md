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

