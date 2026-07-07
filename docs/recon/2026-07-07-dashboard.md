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
