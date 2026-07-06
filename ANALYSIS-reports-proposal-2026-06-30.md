# SynthWatch Reports & Insights — Gap Analysis + Build Proposal (2026-06-30)

Research + gap analysis. **Analysis only — no code changed.** Craig's framing: *"we have a lot of meaningful data we could turn into important insights and reports, but it's not all there."* This validates that instinct and turns it into a ranked backlog.

**Method:** three parallel read-only inventories across all three repos — `synthwatch` (runner, owns the schema = what's **captured**), `synthwatch-api` (= what's **exposed**), `synthwatch-dashboard` (= what's **rendered**). Every claim is `file:line`-cited, tagged **OBSERVED** (read in source) or **INFERRED**. Heads: `synthwatch@184de8b`, `synthwatch-api@1f09171`, `synthwatch-dashboard@ccdec5e`.

**The core distinction this doc draws** — for every proposed report, *which layer is the gap at?*
- **UI-gap** — data already reaches the client (type/mapper carries it); the UI just doesn't render it. **Cheapest.**
- **NEEDS-API** — runner captures/computes it, but no report endpoint exposes it. **Medium.**
- **NEEDS-CAPTURE** — needs a new rollup dimension/column (or aggregation infra) in the runner. **Real work.**

---

## Executive summary — top findings

1. **The biggest win is a UI-gap, not missing data.** The performance report's mapper already carries **group Web-Vitals (LCP/FCP/TTFB/CLS p75), the daily `series`, `avg_ms`, and group-level breakdowns** (`api-client.ts:1588-1595, 1587`), but the reports page reads the perf report **only** as a per-check p50/p95/p99 source (`reports/page.tsx:61, 83-85`) — the vitals, the series, and all grouping are mapped-then-dropped. Rendering what we already fetch is the highest value-per-effort.
2. **CWV is captured, rolled up at p75, and is the field-standard report — but absent from the reports surface.** `daily_check_rollup` stores per-day LCP/FCP/TTFB/CLS p75 (`schema.sql:773-782`); the API exposes group p75 (`ReportDtos.cs:49-54`); the reports page renders **none of it** (only point-in-time LCP/FCP/TTFB/CLS tiles in the per-monitor drill-down, `monitor-report-detail.tsx:83-97`). **INP** — now a Core Web Vital — is captured (`schema.sql:322`) but dropped at every aggregation layer.
3. **SLO / error-budget / burn-rate is fully computed but only on check-detail.** `slo_status()` returns budget/consumed/remaining/burn_rate with Google-SRE multi-window fast/slow-burn (`ChecksFunctions.cs:147-182`), rendered in `SloPanel` on check-detail only (`sla.tsx:233-291`). There is **no fleet/group SLO report and no error-budget burn-down series** — the single most-standard SRE report is missing at the report layer.
4. **MTTR/MTTD/verdict-breakdown: the data exists, the aggregation doesn't.** Incident `opened_at`/`resolved_at` + per-incident `durationSeconds` (`IncidentsFunctions.cs:165`) + the RCA `classification` taxonomy (`IncidentRca.cs:14`) are all captured — but no endpoint computes a mean or a count-by-classification. *"How many reds were real vs monitor-bug vs transient"* is one `GROUP BY` away and is the highest-signal alert-quality report.
5. **Per-location and resource/page-weight reporting are genuine deeper work** — the rollup flattens across locations (`schema.sql:751`) and omits the resource metrics, so those need a new capture dimension, not just a render.

**Cheap-wins-first ordering:** §(e) leads with the UI-gaps (#1–#4 below are 3 of them), then the NEEDS-API reports, then §(f) the NEEDS-CAPTURE ones.

---

## (a) DATA WE CAPTURE — inventory (runner schema, cited)

Source of truth: `synthwatch/db/schema.sql`. The reporting keystone is **`daily_check_rollup`** — a nightly precompute that most report endpoints read.

**`runs`** (`schema.sql:214-264`): `status` (pass/warn/fail/error/infra_error/running, :225), `duration_ms` (:229), `http_status` (:230), `failed_step` (:232), `trace_signals` JSONB (network waterfall + console errors, :240), `spec_provenance` JSONB (executed SHA/origin, :244), **`cert_days_remaining`** (:251), **`retry_count`** (:256, mig 0048), **`location`** (:260). Index `(check_id, started_at DESC)` (:268).

**`run_metrics`** (1:1 per browser run, `schema.sql:295-325`) — the full CWV + resource set: `ttfb_ms`(:301), `dom_content_loaded_ms`(:302), `load_event_ms`(:303), `fcp_ms`(:304), `lcp_ms`(:305), `transfer_bytes`(:308), `resource_count`(:309), `dom_node_count`(:310), `js_heap_bytes`(:313), `cpu_time_ms`(:314), `layout_count`(:315), `recalc_style_count`(:316), **`cls`**(:318), **`inp_ms`**(:322), `captured_at`(:324).

**`incidents`** (`schema.sql:330-350`): `opened_at`(:335), `resolved_at`(:336), `severity`(:334), `consecutive_failures`(:339), `opened_run_id`/`resolved_run_id`(:337-338), `rca` JSONB = `{classification, confidence, signature, observed[], inferred[]}` (:341, mig 0015 — the verdict taxonomy + recurrence signature live here).

**`daily_check_rollup`** (★ reporting keystone, `schema.sql:758-787`, mig 0028): per check/day — `availability_pct`, duration `p50/p95/p99/min/max/avg`, **`lcp/fcp/ttfb avg+p75`**, **`cls avg+p75`**, `load_event_avg`, `transfer_bytes_avg`, `incidents_opened`, `downtime_minutes`. **Drops** `inp_ms`, `resource_count`, `dom_node_count`, `js_heap_bytes`, `cpu_time_ms`, `layout_count`, `recalc_style_count`, `dom_content_loaded_ms` (OBSERVED — these are captured per-run but never rolled up).

**SLO/burn:** no SLO table — `checks.slo_target` (:126) + `slo_status(check_id, from, to)` function returning `budget/consumed/remaining/remaining_pct/burn_rate` (`schema.sql:817-871`). **SLA views** `sla_availability_{24h,7d,30d,90d}` (:735-747).

**Locations/quorum:** `locations` registry (:204), `check_locations` per-(check,location) cursor (:173), `runs.location` per-run vantage (:260), `checks.min_fail_locations` quorum threshold (:63) — quorum verdict is **computed, not stored** (INFERRED).

**`runner_errors`** (mig 0050, `schema.sql:881-891`): `invocation_id`, `phase` (main/uncaughtException/unhandledRejection), `check_id`, `run_id`, `message`, `stack`, `occurred_at` — runner-side fatals, brand-new, visibility-only.

**`reconcile_drift`** (`schema.sql:525-532`): `drift_type` incl. **`redaction_mismatch`** (mig 0049 — the B10 leak-shape audit trail).

**Other report-relevant:** `run_steps` (per-step funnel durations + failure point, :274), `check_tags` (per-team scoping, :187), `maintenance_windows` (SLA/SLO exclusion, :371), `report_narratives` (precomputed AI narrative, :796), `audit_log` (mutation history, :627).

**★ Rich-but-underused (captured, strong report candidates):** full `run_metrics` beyond LCP/FCP/TTFB (esp. INP + resource/CPU/DOM/heap), `trace_signals`, incident `rca` taxonomy, per-`location` timing, `retry_count` patterns, `cert_days_remaining`, `runner_errors`, `redaction_mismatch` drift.

---

## (b) REPORTS WE SURFACE TODAY — inventory (API + UI, cited)

### API report endpoints (`synthwatch-api`)
- **`GET /reports/availability`** (`ReportsFunctions.cs:36-92`) — from `daily_check_rollup`; grouped by tag key + per-check; windows **7d/30d/90d (no 24h)**. Returns group `{availabilityPct, upCount, downCount, totalCount, downtimeMinutes, incidentsOpened, checks[], series[]}`; **series is daily, availability-only** `{day, availabilityPct, upCount, downCount}` (`ReportDtos.cs:9-38`).
- **`GET /reports/performance`** (`ReportsFunctions.cs:95-207`) — latency `{sampleCount, avgMs, p50/p95/p99}` (no p90/min/max); web-vitals **`{lcpP75, fcpP75, ttfbP75, clsP75}` — NO INP, no DCL/load-event** (`ReportDtos.cs:48-54`); **no resource metrics**; **series is daily `avgMs` ONLY** (`ReportDtos.cs:56-58`) — no vitals-over-time, no percentile series.
- **`GET /sla`** (`SlaFunctions.cs:22-59`) — per-check + fleet availability across 24h/7d/30d/90d; insufficient-data gating (<20 runs / <80% coverage → null). No tag-group, **no per-location**.
- **`GET /checks/{id}/availability-series`** (`ChecksFunctions.cs:423-494`) — single-check availability buckets (24h→hour, 7d→6h, else day); availability only.
- **`GET /reports/narrative`** (`ReportsFunctions.cs:231-265`) — read-only AI narrative from `report_narratives` (fleet/monitor scope); `factPack` re-emitted verbatim.
- **SLO/burn** — **only embedded on `GET /checks/{id}`** as `SloDto {target, budget, consumed, remaining, burnRate, fastBurn, slowBurn}` (`ChecksFunctions.cs:147-182`). **Not a report.**

### Reports UI (`synthwatch-dashboard`, `/reports`)
`reports/page.tsx`: window toggle **7d/30d/90d** (default 7d); **group-by is hardcoded `"none"`** (`page.tsx:53-54`) — the grouping machinery exists end-to-end but the UI never exercises it; fleet **NarrativeCard**; tag filter; sort (avail/p95/incidents/name); a list of **`MonitorReportCard`** (per-check).
- **MonitorReportCard** (`monitor-report-card.tsx`): availability %, uptime bar, **p50/p95/p99**, incident count, run count, sparkline, narrative.
- **MonitorReportDetail** (`monitor-report-detail.tsx`): AvailabilityChart + LatencyChart; **Web-vitals "latest" tiles LCP/FCP/TTFB/CLS** (point-in-time, browser-only, **INP omitted** :27-28); recent errors; incidents (link out to RCA).
- **Charts** (`charts.tsx`): LatencyChart plots **raw run `duration_ms`** (not the rollup series); AvailabilityChart uses its own `availability-series` endpoint. **`MetricsCharts`/`CoreWebVitals` (incl. INP + the over-time vitals/resource trends) render ONLY on check-detail** (`charts.tsx:344-461`), never on reports.
- **SLA/SLO/burn** (`sla.tsx`): `CheckSlaPanel` + `SloPanel` (error-budget gauge, burn rate, fast/slow-burn pills) render **only on check-detail** (`checks/[id]/page.tsx:491, 527`). The reports page consumes `useSla` purely as a numeric availability source.

---

## (c) THE GAP — captured-but-unreported (with the gap layer)

| Rich data (captured, cited) | On a report today? | Gap layer |
|---|---|---|
| Perf report group **Web-Vitals p75** (LCP/FCP/TTFB/CLS) | No — mapped (`api-client.ts:1588`) but UI reads only per-check latency | **UI-gap** |
| Perf/avail report **daily `series`** | No — mapped (`:1485,1587`) but no component reads `.series` (charts use raw runs / a separate endpoint) | **UI-gap** |
| **Tag-group / grouped breakdown** | No — UI hardcodes `groupBy="none"` (`page.tsx:53`); API + mapper support it | **UI-gap** |
| Per-check/group **`avg_ms`** | No — mapped, card shows p50/p95/p99 only | **UI-gap** |
| **`cert_days_remaining`** runway | No — `last_cert_days_remaining` is on the live check the page already holds (`page.tsx:51`); dropped from `ReportRow` | **UI-gap** |
| Incident **verdict/RCA** inline on reports | No — reports links out; verdict renders only on incident detail | **UI-gap** (data 1 fetch away) |
| **CWV trend over time** (p75 daily) | No | **NEEDS-API** (rollup has daily p75; series exposes only `avgMs`) |
| **SLO / error-budget / burn** fleet report | No (check-detail only) | **NEEDS-API** (compute exists; no fleet endpoint/series) |
| **MTTR / MTTD** | No — `durationSeconds` even dropped at the mapper (`getIncident` omits it) | **NEEDS-API** (+ remap) |
| **Verdict-taxonomy breakdown** (real/monitor-bug/transient counts) | No | **NEEDS-API** (`rca.classification` captured; never counted) |
| **Flakiness / passes-only-on-retry** | No | **NEEDS-API** (`retry_count` captured; never aggregated) |
| **INP** (now a Core Web Vital) | No (omitted everywhere on reports) | **NEEDS-CAPTURE** (rollup drops it) + API + UI |
| **Per-location** latency/availability comparison | No | **NEEDS-CAPTURE** (rollup flattens location, `schema.sql:751`) |
| **Resource/page-weight** (transfer/cpu/dom/heap) regression | No (check-detail only, raw) | **NEEDS-CAPTURE** (rollup omits) + API + UI |
| **Runner-health** (runner_errors) | No | **NEEDS-API** (new endpoint) + UI |
| **Trace-signals** fleet (top offending 3rd-party resources) | No | **NEEDS-API** (JSONB aggregation + index) + UI |

---

## (d) RESEARCH — field-standard reports, and do we have the data? (cited)

1. **SLO error-budget / burn-rate** — *Google SRE Workbook* ch.4 (SLOs) + ch.5 (Alerting on SLOs: multi-window multi-burn-rate; the canonical fast-burn 1h@14.4× page + slow-burn 6h@6× ticket). **We have it and it's SRE-canonical:** `slo_status()` computes budget/burn and the API already emits `fastBurn`/`slowBurn` at exactly the Google windows (`ChecksFunctions.cs:147-182`). Gap is purely a *fleet report + budget burn-down series* (NEEDS-API). This is the #1 report SREs expect and we're closest to it.

2. **Core Web Vitals trend (p75)** — *web.dev / Google CWV* (2026 thresholds: LCP ≤2.5s good/≤4s NI; CLS ≤0.1/≤0.25; **INP ≤200ms/≤500ms — INP replaced FID in March 2024**; field CWV reported at **p75**). **We capture the full set and roll up at p75** (`schema.sql:773-782`) — matching Google's p75 methodology. Two gaps: (a) the p75 vitals are **never rendered on reports** (UI-gap), (b) **INP is dropped at every aggregation** (NEEDS-CAPTURE) — and INP being a Core Web Vital makes its omission a real correctness gap, not a nicety.

3. **MTTR / MTTD + alert precision** — *DORA / Accelerate* (MTTR is a core stability metric) + *SRE Workbook* on alert quality (precision = real-incident rate). **We have the data:** incident `opened_at`/`resolved_at`, per-incident `durationSeconds` (`IncidentsFunctions.cs:165`), and the `rca.classification` taxonomy {real-outage, flaky-transient, selector-drift, environment-regional, perf-regression} (`IncidentRca.cs:14`). The **verdict breakdown** directly answers Craig's "how many reds were real vs monitor-bugs" — it's the alert-precision metric, and it's a single `GROUP BY classification`. NEEDS-API only.

4. **Per-region comparison** — multi-region synthetic-monitoring best practice (regional performance divergence, geo-availability; relevant now that the 3-region quorum exists). **We capture per-run `location`** but the rollup flattens it (`schema.sql:751`) — so this needs a location rollup dimension or a raw-run query (NEEDS-CAPTURE/heavier NEEDS-API). High value, real work.

5. **Flakiness / reliability** — test-flakiness + DORA reliability literature; "passes-only-on-retry" as a *leading* degradation indicator. **We capture `retry_count`** (`schema.sql:256`, mig 0048 was built precisely for the `status=pass AND retry_count>1` "degrading-but-green" case) but never aggregate it. A per-check flakiness/retry-rate report is directly backed. NEEDS-API.

6. **Availability/uptime SLA done honestly** — gaps-not-zeros (Tufte/Cleveland; a 0% bucket reads as an outage). **Already done well** — `availability-series` returns null for empty buckets (`ChecksFunctions.cs`) and the chart renders gaps. Keep this discipline in every new series report.

7. **Dashboard legibility** — NN/g (information hierarchy, the 5-second "is it broken" glance) + the "broken-now vs historically" split. The reports surface should stay *historical/trend*; current-state stays on status/fleet. New reports should lead with the at-a-glance signal (budget remaining %, CWV pass/fail, MTTR) then drill down.

---

## (e) ★ THE RANKED PROPOSAL — cheap wins first

### Tier 1 — UI-gaps (we already fetch the data; just render it). Highest value-per-effort.

**P1. Core Web Vitals card + trend on the reports page.**
- *Value:* CWV is the field-standard performance report; today it's only point-in-time tiles in a drill-down. Operators can't see "is LCP regressing fleet-wide."
- *Data:* group p75 `web_vitals` **already mapped** (`api-client.ts:1588-1595`); the per-day p75 trend exists in the rollup. **UI-gap** for the card (render the mapped p75 with good/NI/poor thresholds); **NEEDS-API** only for the *over-time* series (expose the rollup's daily vitals — small query change, since `/reports/performance` already reads the rollup for `avgMs`).
- *Shape:* a CWV card per check (and group) — LCP/CLS/INP/FCP/TTFB p75 with threshold coloring; a vitals trend line. Reuse the existing `CoreWebVitals`/`MultiLineChart` from check-detail (`charts.tsx:344-461`).

**P2. Use the report `series` for the reports trends (stop using raw runs / a second endpoint).**
- *Value:* the latency "trend" on reports is currently raw `duration_ms` and availability comes from a *separate* endpoint — inconsistent with the windowed rollup the rest of the card shows.
- *Data:* daily `series` **already mapped** (`api-client.ts:1485, 1587`), unused. **UI-gap.**
- *Shape:* point the reports LatencyChart/AvailabilityChart at the report `series`.

**P3. Cert-expiry runway column/sort on reports.**
- *Value:* "which SSL monitors expire in <N days" is a recurring operator question; cert expiry is a silent time-bomb.
- *Data:* `last_cert_days_remaining` **already on the live check the reports page holds** (`page.tsx:51`), dropped from `ReportRow`. **Pure UI-gap.**
- *Shape:* a cert-days column + an "expiring soon" sort/badge; trivial.

**P4. Wire the existing group-by control + inline incident verdict.**
- *Value:* per-team/tag reporting (group-by) and seeing *why* an incident fired without leaving reports.
- *Data:* group-by is supported API→mapper, **UI hardcodes `none`** (`page.tsx:53`); RCA verdict is one fetch from the drill-down. **UI-gap.**
- *Shape:* surface the tag group-by toggle; render verdict/cause/confidence inline in the drill-down.

### Tier 2 — NEEDS-API (captured/computed; needs an aggregate endpoint + UI). Medium effort, high value.

**P5. Fleet SLO / error-budget report.** *The #1 SRE report.* `slo_status()` already computes per-check budget/burn (`ChecksFunctions.cs:147-182`); add a `GET /reports/slo` that runs it across checks → a fleet table (target, budget remaining %, burn rate, fast/slow-burn) + an **error-budget burn-down series** computed from the rollup's daily up/down counts. UI: an SLO report section (budget gauges + burn-down). NEEDS-API + UI.

**P6. Incident analytics: MTTR / MTTD / verdict breakdown / frequency.** All data captured (opened/resolved/`durationSeconds`/`rca.classification`). Add `GET /reports/incidents` → mean-time-to-resolve, mean-time-to-detect (opened_at − first-failing-run), incident frequency over time, recurrence-by-signature, and **★ the verdict-taxonomy breakdown** (count by classification = alert precision, Craig's "real vs monitor-bug vs transient"). Also fix the mapper drop of `durationSeconds` in `getIncident`. NEEDS-API + UI.

**P7. Flakiness / passes-only-on-retry report.** `retry_count` captured; add aggregation (per check: % runs needing retry, count of `pass∧retry_count>1`). Surfaces silent degradation before it becomes an incident. NEEDS-API + UI.

### Tier 3 — see §(f).

---

## (f) NEEDS-NEW-CAPTURE — the bigger reports (real runner work)

These need a new rollup dimension/column (the runner's `daily_check_rollup` is the efficient path; raw-run queries are the heavier alternative). Ranked by value.

**P8. Per-location comparison report.** *High value* (regional divergence, "is eastus2 slower than centralus", per-region availability — especially with the 3-region quorum). The rollup aggregates **across** locations (`schema.sql:751`), so this needs a **location dimension on the rollup** (or a bounded raw-run query) → API → UI (a per-region small-multiples / comparison table). NEEDS-CAPTURE.

**P9. INP in the rollup + reports.** INP is a Core Web Vital but the rollup drops `inp_ms` (`schema.sql:773-782` omits it) and the perf report has no INP field (`ReportDtos.cs:48`). Add `inp_p75` to the rollup → expose in `/reports/performance` → render in P1's CWV card. Small but spans all three layers. NEEDS-CAPTURE.

**P10. Resource / page-weight regression report.** transfer_bytes / cpu_time_ms / dom_node_count / js_heap_bytes captured per-run, rendered only on check-detail, absent from the rollup + report API. Add to the rollup (avg/p75) → API → a "page weight & runtime cost trend" report, optionally vs `perf_budget_transfer_bytes`/`perf_budget_lcp_ms` (the budget columns exist, `CheckDtos.cs:154-155`, but nothing compares actuals to them — a budget-burn report is a natural add). NEEDS-CAPTURE.

**P11. Runner-health report.** `runner_errors` (mig 0050) captured, no endpoint. A simple `GET /reports/runner-health` (fatals over time, by phase/check) → a small reliability panel. NEEDS-API (lightweight, the table is new and small).

**P12. Trace-signals fleet report.** `runs.trace_signals` (network waterfall + console errors) captured for every traced run but read by-id only (no index). A "top failing / slowest / largest third-party resources fleet-wide" report needs JSONB aggregation + an index → API → UI. High insight, heavier query work. NEEDS-API + index.

**P13 (niche). B10 redaction-hygiene history** (`reconcile_drift.redaction_mismatch`, mig 0049) and **spec-provenance drift** (`runs.spec_provenance`, mig 0047) — compliance/forensics reports, both fully backed but low day-to-day demand.

---

### Appendix — provenance
Three parallel read-only inventories (runner schema, API endpoints, dashboard render) + synthesis, on the heads above, 2026-06-30. All `file:line` are as of those commits. This doc is a backlog, not a queue — nothing was committed or PR'd.
