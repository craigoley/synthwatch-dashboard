# Recon — check-card running-state overwrites the settled outcome (2026-07-07)

Analysis-only. Branch `analysis/recon-card-running-state` from `origin/main` @ `045876b`. No behavior change.

**Ask (Craig).** When a monitor is running, the card's LEFT-BORDER flips green→blue and the "PASS" pill
becomes "RUNNING" (blue). Craig wants the border to stay the **last-settled-outcome** color (green = a
generally-passing monitor still reads green mid-run), with the running state shown by a SEPARATE affordance
(spinner/dot/badge) rather than by overwriting the border or the health pill.

**Evidence contract.** Every finding cites `file:line` or command output. **OBSERVED** = read directly from
code/fixtures on this commit. **INFERRED** = reasoned from observed facts. Each load-bearing claim names a
**falsifier** and reports the result of running it.

### Verdicts at a glance

| # | Question | Answer |
|---|----------|--------|
| 1 | What drives the left border? | `check.current_status` → `runStatusMeta().token` → `RAIL[token]` (`check-card.tsx:31,40-45,51`). It is the CURRENT run state; it becomes `"running"` mid-run → `var(--color-running)` (blue), overwriting the settled color. NOT a last-settled field. |
| 2 | What drives the pill? | The SAME field — `StatusBadge status={check.current_status}` (`check-card.tsx:107`). Border and pill collapse to one value. The data model has NO settled-vs-live split: `running` is just a member of the `RunStatus` enum that `current_status` takes. |
| 3 | Does the card already get both? | NO separate settled field. The card receives one collapsed `current_status` (= `running` mid-run). BUT the last-settled outcome is **recoverable client-side** from `spark[]` (most recent point with `s !== "running"`) — present in the real payload → a dashboard-only fix is possible without a new API field (with a heuristic caveat). |
| 4 | Minimal options | (A) border+pill read spark-derived settled, a running dot overlays — **dashboard-only**; (B) pill splits into health chip + running badge — **dashboard-only**; (C) authoritative new API field `last_settled_status` — **needs API**. A/B compose; C removes the spark caveat. |

---

## Q1 — What drives the left-border color?

**ANSWER (OBSERVED): the border is driven by `check.current_status` (the CURRENT run state), via
`runStatusMeta(check.current_status).token` → `RAIL[token]`. Mid-run `current_status` becomes `"running"`,
so the border flips to `var(--color-running)` (blue) — overwriting the settled outcome color. It is NOT a
last-settled-outcome value.**

The card is `src/components/check-card.tsx`. The border is the "rail":

- `check-card.tsx:31` — `const meta = runStatusMeta(check.current_status);`
- `check-card.tsx:40-45` — the rail value:
  ```
  const rail =
    check.open_incident_count > 0
      ? TONE_VAR.fail
      : regional || degraded
        ? TONE_VAR.warn
        : RAIL[meta.token];          // ← else: driven by current_status
  ```
  (`RAIL = TONE_VAR`, `check-card.tsx:11`.)
- `check-card.tsx:50-51` — the rail color is injected as the `--rail` CSS var on the card:
  ```
  className="sw-card sw-rail block p-4"
  style={{ ["--rail" as string]: rail, opacity: check.enabled ? 1 : 0.62 }}
  ```
- `src/app/globals.css:132-140` — `.sw-rail::before { … background: var(--rail, var(--color-idle)); box-shadow: 0 0 14px -2px var(--rail); }` — confirms `--rail` paints the left rail element.

The running→blue mapping:
- `src/lib/status.ts:25` — `running: { label: "Running", token: "running", dotClass: "sw-dot-running" }`.
- `src/components/status-badge.tsx:8` — `running: "var(--color-running)"` in `TONE_VAR`.

So when `current_status === "running"` and there is no open incident / regional-partial, `meta.token ===
"running"` and `rail === var(--color-running)` (blue). The green settled color is gone for the duration.

**Falsifier (run):** is the rail ever independent of `current_status` when running? The only overrides ahead
of `RAIL[meta.token]` are `open_incident_count > 0` (→ fail/red) and `regional || degraded` (→ warn/amber)
— both `check-card.tsx:40-44`, neither of which fires for a healthy monitor. For a generally-passing monitor
mid-run, the branch taken is `RAIL[meta.token]` with `meta.token === "running"`. Confirmed: the border is
the current run state, and it overwrites green with blue.

**Note (not a bug, but relevant):** the incident and regional/degraded overrides are already derived from
`open_incident_count` / `locations`, i.e. they are already independent of `current_status`. Only the healthy
branch collapses onto the live state.

---

## Q2 — What drives the status pill text/color, and is there a settled-vs-live split in the model?

**ANSWER (OBSERVED): the pill is driven by the SAME single value as the border — `check.current_status`.
There is NO distinction in the data model between "last settled status" and "current run state": `"running"`
is simply one member of the `RunStatus` enum, and `current_status` takes it directly. Border and pill both
collapse onto that one field, so both flip together when a run starts.**

- `check-card.tsx:107` — the pill: `<StatusBadge status={check.current_status} />`. Same field the rail
  reads at `:31`.
- `src/components/status-badge.tsx:12-16` — `StatusBadge` maps `status` through `runStatusMeta` and colors
  via `TONE_VAR[meta.token]`; `status === "running"` → label "Running", tone `var(--color-running)` (blue).
- The enum collapses the two concepts — `src/lib/types.ts:121`:
  ```
  export type RunStatus = "running" | "pass" | "warn" | "fail" | "error" | "infra_error";
  ```
  `running` sits alongside the settled outcomes, so a field typed `RunStatus` cannot express "settled = pass
  AND currently running" simultaneously — it holds one or the other.

**Falsifier (run):** does the pill read a different field than the border? Both read `check.current_status`
(`:107` pill, `:31`+`:45` border). Not separate. And is there any second run-status field to split them
onto? Falsifier over the real payload (`checks.json`): the only run-status field on a check is
`currentStatus`; the other `*status*` keys are `expectedStatus` and `lastHttpStatus` (both HTTP codes, not
run states). No `lastSettledStatus` / `lastFinishedStatus`. Confirmed: one collapsed field.

---

## Q3 — Ground-truth data availability: does the card already receive both?

**ANSWER: NO dedicated field. The card receives a single collapsed `current_status` that IS `"running"`
mid-run — not a settled outcome plus a separate running flag. HOWEVER, the last-settled outcome is
RECOVERABLE client-side today from `spark[]` (the most recent point whose `s !== "running"`), which is
present in the real payload. So separating them is a DASHBOARD-ONLY change — no new API field is strictly
required — subject to a heuristic caveat (spark is a capped recent window).**

### OBSERVED — the DTO the card consumes

The card takes `CheckWithStatus` (`check-card.tsx:3,27`). Its status-bearing fields
(`src/lib/types.ts`, `CheckWithStatus`):
```
current_status: RunStatus | null;   // the collapsed field (→ "running" mid-run)
last_started_at:  string | null;
last_finished_at: string | null;    // a finished run exists, but its STATUS value is not carried
last_error_message: string | null;
spark: SparkPoint[];                 // per-run history: { t: ISO, d: ms|null, s: RunStatus }
locations: LocationStatus[];         // per-location latest status (drives regional/degraded)
```
There is a `last_finished_at` timestamp but **no `last_finished_status`** — the settled *outcome value* is
not a first-class field. The only carrier of prior settled outcomes is `spark[].s`.

### OBSERVED — the running state is real, and spark carries the settled history

Falsifier (run) over the captured real list (`contract/real/checks.json`, 21 checks):
```
distinct currentStatus: ['fail', 'pass', 'running']        # currentStatus really does take "running"
sample spark point:     {'t': '2026-07-01T…', 'd': 7016, 's': 'pass'}
any spark 's' == running anywhere: True                    # spark includes the in-flight run too
status fields on a check: ['currentStatus','expectedStatus','lastHttpStatus']  # no settled-status field
```
So: (a) the API sets `currentStatus="running"` mid-run (this is the flip), and (b) `spark[]` includes
running points — meaning **last-settled = the most recent `spark` point with `s !== "running"`**. The data
to keep the border green while a healthy monitor runs is already in the payload the card receives.

### INFERRED — feasibility + caveat

A dashboard-only fix can derive `settledStatus` from `spark` and use `current_status === "running"` purely as
the running-affordance trigger. Caveats (all INFERRED from the observed shape):
- `spark` is a **capped recent window**; a brand-new monitor whose only runs are the in-flight one (spark
  empty or all-`running`) has no settled outcome → the border falls back to idle/no-data. Acceptable (there
  genuinely is no settled outcome yet), but it means "settled" is a best-effort client derivation, not an
  authoritative field.
- `spark` ordering must be confirmed (newest first vs last) before implementing — the fixture point is a
  single sample; the derivation is "max by `t` where `s !== running`", which is order-independent and robust.

An authoritative alternative is a new API field (Q4 option C) that removes the caveat.

**Note (out of card scope, but adjacent):** the check-DETAIL page consumes `CheckDetail.recent_runs[]` (full
run objects), so there the last-settled outcome is trivially `recent_runs.find(r => r.status !== "running")`
without touching spark — the detail view has richer data than the card if the same treatment is wanted there.

---

## Q4 — Minimal change options (scoped, NOT implemented)

All options share one derivation: **`settledStatus` = the most recent `spark` point with `s !== "running"`**
(fallback `current_status` when it is already settled; fallback idle/no-data when neither exists), and
**`isRunning` = `current_status === "running"`**. Given Q1-Q3, the running state need not touch the border or
the health pill — it can ride a separate affordance.

### Option A — border (and pill) read the settled outcome; a running dot/spinner overlays

- **Change:** in `check-card.tsx`, compute `settledStatus` from `spark`; feed the rail from
  `runStatusMeta(settledStatus).token` instead of `current_status` (keeping the existing incident/regional
  overrides at `:40-44` untouched). Render the health pill from `settledStatus` too. Add a small pulsing dot
  when `isRunning` — reuse the existing `sw-dot-running` class (`status.ts:25`, already defined) placed by
  the "latest" label or on the rail.
- **Scope: DASHBOARD-ONLY.** No API change. Uses data already in the payload (Q3).
- **Caveat:** settled is spark-derived (capped window); a never-yet-settled monitor shows idle border while
  running — correct, but it means the border is a best-effort client derivation.

### Option B — split the pill into a health chip + a separate running badge (border unchanged in this option)

- **Change:** keep `StatusBadge` bound to `settledStatus` (health), and add a distinct small "RUNNING"
  badge/spinner beside it only when `isRunning`. The "latest" label already exists (`check-card.tsx:106`) —
  the running badge sits alongside it. Does not, by itself, change the border.
- **Scope: DASHBOARD-ONLY.**
- **Note:** A and B **compose** — A fixes the border, B fixes the pill; together they fully satisfy the ask
  (border stays settled, pill stays health, running is a separate affordance). Recommended pairing.

### Option C — authoritative settled field from the API (`last_settled_status` / `last_finished_status`)

- **Change:** API adds the last *completed* run's status as a first-class field (it already exposes
  `last_finished_at`, so the value is known server-side). Dashboard reads it directly for border + pill;
  `current_status` is used only for `isRunning`.
- **Scope: NEEDS AN API FIELD (cross-repo).** Removes the spark-window caveat from A/B; robust for
  empty/short spark and independent of spark ordering/cap.
- **Relationship to A/B:** same UI change as A/B, just sourced from an authoritative field instead of a
  client derivation. A/B can ship first (dashboard-only) and swap the source to this field later with no UI
  churn.

### Option D (rejected) — remember the previous status in React state (`usePrevious`)

- Keep border/pill at the last non-running value held in component state. **Rejected:** fragile — state is
  lost on remount, navigation, list re-sort, or SWR key change, and the grid re-renders/polls frequently.
  `spark` (A/B) is the robust client source; prefer it.

### Recommendation (scoping only — not a decision to implement)

**A + B, dashboard-only**, is the minimal change that satisfies the ask with no API dependency: border and
health pill both read the spark-derived `settledStatus`; a `sw-dot-running` spinner shows the live run. If
the spark-window caveat is unacceptable, layer **Option C** later by swapping the source field — no UI
rework. Estimated blast radius: `check-card.tsx` only (plus the same treatment optionally mirrored on the
detail page, which already has `recent_runs[]` for an exact settled value — see Q3 note). No behavior change
is made in this PR.

---

### Falsifiers run (summary)

- **Border source** — `check-card.tsx:31,40-45,51`: rail = `RAIL[runStatusMeta(current_status).token]`
  except incident/regional overrides; `current_status` proven to take `"running"` in `checks.json`. ✔
- **Pill source** — `check-card.tsx:107`: `StatusBadge status={check.current_status}` — same field. ✔
- **No settled field** — `checks.json` status keys = `currentStatus`, `expectedStatus`, `lastHttpStatus`
  only; no `lastSettledStatus`. ✔
- **Settled recoverable from spark** — `checks.json`: `spark[].s` present and includes `"running"`, so
  "latest `s !== running`" yields the settled outcome, client-side. ✔
