# Why the gates exist — `craigoley/synthwatch-dashboard`

**This file exists to stop a new team deleting the CI gates as friction.**

14 workflows, 14 jobs. This repo is a **read-mostly consumer** of a schema it does not own, which shapes
every gate here: the recurring failure is not "our code is wrong", it is **"the runner changed and we
rendered the result anyway"**.

Companion: the runner's
[`GATES.md`](https://github.com/craigoley/synthwatch/blob/main/docs/handover/GATES.md) holds the shared
auto-merge re-arm table. ★ **This repo has a re-arm path the others do not — see below.**

---

## How to read the ranking

| Rank | Meaning | Safe to disable under pressure? |
|---|---|---|
| **P0 — LOAD-BEARING** | Removing it re-opens a specific, dated incident. | **No.** |
| **P1 — LOAD-BEARING** | Guards a class that has bitten, but quieter. | Only with a named owner and a same-day re-enable. |
| **P2 — NICE-TO-HAVE** | Real value; recoverable failure. | Yes, temporarily. |
| **ADVISORY** | `continue-on-error` — cannot block. | Nothing to relax. |

**Branch protection:** required = **`ci-gate`** only; required approving reviews = **0**.
`REQUIRED` inside `ci-gate`: `Playwright (hermetic)`, `Claude review`,
`Enum coverage (runner schema vs consumer unions)`, `Lint`, `Semgrep OSS`, `SIGPIPE guard`.

---

## The gates

### `ci-gate` — the aggregator · **P0**

Same design and same traps as the other two repos: names in `REQUIRED` must **register** (fail-closed);
`Scan` is advisory by its own workflow's design and is deliberately excluded, because requiring a job
that can never go red asserts nothing.

Note that **`Semgrep OSS`** *is* in `REQUIRED` here — the code-scanning check, not the `Scan` job. That is
the gating SAST control.

---

### `Enum coverage (runner schema vs consumer unions)` — **P0**

**Asserts:** every value in a runner-owned enum `CHECK (<col> IN (...))` appears in this repo's mapped TS
string-union.

**What went wrong — the enum-drift class, seen 3× plus one live.** The runner's schema grows an enum
value; this repo's hardcoded TS union stays stale; and a blind `as X` cast **launders the new value past
`tsc`** — so it breaks or mis-renders **only in production**.

| Occurrence | |
|---|---|
| `redaction_mismatch` | #154 |
| grant gaps | — |
| `spec_path` | — |
| `infra_error` | live at the time the gate was written |

**Why `tsc` cannot catch it:** the value arrives at runtime as a string from an API this repo does not
own. TypeScript sees `as X` and believes it. The only defence is a static comparison against the
**runner's `db/schema.sql`** — truth lives in another repo.

It is the ENUM sibling of `synthwatch-api`'s `pg-grant-coverage`: same cross-repo harness, same fail-closed
posture.

**Relaxing it:** no. It is a sub-second static parse standing between a schema change and a broken
dashboard.

---

### `Playwright (hermetic)` — **P0**

**Asserts:** the end-to-end suite, **hermetically** — no live backend.

**Why hermetic matters:** an e2e suite pointed at a live API tests the API's current state, not this
repo's code, and goes red for reasons that have nothing to do with the PR. Hermetic keeps it a *gate*
rather than a *weather report*, which is the only reason it can be `REQUIRED`.

**Relaxing it:** no — it is the only check that exercises the rendered application.

---

### `SIGPIPE guard (no fail-open piped grep -q)` — **P1**

**Asserts:** no fail-open SIGPIPE antipattern in tracked shell / workflow `run:` blocks.

**The bug (five instances org-wide; shellcheck and actionlint miss it):** a producer piped into an
early-closing consumer under `set -o pipefail` — `printf … | grep -q P`, `cmd … | head -N`. The producer
takes **SIGPIPE (141)**, `pipefail` propagates 141, and a guard built on that exit **inverts**: a match
reads as "no match", flipping BLOCK→PASS.

★ **Input-size-dependent** — passes every small-input test, fails only in prod on a large input. Bit the
runner three times: #155, #279 (a CORS verify that printed *"template declares no blob CORS"* while CORS
was declared and live), #283.

Fix with a here-string, not `|| true`. Opt out per-line with `# sigpipe-ok` only after review.

---

### `Lint` (ESLint) — **P1**

Required here, unlike a typical frontend repo, because it is cheap and it is one of only six names in
`REQUIRED`.

---

### `Semgrep OSS` (code scanning) — **P1** · `Scan` (job) — **ADVISORY**

The gating control is **`Semgrep OSS`**. `Scan` is `continue-on-error` and cannot block.
**`# nosemgrep` does not clear the code-scanning check** — satisfy the rule or dismiss the alert.

---

### `Analyze (…)` CodeQL · `Review dependencies` · `scan-pr` / `scan-scheduled` (OSV) — **P1/P2**

Standard supply-chain and static-analysis coverage. OSV is P2.

---

### `Approve or re-run parked runs (trusted PRs only)` (`ci-unstick`) — **P1 — read this one**

**Asserts nothing.** It is a **recovery** workflow, and it exists because of a genuinely deceptive failure.

**What went wrong (#248 / #251):** when a head commit is pushed by a bot (`github-actions[bot]`), GitHub
creates the PR's `pull_request` runs in **`action_required`** (awaiting approval) instead of running them.
Every check — **including auto-merge** — silently stalls, **while the PR still displays the previous
commit's green checks**. The PR looks ready and is not running anything.

The primary fix was upstream (`claude-review.yml` is now comment-only and cannot push). This workflow is
the net for any *other* path that parks runs: on a schedule it finds `action_required` runs on open
**trusted** PRs and approves/re-runs them.

**★ Why it matters for handover:** if you ever see a PR whose checks are green but stale, this is the
mechanism. Do not trust a green tick without confirming it belongs to the **head** commit.

**Relaxing it:** disabling it does not fail anything — it just means parked PRs stay parked and look
fine. That combination is exactly why it is P1 rather than P2.

---

### `heal` · `Enable auto-merge (trusted authors only)` — **ORCHESTRATION**

Never blocking, by design.

---

## ★ Holding a PR open — and the extra re-arm path unique to this repo

```bash
gh workflow disable "Claude review" -R craigoley/synthwatch-dashboard
gh workflow disable "Auto-merge"    -R craigoley/synthwatch-dashboard
# …then re-enable BOTH…
```

**`gh pr view --json autoMergeRequest` is point-in-time, not durable.** A `null` is a snapshot.

★ **This repo's `auto-merge.yml` listens for `auto_merge_disabled` in addition to the usual four PR
types.** That is the most counter-intuitive re-arm path in the org:

> **Turning auto-merge off is itself an event that turns it back on.**

So on this repo, manually disabling auto-merge on a PR is not merely insufficient — it is
*self-defeating*. Disable the **workflow**, not the PR setting.

Full re-arm inventory for this repo:

| # | Path | Trigger |
|---|---|---|
| 1–4 | `auto-merge.yml` | `pull_request: opened, synchronize, reopened, ready_for_review` |
| 5 | `auto-merge.yml` | **`auto_merge_disabled`** ← unique to this repo |
| 6 | `ci-unstick` | approves/re-runs parked runs on a schedule, which can let a merge proceed |
| 7 | Manual | `gh pr merge --auto` |

**Cost of disabling `Claude review`:** it is in `REQUIRED`, and `ci-gate` is fail-closed on a check that
never registers → `ci-gate` waits its full **15-minute** deadline and **fails**. The red is a timeout, not
a real failure. Re-enable, then **re-run `ci-gate`** — it will not clear by itself.

---

## What is safe to relax under real pressure

1. **`Scan`** — already advisory.
2. **`scan-pr` / `scan-scheduled`** (P2) — a day without an advisory scan is recoverable.
3. **`Review dependencies`** (P2 here) — recoverable.
4. **`Lint`** (P1) — style only.

**Never:** `ci-gate`, `Enum coverage`, `Playwright (hermetic)`, `SIGPIPE guard`.

`Enum coverage` is the one a new team is most likely to mistake for bureaucracy — it is a static parse of
*another repo's* file. It is also the only thing standing between a runner enum change and a dashboard
that mis-renders in production, four times over.
