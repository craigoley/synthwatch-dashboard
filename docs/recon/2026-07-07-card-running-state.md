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
