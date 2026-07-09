# Recon — narrative tab, top-50 drivers, cost citation chips (2026-07-08)

Branch `feat/narrative-tab-and-cost-chips`. Layer 3 of the #239 plan (runner → api → dashboard). Built
against the **live** narrative + cost responses (curled, no mock-first) per this repo's mock-vs-real history.
Three build items — two shipped, one **blocked on an upstream layer** and documented for when it lands.

## 1. AI Summary → its own DEFAULT reports sub-tab — SHIPPED

- `NarrativeCard` was page-level, above the `TabBar` (`reports/page.tsx`). It's now a first-class tab:
  - `TABS` gains `{ id: "summary", label: "Summary" }` as the FIRST entry.
  - `useTab(TAB_IDS, "summary")` — the fallback moved `performance` → `summary`, so opening `/reports`
    lands on the AI summary first (mirrors the #222 Cost-tab addition).
  - The card renders inside `{tab === "summary" && <div data-testid="reports-panel-summary">…}`.
- **Tag-filter honesty preserved.** The narrative is FLEET-wide (runner generates no per-tag narrative). The
  old page-level render hid the card under a tag filter (`selected.length === 0`). That gating is kept: with
  a tag filter active the summary tab shows a `summary-fleet-only-note` ("clear the tag filter to view it")
  instead of a fleet story read as the tagged subset. Consistent with the `report-scope-banner` discipline.
- Empty-panel note: `defaultWorld` serves no narrative → the card 404-hides → the summary panel is
  intentionally EMPTY (honest absence, not an error). Tests assert the panel is *mounted* + the tab is
  selected, not that an empty box has height.

## 2. Top-50 drivers — NO dashboard change needed (verified), regression-locked

- `FleetCostSummary` (`cost.tsx`) renders `data.top_cost_drivers` via `.map` with **no `.slice()`** — it
  shows every driver the API returns. The only `.slice(0, 5)` is the *empty-array fallback* (sort `checks`
  when `top_cost_drivers` is empty), never a cap on the real ranked list.
- The API ranks + limits (topN, bumped to 50 in #204). The dashboard is correctly a dumb renderer of that
  list. Added a regression-lock e2e (serve 12 drivers → assert all 12 rows render) so a future `.slice()`
  can't silently re-cap below the API's N.
- Live check: `GET /reports/cost` currently returns `topCostDrivers: 10` (the #204 topN=50 bump is not yet
  deployed to the live API), but that's an upstream number — the dashboard renders whatever N it's handed.

## 3. ★ Cost citation chips — BLOCKED on Layer 1 (runner), NOT fabricated

**Verified via live curl** (`GET /reports/narrative?scope=fleet&window=7d`, model gpt-5-mini): the fact pack
has **zero cost signal**. `factPack.current` / `factPack.deltas` carry only
`availabilityPct / p95 / incidents / downtimeMin` (+ their deltas). A grep of the full response for
`cost / projected / vcpu / compute / $ / driver / monthly` = 0 hits. So **Layer 1 (the runner writing cost
figures into the fact pack) is not deployed** — there is no cost key to thread into chips.

Per the task's "build against the REAL response, no mock" rule, we do **not** invent the cost-factpack shape
(the exact mock-vs-real trap that has burned this repo ~4×). This item ships when Layer 1 lands.

### Exact wiring for when Layer 1 deploys

The chips derive from the passthrough fact pack in `toFactChips(fp)` (`api-client.ts:1632`). When the runner
adds cost to `fact_pack.current` / `.deltas`, add a branch mirroring the existing ones — **confirm the real
key names against the live response first** (do NOT guess `projectedMonthly` etc. — curl and read):

```ts
// in toFactChips, after the downtimeMin branch — key names are PLACEHOLDERS, confirm vs live factPack:
if (c.<costKey> != null)
  facts.push({
    label: "Est. cost",
    value: money(c.<costKey>),                    // reuse cost.tsx `money`
    delta: d.<costDeltaKey> != null ? signed(d.<costDeltaKey>, "%") : null,
  });
```

`FactChips` (`narrative-card.tsx`) already renders any `NarrativeFact[]`, so a new cost fact needs **no
component change** — it appears as a chip beside the latency/availability chips automatically. The narrative
fixture in `narrative.spec.ts` (`worldWithNarrative` → `factPack`) then gets a cost key + a chip assertion.

## Verify

- `typecheck` + `lint` + `build` clean.
- Full e2e green (303 passed). Updated the specs that assumed `performance` was the default tab
  (`reports-tabs`, `narrative`, `reports` CWV/tag-scoped) to deep-link `?tab=performance` where they assert
  Performance-tab content; added the Summary-default + fleet-only-note + no-driver-cap tests.
