# Dashboard recon — 2026-07-07

Analysis-only. Branch `analysis/recon-2026-07-07` from `origin/main` @ `c3feb2b`.

**Evidence contract.** Every finding cites `file:line` or command output. **OBSERVED** = read directly
from code/fixtures on this commit. **INFERRED** = reasoned from observed facts (may be wrong if an
unstated premise fails). Each load-bearing claim names a **falsifier** and reports the result of running
it. Scope is fixed to the four questions below — no expansion.

Repo layout note: dashboard-side facts are OBSERVED and authoritative for *what the dashboard does*.
Claims about the live API's current wire shape are INFERRED from captured fixtures in `contract/real/`
(which may lag the deployed API) and are flagged as such.

---

## Q1 — PerLocationPanel consumption (plan T6.7, follow-up to api #178)

**ANSWER (ground truth): The dashboard is STILL on the buggy `runs` prop. The T6.7 follow-up is REAL and
OPEN — and it is cross-repo, not a dashboard-only in-component swap.**

### OBSERVED — the panel derives per-location status from `runs`, never `check.locations`

`src/app/checks/[id]/page.tsx:170`:
```
function PerLocationPanel({ runs }: { runs: Run[] }) {
  // Latest run per location.
  const byLoc = new Map<string, Run>();
  for (const r of runs) {
    const loc = r.location ?? "default";
    const cur = byLoc.get(loc);
    if (!cur || new Date(r.started_at) > new Date(cur.started_at)) byLoc.set(loc, r);
  }
  if (byLoc.size <= 1) return null; // single-location → no panel
  ...
```
It builds `byLoc` purely from each run's `r.location`, then derives the verdict (`page.tsx:181-198`) from
those runs. It references `check.locations` **nowhere**.

Call site — `src/app/checks/[id]/page.tsx:517`:
```
<PerLocationPanel runs={recent_runs} />
```
The prop is `recent_runs` (the recent-runs window), confirming the buggy source.

**Falsifier (run):** `grep -n "check.locations\|\.locations" src/app/checks/[id]/page.tsx` → **no hits**.
The detail page never reads a `locations` rollup. Panel source = `runs` prop. Confirmed.

### OBSERVED — why the fix is not adoptable on the detail page as-is

The api #178 fix data is the authoritative per-location status rollup `locations: [{location, status}]`.
On this commit it exists **only on the list DTO**, not on the detail the panel renders:

- `CheckDetail` is `{ check: Check; recent_runs: Run[] }` — `src/lib/types.ts:269-272`. The `check` is the
  **base `Check`**.
- Base `Check` (`src/lib/types.ts:133-197`) has **no `locations` field**. Falsifier (run):
  `sed -n '133,197p' types.ts | grep locations` → **no hits**.
- `locations: LocationStatus[]` lives on `CheckWithStatus` (`src/lib/types.ts:239`, the *list* item), which
  extends `Check`. The base does not carry it.
- The detail is mapped by `mapCheck` (`src/lib/api-client.ts:488`), which does **not** map `locations`.
  Only `mapCheckWithStatus` (`src/lib/api-client.ts:534`) sets `locations: raw.locations ?? []`
  (`api-client.ts:548`). `getCheck` uses `mapCheck`: `api-client.ts:677-680`:
  ```
  export async function getCheck(id: number): Promise<CheckDetail> {
    const raw = await request<RawCheckDetail>(`/checks/${id}`);
    return { check: mapCheck(raw), recent_runs: (raw.recentRuns ?? []).map(mapRun) };
  }
  ```
- The raw detail type `RawCheckDetail extends RawCheck` (`api-client.ts:391`) — NOT `RawCheckListItem`. The
  `locations: LocationStatus[] | null` raw field is declared only on `RawCheckListItem`
  (`api-client.ts:371`).

### OBSERVED — the live detail response does not even carry `locations` (captured fixture)

Falsifier (run): inspect the captured REAL detail response for the multi-location check (id 10):
```
$ python3 -c "…json… print('has top-level locations?', 'locations' in d)"   # check_detail_10.json
has top-level locations? False
recentRuns locations: ['centralus', 'eastus2', 'westus2']
```
`contract/real/check_detail_10.json` has **no** `locations` key; its `recentRuns` DO carry per-run
`location`. The list capture `contract/real/checks.json` carries `locations: [{location,status}]` for the
same check 10 (all three `pass`). So #178 shipped the rollup on the **list**, not the **detail**.

### The phantom-location bug — mechanism (INFERRED from the above OBSERVED facts)

`recent_runs` is a *recent window* of runs. Deriving "current locations" from it means:
1. A location **dropped from the assignment** but whose last-in-window run FAILED still renders as a live
   FAIL row (stale phantom) until its runs age out of the window.
2. A currently-assigned location that simply **hasn't run inside the window** is invisible.
Neither can happen if the panel reads the authoritative `locations` rollup (current assignment × latest
status), which is exactly what #178 added — on the list.

### VERDICT

- **Still on the buggy `runs` prop:** YES (OBSERVED, `page.tsx:170` + `:517`).
- **Follow-up real + open:** YES. But it is **not** a dashboard-only swap — the detail endpoint (`GET
  /checks/{id}`) + `mapCheck`/`RawCheckDetail`/base `Check` do not carry `locations`, and the captured
  detail response omits it. Closing T6.7 requires EITHER (a) the API detail endpoint to include the
  `locations` rollup (api #178 sibling) then plumb it through `mapCheck`, OR (b) the dashboard to
  cross-reference an existing seam — `getCheckLocations(id)` → `GET /checks/{id}/locations`
  (`api-client.ts:1344-1347`) returns the current assignment (`string[]`) and could at least *filter*
  phantom rows, though it lacks per-location status.

**Caveat.** The "detail omits locations" claim rests on one captured fixture (`check_detail_10.json`),
which may lag the deployed API. It does not change the dashboard-side verdict: even if the API now sends
`locations` on detail, `mapCheck` drops unknown raw fields, so the panel would still ignore it until the
mapper + type change. **Recommended live falsifier before implementing:** curl the deployed
`GET /api/checks/10` and check for a top-level `locations` array.

---

## Q2 — Environment surface existence (gates S1 pre-prod regression / S4 cross-env drift)

**ANSWER (ground truth): There is NO dedicated environment column / filter / grouping as a distinct
schema dimension. BUT environment is already modeled as a TAG — `env` is a first-class SUGGESTED tag key
with its own chip hue, and `env:prod` is the canonical documented tag-filter example. So S1/S4 do NOT need
a new surface from scratch: they can ride the existing tag-chip + tag-filter + tag-groupBy machinery.**

### OBSERVED — `env` is already a first-class tag key

`src/components/tag-chips.tsx:10-14`:
```
const KEY_TONE: Record<string, string> = {
  env: "var(--color-running)",
  service: "var(--color-brand)",
  team: "var(--color-warn)",
  criticality: "var(--color-fail)",
```
Comment above (`tag-chips.tsx:3-4`): "The four SUGGESTED keys carry a fixed, intentional hue… EVERY other
(arbitrary, user-defined) key is NEUTRAL." **`env` is one of the four blessed keys** — the dashboard
already recognizes environment as a tag dimension with a dedicated color.

`src/app/page.tsx:88` (the check-list / status grid): "same `?tags=env:prod` format" — `env:prod` is the
worked example the code itself uses for the tag filter. `page.tsx:174` repeats it.

Tags are a generic `{ key: string; value: string }` (`src/lib/types.ts` `interface Tag`), user-authored per
check via the monitor form (`src/components/monitor-form.tsx`, 33 `tags` refs). So `env:prod`,
`env:staging`, `env:preprod` are authorable today with zero schema change.

### OBSERVED — the shared tag machinery already spans the check-list, monitors, incidents, reports

`TagFilter` + `useTagFilter` + `matchesTags` are imported and wired in:
- `src/app/page.tsx:10,28,91` — the home **check-list / status grid** (client-side AND filter over the
  fetched checks: `page.tsx:28` `matchesTags(check.tags, tags)`).
- `src/app/monitors/page.tsx:7,127,134` — the monitors list.
- `src/app/incidents/page.tsx:10,96,105,128` — incidents (filters incidents by their check's tags).
- `src/app/reports/page.tsx:6,126` — reports, PLUS a **group-by tag KEY** control: `groupKeys` is derived
  generically from every in-use tag key (`reports/page.tsx:126`
  `[...new Set((inUseTags ?? []).map((t) => t.key))]`), and `groupBy` is **forwarded server-side** — the
  report endpoints "GROUP BY the tag key server-side (one group per tag VALUE)" (`reports/page.tsx:69-71`).

So today, with no code change: filter the fleet to `env:prod`, or **group the reports by `env`** to get one
availability/latency/incident bucket per environment value. That is the S4 cross-env comparison primitive,
already shipped generically.

### OBSERVED — two false friends to not mistake for an environment surface

1. `environment-regional` (e.g. `src/lib/types.ts:318`, `fleet-mttr.tsx:13`, `rca-panel.tsx:8`,
   `incident-breakdown-card.tsx:14`, `trust.tsx:169`) is an **incident RCA classification bucket** ("was
   this outage an environment/regional infra issue?"), NOT a deployment-environment dimension. Unrelated.
2. `process.env` / `NEXT_PUBLIC_*` are build config, not a product concept.

### OBSERVED — the one gap: the `/status` board has no tag machinery

`src/app/status/page.tsx` imports **zero** tag-filter machinery (falsifier run:
`grep -c "TagFilter|useTagFilter|matchesTags" src/app/status/page.tsx` → 0). It's a fleet-rollup system
board (`componentStatus`, `deriveSystemStatus`, `PropertyStatusSection`, `RegionHealthSection`), not a
per-check list. If S1/S4 want an environment selector *on the status board specifically*, that view lacks
the primitive and would need it added (the tag machinery is reusable, but not currently mounted there).

### VERDICT

- **New surface from scratch?** NO. Environment already rides the tag system: `env` is a first-class
  suggested key (`tag-chips.tsx:11`), `env:prod` is the canonical filter example (`page.tsx:88`), and the
  tag filter + report group-by-key work generically across the check-list, monitors, incidents, and reports.
- **For S1/S4:** extend the existing tag primitive, don't build a parallel env column. Filtering by env and
  grouping reports by env are free today. What tags do NOT give you for free (INFERRED): a *correlation*
  between the prod and staging instance of the same logical check — the tag model treats each check as
  independent, so "drift between check X@prod and check X@staging" means tagging both with a shared
  `service:` key and comparing across `env` groups, not a built-in paired-diff. And the `/status` board is
  the one view without the tag primitive mounted.

**Caveat.** "Rides the tag machinery" is OBSERVED for filter + report group-by. Whether that is *sufficient*
for the S1/S4 UX (esp. paired prod-vs-preprod drift and an env dimension on `/status`) is a design call,
not a code fact — flagged as INFERRED above.

---

## Q3 — Contract-harness unanchored-seam count (plan T1.3/T5, numbers contradicted)

**ANSWER (ground truth on `c3feb2b`): of 40 API READ seams, 19 are ANCHORED (a contract test runs the
real mapper against a captured real fixture) and 21 are UNANCHORED. Neither plan figure matches: "~16
unanchored" is stale-low; "37 unanchored / 50 total / 13 anchored" over-counts total (it folds in write
seams and/or query-variants) and under-counts anchored (predates the extended/reports-tag-filter/slo/
deploys/insight anchors). The true remaining read-seam backlog is 21, but ~8 of those reuse an
already-anchored mapper or are flat/thin — the genuinely at-risk backlog is ~7 rich/nested seams.**

### Method (how "read seam" is defined — OBSERVED)

A **read seam** = an exported `api-client` function that FETCHES and MAPS an API response into a DTO the UI
renders. That is exactly what the harness guards (mapper-vs-real-shape drift). Universe = all `GET`
functions + the two read-like insight `POST`s (`getAiInsights`, `getBaselineDiff`). **Write/mutation seams
are excluded** (create/update/delete/auth/trigger — 23 of them; they don't map a rendered DTO). Enumerated
by parsing every `export async function` + its `request()` path in `src/lib/api-client.ts` (script output
in this session). **Anchored** = the function is invoked in a `contract/*.contract.ts` test that runs it
against a `contract/real/*.json` fixture.

### OBSERVED — the 19 ANCHORED read seams (fn → contract test)

```
listChecks             seams                       getMetrics             high-risk-seams
getCheck               extended-seams              getAvailabilitySeries  high-risk-seams
getRuns                extended-seams              getSpecCatalog         high-risk-seams, seams
getIncidents           seams                       listFlows              high-risk-seams
getIncident            high-risk-seams             getReconcileDrift      seams
getSla                 seams                       getDeploys             deploys
getAvailabilityReport  seams, reports-tag-filter   getSloReport           slo-report
getPerformanceReport   extended-seams, reports-…   getAiInsights          ai-insights
getNarrative           extended-seams              getBaselineDiff        baseline-diff
getIncidentBreakdown   reports-tag-filter
```
(Non-seam contract files — `enum-coverage`, `probe-echo`, `routing-write`, `run-status-render`,
`screenshot-proxy`, `trace-proxy`, `breadcrumbs` — test behavior/derivation, not a mapper-vs-fixture seam.
`getBreadcrumbs` is a client-side derivation in `src/lib/breadcrumbs.ts`, not an API seam. `getAll` in the
reports tests is `URLSearchParams.getAll("tag")`, not an api-client call.)

### OBSERVED — the 21 UNANCHORED read seams

```
getStatus            /status                     getTrustReport       /reports/trust
getRegionHealth      /reports/region-health      getTrustDetail       /reports/trust/{id}
getMttrReport        /reports/mttr               getEgressReport      /reports/egress
getReconcilePlan     /reconcile/plan             getDeliveryReadiness /notifications/health
getSteps             /runs/{id}/steps            getChannelTestStatus /channels/{id}/test/status
listChannels         /channels                   getRouting           /routing
getCheckTags         /checks/{id}/tags           getTags              /tags
getSuggestedKeys     /tags/suggested             getLocations         /locations
getCheckLocations    /checks/{id}/locations      listIncidents        (paginated /incidents wrapper)
authMe               /auth/me                    listEditors          /editors
listAccessRequests   /access-requests
```

### Reconciling the contradicted plan numbers (INFERRED)

- **"~16 unanchored" (session-1):** stale. Anchoring has since grown to 19 and the read-seam surface to 40.
- **"37 unanchored / 50 total / 13 anchored" (July-2):** does not match a read-only universe. Best-fit
  hypothesis: it counted **reads + writes** (40 read + 23 write ≈ 63, or ~50 after collapsing auth/CRUD
  variants) and predated the `extended-seams`, `reports-tag-filter`, `slo-report`, `deploys`,
  `ai-insights`, `baseline-diff` anchors (which add ≥6 of today's 19). "13 anchored" is consistent with a
  pre-those-PRs snapshot. **Falsifier for my number:** re-run the enumeration script on `c3feb2b`
  (reproduced above) — 40/19/21 for read seams under the stated definition.

### Top UNANCHORED by drift risk (ranked; nested/rich or already-burned first)

1. **`getStatus` → `/status`** — HIGHEST. `StatusPage` is nested (`StatusProperty[]` + `StatusIncident[]`,
   `types.ts:540-558`) and it powers the flagship `/status` board — the exact surface of the #175/#177/#179
   false-green class. A shape drift here re-opens that class with no harness net.
2. **`getRegionHealth` → `/reports/region-health`** — HIGH. NEW seam (api #168 F-4 pair, shipped #192/#193).
   It is wired into `capture.mjs` SEAMS (`capture.mjs:40`) but its fixture is **not even captured yet**
   (falsifier run: `ls contract/real/reports_region_health.json` → ABSENT) and there is no contract test.
   Nested per-region rollup. Config-present, fixture-absent, unanchored.
3. **`getMttrReport` → `/reports/mttr`** — HIGH. Nested (`MttrFleet` + `MttrClassificationBucket[]` +
   `MttrCheckRow[]`, `types.ts:570-590`); classification buckets are enum-adjacent (drift class of the
   RowStatus dup). No fixture, no test.
4. **`getTrustReport` / `getTrustDetail` → `/reports/trust`** — MED-HIGH. Scored trust breakdown, nested
   factors; two endpoints, zero coverage.
5. **`getEgressReport` → `/reports/egress`** — MED. Per-IP nested series; powers the egress-stability panel.
6. **`getReconcilePlan` → `/reconcile/plan`** — MED. Nested dry-run plan; sibling of the ANCHORED
   `getReconcileDrift`, but the plan DTO is a distinct richer shape (`api-client.ts:1192`).
7. **`getSteps` → `/runs/{id}/steps`** — MED. Nested `RunStep[]` (`types.ts:274`); the multistep chain panel.

Lower risk (dedup / flat): `listIncidents` reuses the anchored `mapIncident` (its `/incidents` shape is
covered via `getIncidents`); `getTags`/`getSuggestedKeys`/`getCheckTags`/`getCheckLocations`/`getLocations`
are flat (`{key,value}` / `string[]`); `authMe`/`listEditors`/`listAccessRequests` are thin auth/admin lists.

### VERDICT

True remaining harness backlog = **21 unanchored read seams**, but the **actionable** backlog is the ~7
rich/nested ones above — led by **`getStatus`** (flagship, prior false-green class) and **`getRegionHealth`**
(new, fixture not even captured). Recommended next anchors, in order: `getStatus`, `getRegionHealth`
(capture the fixture first), `getMttrReport`, `getTrustReport`/`getTrustDetail`, `getEgressReport`.

**Caveat.** The 40/19/21 split is exact for the stated read-seam definition. Widen the definition (count
write seams, or count `getTrustReport`+`getTrustDetail` as one) and the totals shift — the *ranking* of what
to anchor next does not. Anchored ≠ "cannot drift": a fixture is a point-in-time capture; several fixtures
carry stale-snapshot risk if `capture:contracts` hasn't been re-run against live (the class `capture.mjs`
comments call out for deploys/SLO).
