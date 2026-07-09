# Recon — cost UI rework (card cost + modal live-recompute + Cost tab) (2026-07-08)

Recon-before-build. Branch `analysis/recon-cost-ui-rework`. Answers the two blocking questions — does the
**card** need an API change or can it read existing per-check cost, and does the **edit modal** have the
live-recompute inputs — so Craig sees the plan before code. **OBSERVED** on this commit.

## 1. Card data source — NO API change needed; read `/reports/cost` per-check data

- The monitor cards are `CheckCard` (`src/components/check-card.tsx:42`), rendered by the home grid from
  `useChecks()` → `CheckWithStatus[]` (`src/app/page.tsx:75,227`).
- `CheckWithStatus` carries `p50_ms`/`p95_ms` (`types.ts:238-239`) but **no `avg_duration_s` and no cost** —
  the card list endpoint (`GET /checks`) does not project cost.
- **`GET /reports/cost` (#198) already returns the per-check figure** — `checks[]` is one row per ENABLED
  check with `projected_monthly` + `avg_duration_s` (`types.ts CostCheck`, powers the top-N). So the grid can
  read each card's projected cost from that ONE fetch — **no per-card computation, no new API field.**
- The grid already uses exactly this pattern for availability: `availabilityByCheck` Map → `availability`
  prop on each `CheckCard` (`page.tsx:79,225,230`). Mirror it: fetch `useCostReport()` once (SWR dedupes the
  shared `report-cost` key across the grid, the Cost tab, and the modal), build `costByCheck`, pass a
  `projectedCost` prop. **Verdict: card reads existing per-check `/reports/cost` data. No API change.**
  - Note: `/reports/cost` returns only ENABLED checks → a paused card has no cost row → render nothing (a
    paused monitor's go-forward cost is ~$0, honest to omit).

## 2. Edit-modal live-recompute inputs — all present

The cost model is `avg_duration_s × (2,592,000/interval_seconds) × region_count × rate`. Split by what the
modal controls:
- **interval** — EDITABLE in the modal: `MonitorForm` state `interval_minutes` (`monitor-form.tsx:70,127`;
  UI in minutes → `×60` for seconds). Live.
- **region_count** — EDITABLE in the modal: `locations: string[]` via `LocationSelect`
  (`monitor-form.tsx:86,321,419-423`). `region_count = form.locations.length`. Live.
- **avg_duration_s** — MEASURED, does NOT change with interval/region → **hold CONSTANT.** Read it for the
  edited check from `useCostReport()` → `checks.find(id).avg_duration_s`. A NEW / never-run check has none →
  show *"no duration history yet — cost projects after first run"*, not `$0`.
- **rate** — from the endpoint (§3).

So the modal recompute is pure arithmetic over: `modal interval + modal regions + stored avg_duration +
config rate`. ★ It exactly predicts frequency/region changes (arithmetic) but **cannot** predict how a
*spec* change affects duration (duration is measured from past runs) — the label says so.

## 3. The rate — reuse the endpoint's echoed rate

`useCostReport()` returns `rate_used`/`rate_source`/`rate_set_date` (#221 discipline). The card, modal, and
Cost tab all read the rate + label from there — **never hardcoded.**

## Build plan (one coherent PR)
1. **Reports "Cost" sub-tab:** add `{ id: "cost", label: "Cost" }` to the reports `TABS`; render
   `<FleetCostSummary />` there; **remove it from the home page** (`page.tsx:10,140`).
2. **Card projected $/mo:** grid builds `costByCheck` from `useCostReport()`; `CheckCard` renders a compact
   `~$X/mo est.` from the `projectedCost` prop (self-hides when none — paused/no-data). Rate label consistent.
3. **Modal live recompute:** a projected-cost element in `MonitorForm` recomputing from `interval_minutes` +
   `locations.length` + the stored `avg_duration_s` + rate. New-check-no-history → the no-data state.
   HONESTY: labeled *"projected from recent avg duration × your new frequency/regions"*; on save, card +
   detail projected adopt the new settings (go-forward), while **measured (7d) stays backward-looking** — a
   post-save projected≠measured gap is EXPECTED, not an error.

Every figure traces to a real input; the rate + label come from the endpoint.
