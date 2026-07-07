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
