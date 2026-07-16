# Onboarding — `synthwatch-dashboard`

> _2026-07-15 · prose with **no automated check**. This doc **points**; it does not copy. If a doc and the code
> disagree, the code wins and the gate proves it._

## 1. What this repo is

The **operator console**: a Next.js (App Router, TypeScript) app on **Vercel** that is a **thin client over the
C# API** (`synthwatch-api`) — it renders monitoring data and does CRUD through the API, and holds no business
logic of its own. Its place in the 4-repo system + the handover plan:
**[TRANSITION.md](https://github.com/craigoley/synthwatch/blob/main/TRANSITION.md)** (in the runner repo).

## 2. First hour (from a clean clone)

This repo has its **own** dev loop (the #318 devcontainer covers only the runner + api, **not** the dashboard):

```bash
git clone https://github.com/craigoley/synthwatch-dashboard && cd synthwatch-dashboard
pnpm install --frozen-lockfile
pnpm typecheck             # tsc --noEmit
pnpm e2e                   # Playwright against the mocked API (no live backend needed)
pnpm dev                   # local server on :3000
```

Then: trivial change → branch → push → **open a PR** → CI green → **auto-merges** (`auto-merge.yml`).

## 3. ★ The one thing that will bite you day one

**The deploy is NOT atomic with the API.** The dashboard and `synthwatch-api` ship independently, so a live
dashboard can briefly talk to an *older or newer* API than it was built against. The mapper (`api-client.ts`)
must tolerate both shapes, and **`mapCheck` drops raw fields it doesn't map** — so adding an API field does
nothing here until the mapper + type are updated (this is the live `PerLocationPanel` TODO). See the
**non-atomic-deploy warning** referenced from the README's Architecture section and its
**[Rollback](README.md#rollback)**.

## 4. How a change reaches prod

- **CI gates** (aggregated by the required `ci-gate`): `eslint`, `typecheck`, the Playwright `e2e` +
  `contract` checks, `enum-coverage`, `Claude review`, `codeql`, `osv-scanner`, and the `sigpipe-guard`.
- **Auto-deploys on merge to `main`** — Vercel builds + promotes the new deployment.
- **★ Roll back:** the README's **[Rollback](README.md#rollback)** — carried forward with its
  **DRAFT · UNREHEARSED · NEVER EXECUTED** stamp. The path is **Vercel Instant Rollback** (promote the previous
  deployment) — but mind the non-atomic-deploy note above, and rehearse before trusting it
  ([OUTSTANDING.md](https://github.com/craigoley/synthwatch/blob/main/docs/handover/OUTSTANDING.md)).

## 5. Where the gated truth lives

*If a doc and the code disagree, the code wins and the gate proves it.*

- **`enum-coverage`** (CI) — the dashboard's enum unions must cover the API's; the gate reds on a new value
  the UI doesn't handle.
- **The Playwright `contract` fixtures** — the API response shapes the dashboard is built against, captured +
  checked (not a hand-maintained copy).
- **The API's own gated truth:** endpoints live in
  **[`synthwatch-api/docs/auth-gates.md`](https://github.com/craigoley/synthwatch-api/blob/main/docs/auth-gates.md)**
  (tripwired), and the data model in the runner's `db/schema.sql`. This repo is a *consumer* of both.
- **[`docs/operations.md`](docs/operations.md)** — accounts / sign-in / access, cited **by symbol** (a symbol
  survives a refactor; a line number drifts).

## 6. Who to ask

Post-handover: **[Wegmans dashboard owner — see the RACI](https://github.com/craigoley/synthwatch/blob/main/docs/handover/RACI.md)**,
**not Craig**. During the 30/60/90 shadow, Craig is on-call-for-questions only.
