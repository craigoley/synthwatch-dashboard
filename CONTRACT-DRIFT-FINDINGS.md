# SynthWatch Dashboard — Contract Drift & Code Health Audit

**Date**: 2026-06-28  
**Branch**: `claude/contract-drift-audit-xxvt6b`  
**Scope**: All 28+ read seams in `src/lib/api-client.ts` compared against captured real API responses in `contract/real/*.json`

---

## 1. Contract-Drift Table (Centerpiece)

Every client read seam in `api-client.ts`, whether it has a contract test anchoring it to a real API capture, and its drift status.

### Anchored seams (12)

| # | Seam | Endpoint | Contract Test | Real Capture | Drift Status | Notes |
|---|------|----------|---------------|--------------|-------------|-------|
| 1 | `listChecks` | GET /checks | `seams.contract.ts` | `checks.json` | **Clean** | open_incident_count, p95_ms, current_status all verified |
| 2 | `getCheck` | GET /checks/{id} | `extended-seams.contract.ts` | `check_detail_10.json` | **Clean** | camel→snake, nested recentRuns verified |
| 3 | `getRuns` | GET /checks/{id}/runs | `extended-seams.contract.ts` | `runs_check4.json` | **Clean** | cursor envelope + camel→snake verified |
| 4 | `getIncidents` | GET /incidents | `seams.contract.ts` | `incidents_open.json` | **Clean** | cursor envelope verified |
| 5 | `getSla` | GET /sla | `seams.contract.ts` | `sla_7d.json` | **Clean** | upRuns/downRuns verified |
| 6 | `getAvailabilityReport` | GET /reports/availability | `seams.contract.ts` | `reports_availability_7d.json` | **DRIFT** ⚠️ | incident_count tested ✓ — but **series** and **kind** NOT tested (see F-01, F-02) |
| 7 | `getPerformanceReport` | GET /reports/performance | `extended-seams.contract.ts` | `reports_performance_7d.json` | **DRIFT** ⚠️ | nested latency/vitals tested ✓ — but **series** and **kind** NOT tested (see F-01, F-02) |
| 8 | `getNarrative` | GET /reports/narrative | `extended-seams.contract.ts` | `narrative_fleet_7d.json` | **Clean** | factPack object→chips verified |
| 9 | `getReconcileDrift` | GET /reconcile/drift | `seams.contract.ts` | `reconcile_drift.json` | **Clean** | envelope verified |
| 10 | `getSpecCatalog` | GET /specs | `seams.contract.ts` | `specs.json` | **Clean** | envelope verified |
| 11 | `getAiInsights` | POST /runs/{id}/ai-insights | `ai-insights.contract.ts` | `ai_insights_ok.json`, `ai_insights_not_configured.json` | **Clean** | flat body + note verified |
| 12 | `getBaselineDiff` | POST /runs/{id}/baseline-diff | `baseline-diff.contract.ts` | `baseline_diff_ok.json`, `baseline_diff_not_configured.json` | **Clean** | A/B rename + insight taxonomy verified |

### Unanchored seams — no contract test (16)

| # | Seam | Endpoint | Risk | Rationale |
|---|------|----------|------|-----------|
| 13 | `getMetrics` | GET /checks/{id}/metrics | **HIGH** | Complex mapper (`mapMetric`), reads envelope `.items`, used by dashboard sparklines + detail page. No capture file exists. |
| 14 | `getIncident` | GET /incidents/{id} | **HIGH** | Complex mapper — 20+ field camel→snake, nested timeline + recurrence arrays, `perLocation`. No capture. Investigation page depends on it. |
| 15 | `getSteps` | GET /runs/{id}/steps | **MEDIUM** | Maps `RawStep` → `RunStep` with nested status/assertions. No capture. |
| 16 | `listFlows` | GET /flows | **MEDIUM** | Maps `RawFlow` → `Flow`. 4 fields, small surface. No capture. |
| 17 | `getRouting` | GET /routing | **HIGH** | The routing shape (`severity.critical.channelIds`, `perCheck`, `tagRules`) must match the API's `RoutingDto` EXACTLY — a field mismatch on PUT silently wipes all routes (the API drops unknown keys, reinserts nothing). Comment at api-client.ts:1145 explicitly warns about this. No capture. |
| 18 | `listChannels` | GET /channels | LOW | Passthrough (`Channel` type used as-is). |
| 19 | `getCheckTags` | GET /checks/{id}/tags | LOW | Tolerant wrapper (`asTags`), simple `{key,value}` shape. |
| 20 | `setCheckTags` | PUT /checks/{id}/tags | LOW | Write seam; API validates. |
| 21 | `getTags` | GET /tags | LOW | Simple `{key,value,count}` shape with wrapper tolerance. |
| 22 | `getSuggestedKeys` | GET /tags/suggested | LOW | Bare `string[]`. |
| 23 | `getLocations` | GET /locations | LOW | Reads `{name,enabled}` from `{locations:[…]}` wrapper. |
| 24 | `getCheckLocations` | GET /checks/{id}/locations | LOW | Reads bare `string[]` from `{locations:[…]}` wrapper. |
| 25 | `getAvailabilitySeries` | GET /checks/{id}/availability-series | MEDIUM | Maps `RawAvailabilityPoint` (ts/availabilityPct/upRuns/downRuns). Different from the report-level `mapSeries`. |
| 26 | `getDeliveryReadiness` | GET /routing/readiness | MEDIUM | Maps 4+ fields. FLAGGED DEP (404→null). No capture. |
| 27 | `listIncidents` | GET /incidents (aggregate) | LOW | Wraps `getIncidents` (which IS anchored). No new mapping. |
| 28 | `sendChannelTest` / `getChannelTestStatus` | POST/GET channel-test | LOW | Write + poll seam. |

**Summary**: 12 anchored, 16 unanchored. 3 HIGH-risk unanchored seams (getMetrics, getIncident, getRouting).

---

## 2. Confirmed Production Bugs (GOLD)

### F-01 — CRITICAL: Report series `day`/metric vs `date`/`value` field mismatch

**Status**: CONFIRMED production bug — trend charts on the reports page render empty/broken data.

**OBSERVED**:
- Real API (`contract/real/reports_availability_7d.json:69-106`): series points are `{ day: "2026-06-20", availabilityPct: 0, upCount: 0, downCount: 5 }`
- Real API (`contract/real/reports_performance_7d.json:101-122`): series points are `{ day: "2026-06-21", avgMs: 4590.9 }`
- Client (`api-client.ts:1352-1354`): defines `RawSeriesPoint { date: string; value: number | null }` and reads `p.date` and `p.value`
- Mock (`e2e/mock.ts:462`): serves `{ date: ..., value: ... }` — matching the client's WRONG expectation, not the real API

**HYPOTHESIS**: The client reads `p.date` (undefined, API sends `day`) and `p.value` (undefined, API sends `availabilityPct` or `avgMs`). Every mapped point becomes `{ date: undefined, value: null }`.

**PROD SYMPTOM**: Report sparkline/trend charts for both availability and performance groups display no data or render with undefined x-axis dates.

**FALSIFICATION**: Existing contract tests for availability (`seams.contract.ts:96-118`) only test `incident_count` — they do NOT test series. Performance tests (`extended-seams.contract.ts:40-66`) only test group latency + per-check name — they do NOT test series. The drift in this field is completely unguarded.

**FIX SIZE**: Small (~15 lines).
- Split `mapSeries` into `mapAvailabilitySeries` reading `{ day → date, availabilityPct → value }` and `mapPerformanceSeries` reading `{ day → date, avgMs → value }`.
- Or: single `mapSeries` that reads `day` and tries `availabilityPct ?? avgMs ?? value`.
- Update `RawSeriesPoint` interface.
- Update mock to serve `day`/metric fields.
- Add contract-test assertions for series mapping.

**EVIDENCE**: `contract/real/reports_availability_7d.json:71` has `"day"`, never `"date"`. Client at `api-client.ts:1352` declares `date: string`.

---

### F-02 — MEDIUM: Per-check `kind` field absent from both report API responses

**Status**: CONFIRMED field mismatch — `kind` is always `undefined` on report per-check rows in production.

**OBSERVED**:
- Real API availability checks (`contract/real/reports_availability_7d.json:13-67`): each check has only `checkId`, `checkName`, `availabilityPct`, `upCount`, `downCount`, `downtimeMinutes`, `incidentsOpened` — NO `kind`.
- Real API performance checks (`contract/real/reports_performance_7d.json:21-99`): each check has `checkId`, `checkName`, `latency`, `webVitals` — NO `kind`.
- Client reads `c.kind as CheckKind` at `api-client.ts:1374` (availability) and `api-client.ts:1465` (performance).
- Mock incorrectly includes `kind` at `e2e/mock.ts:475` and `e2e/mock.ts:496`.

**HYPOTHESIS**: `c.kind` resolves to `undefined`, cast `as CheckKind` doesn't throw — it silently becomes `undefined`.

**PROD SYMPTOM**: Reduced. `reports/page.tsx` merges report rows with check data from `useChecks()`, which provides `kind` from the `/checks` endpoint (which DOES serve it). The report-row `kind` is overwritten during merge, so the visible UI is unaffected. However, any consumer that trusts the report mapper's `kind` without a separate check lookup will get `undefined`.

**FALSIFICATION**: Neither contract test file asserts `kind` on per-check rows. Mock serves it → e2e tests pass; real API doesn't → prod drift.

**FIX SIZE**: Tiny. Remove the `kind` field from the report mappers' per-check output (it's not reliably available), or accept it as optional. Remove `kind` from the mock's report rows. Low priority given the merge pattern hides it.

---

### F-03 — LOW-MEDIUM: Availability group `check_count` reads wrong field

**Status**: CONFIRMED — `check_count` is always 0 on availability report groups.

**OBSERVED**:
- Real API (`contract/real/reports_availability_7d.json:4-10`): group has `totalCount: 3251` (run count), `upCount: 2369`, `downCount: 882` — NO `checkCount`.
- Client (`api-client.ts:1369`): reads `(g.checkCount as number) ?? 0` → undefined → 0.
- Performance mapper (`api-client.ts:1489`): reads `(g.checkCount as number) ?? checks.length` — has the `checks.length` fallback.
- Mock (`e2e/mock.ts:481`): serves `checkCount: rows.length` — matching the client, not the real API.

**PROD SYMPTOM**: `check_count` on availability groups is always 0. The performance mapper's `?? checks.length` fallback means its `check_count` works. No UI currently displays `check_count` prominently — it's available in the data but not rendered as a standalone value.

**FIX SIZE**: Tiny (1 line). Add `?? checks.length` fallback to availability mapper, matching the performance mapper pattern.

---

### F-04 — LOW: Performance group `browser_check_count` reads absent field

**Status**: CONFIRMED — `browser_check_count` defaults to 0.

**OBSERVED**:
- Real API (`contract/real/reports_performance_7d.json`): groups have NO `browserCheckCount` field.
- Client (`api-client.ts:1488`): reads `(g.browserCheckCount as number) ?? 0` → always 0.
- Mock (`e2e/mock.ts:506`): serves `browserCheckCount: browserCount`.
- `browser_check_count` controls whether the web-vitals card renders: `web_vitals: wv ? {...} : null` at line 1480 uses the presence of `webVitals` on the raw group, NOT `browser_check_count`. So the card DOES render correctly based on the `webVitals` field.

**PROD SYMPTOM**: Minimal. The `browser_check_count` field is 0 but isn't the gate for vitals rendering. It may affect any downstream display of "X browser checks" if shown.

**FIX SIZE**: Tiny. Could derive from `checks.filter(c => c.webVitals != null).length` as a fallback.

---

## 3. Latent Risks (not yet causing visible prod issues)

### F-05 — HIGH RISK: `getRouting` has no contract test; silent wipe on shape mismatch

The comment at `api-client.ts:1145` explicitly warns: the API drops unrecognized keys, then deletes all routes and inserts none — a **silent wipe** that reports 200. The routing shape (`severity.{critical|warning}.channelIds`, `perCheck.{checkId}.channelIds`, `tagRules`) must match exactly. Yet there is no contract test and no real capture to verify the shape.

**Risk**: If the API renames a field (e.g. `channelIds` → `channels`), the dashboard would read an empty routing, and on the next save would silently wipe all alert routes.

**Recommendation**: Capture a real `/routing` response and add a contract test. This is the highest-risk unanchored seam because failure is SILENT and DESTRUCTIVE (data loss).

### F-06 — HIGH RISK: `getMetrics` unanchored

`getMetrics` (`api-client.ts:836-839`) reads an envelope `{items: [...]}` and maps each item through `mapMetric`. This drives the dashboard's 24h sparklines and the monitor detail page's latency chart. No real capture exists. If the API changes the metric point shape, the sparklines go blank with no error.

**Recommendation**: Capture `/checks/{id}/metrics` and add a contract test.

### F-07 — HIGH RISK: `getIncident` unanchored

`getIncident` (`api-client.ts:942-977`) maps 20+ fields including nested `timeline` (array of run snapshots), `recurrence` (array of related incidents), and `perLocation` (location-level status). This is the incident investigation page's sole data source. No real capture exists.

**Recommendation**: Capture `/incidents/{id}` and add a contract test.

### F-08 — MEDIUM: Mock serves `date`/`value` for series; should serve `day`/metric

The e2e mock at `mock.ts:462` generates series as `{ date: ..., value: ... }`. This matches the client's incorrect `RawSeriesPoint` — mock and client agree on the wrong shape, so e2e tests pass. This is the exact mock-vs-real drift class described in `seams.contract.ts:17-28`. The mock should be updated when F-01 is fixed.

### F-09 — MEDIUM: Mock serves `kind` on report per-check rows; real API doesn't

Mock at `mock.ts:475` and `mock.ts:496` includes `kind` in per-check report rows. Real API doesn't serve it. Should be removed when F-02 is fixed to keep mock faithful to the real API shape.

---

## 4. Error Handling & Loading State Issues

### F-10 — MEDIUM: Silent pause errors in check toggles

When `updateCheck` fails during a pause/unpause toggle, the error is swallowed by the SWR mutate's `rollbackOnError`. The user sees the toggle revert but gets no error message explaining why.

**Location**: Used in check detail pages and the grid's quick-action toggles.  
**Fix size**: Small — surface the error in a toast/notification.

### F-11 — MEDIUM: `monitor-report-detail.tsx` doesn't check SWR error states

`monitor-report-detail.tsx` uses `useRuns`, `useMetrics`, `useIncidents` but only checks loading states, not error states. A failed fetch shows the loading skeleton indefinitely rather than an error message.

**Location**: `src/components/monitor-report-detail.tsx`  
**Fix size**: Small — add error-state checks parallel to loading checks.

### F-12 — LOW: Incident detail page missing error boundary

The incident detail page (`/incidents/[id]`) renders the investigation payload from `getIncident`. If the fetch fails (e.g. deleted incident → 404), the page crashes rather than showing "Incident not found".

### F-13 — LOW: Channel test poll doesn't cap retries

`getChannelTestStatus` polling in the alerting page has no maximum retry count. If the backend never resolves the test, the poll runs indefinitely.

---

## 5. Stale Data & Polling

### F-14 — LOW: Report window toggle doesn't trigger refetch

When switching the report window (7d → 30d → 90d), the SWR key changes and a new fetch fires — but if the previous window's data is cached, SWR serves the stale cache immediately. The `revalidateOnFocus` behavior is correct, but the transition shows a flash of stale data from the old window before the new data arrives. This is SWR-standard behavior (not a bug) but could be improved with a loading indicator during the transition.

---

## 6. Dead Code & Cleanup

### F-15 — LOW: Unused export `statusRank` in `status.ts`

`statusRank` at `src/lib/status.ts:141-155` is exported but never imported anywhere in the codebase.

### F-16 — LOW: Unused export `parseDate` in types or utils

`parseDate` is exported but has no importers.

### F-17 — LOW: Stale capture file `incidents_resolved.json`

`contract/real/incidents_resolved.json` exists but is not referenced by any contract test. It was likely from an earlier iteration of the incident contract test.

---

## 7. Top-10 Ranked Findings

| Rank | ID | Severity | Category | Summary |
|------|----|----------|----------|---------|
| 1 | F-01 | **CRITICAL** | Contract drift (PROD) | Series `day`/metric vs `date`/`value` — trend charts broken |
| 2 | F-05 | **HIGH** (latent) | Unanchored seam | `getRouting` — silent wipe risk on shape mismatch |
| 3 | F-02 | **MEDIUM** | Contract drift (PROD) | Report per-check `kind` absent — hidden by merge pattern |
| 4 | F-06 | **HIGH** (latent) | Unanchored seam | `getMetrics` — sparklines break on shape change |
| 5 | F-07 | **HIGH** (latent) | Unanchored seam | `getIncident` — investigation page, 20+ mapped fields |
| 6 | F-03 | **LOW-MED** | Contract drift (PROD) | Availability `check_count` always 0 (no fallback) |
| 7 | F-10 | **MEDIUM** | Error handling | Silent pause toggle errors |
| 8 | F-11 | **MEDIUM** | Error handling | Report detail SWR errors → infinite skeleton |
| 9 | F-08 | **MEDIUM** | Stale mock | Mock series shape doesn't match real API |
| 10 | F-04 | **LOW** | Contract drift (PROD) | `browser_check_count` always 0 (not gate for vitals) |

---

## 8. Recommendations

### Immediate (fix now)

1. **F-01**: Fix `mapSeries` to read `day` instead of `date`, and the metric-specific value field (`availabilityPct` / `avgMs`) instead of `value`. Add contract-test assertions for series mapping. Update mock.
2. **F-03**: Add `?? checks.length` fallback to availability mapper's `check_count`, matching the performance mapper pattern.

### Short-term (next sprint)

3. **F-05**: Capture a real `/routing` response and write a contract test — highest-risk unanchored seam.
4. **F-06, F-07**: Capture `/checks/{id}/metrics` and `/incidents/{id}`, add contract tests.
5. **F-02, F-09**: Remove `kind` from report mappers (or make it optional) and from mock.
6. **F-08**: Update mock series to serve `day`/metric fields.

### Backlog

7. **F-10, F-11**: Surface error states in pause toggles and report detail page.
8. **F-15, F-16, F-17**: Remove dead exports and stale capture file.

---

## Appendix: Methodology

- Compared every `Raw*` interface and mapper function in `api-client.ts` against the corresponding `contract/real/*.json` captured API response.
- For each seam, checked whether a contract test in `contract/*.contract.ts` exercises the mapping.
- Cross-referenced `e2e/mock.ts` against real captures to identify mock-vs-real divergence.
- Verified prod impact by tracing mapped values through `client.ts` hooks → component consumption.
- Falsification: for each finding, checked whether an existing test would catch the drift. In every confirmed case, the answer was no.
