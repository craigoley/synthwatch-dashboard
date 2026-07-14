# SynthWatch — dashboard

Operator console for the self-hosted **SynthWatch** synthetic monitoring system.
A Next.js (App Router, TypeScript) app deployed on Vercel that reads from — and
does CRUD against — the standalone **SynthWatch C# API** on Azure.

> **How to read this doc.** Each section is stamped: **🔒 gated** = enforced by a test (trust it); **prose** =
> human-maintained, no automated check, can drift — if the code disagrees, the code wins. The one trap that
> silently bites is boxed at the top of [Architecture](#architecture--a-thin-client-over-the-c-api).

---

## Architecture — a thin client over the C# API

> ## ★ THE WIRE ADAPTER IS THE DAY-ONE TRAP
> `api-client.ts` maps the API's camelCase wire → the snake_case shapes components read. That adapter is a
> *virtue* for isolation — and the **#1 way a new engineer ships a silent bug.** (Symbols, not line numbers,
> are the durable anchors — line numbers as of this writing.)
> - **Add a field to `types.ts` but forget the matching `mapCheck` / `mapRun` line** (`api-client.ts:510` / `:583`)
>   → the field is silently `undefined` at runtime. No error, no build failure.
> - **Fat-finger a wire key** → the `?? false` / `?? "prod"` defaults (`:526`, `:599`, `:671`) **SWALLOW it**: an
>   absent value renders as *healthy* (prod, not-sandbox, sufficient-data). **Absent reads green — the fake-quiet class.**
> - **Only the trust seam throws** on a missing field (`mapTrustRow` → `trustRowSchema.parse`, `:2366`). Every
>   other mapper coalesces — so a wire break surfaces loud on the trust scorecard and **silently nowhere else.**
>
> **Rules:** when you touch `types.ts`, touch its mapper in the *same commit*; before renaming a wire key, grep
> `api-client.ts` for the old camelCase key. See the non-atomic-deploy warning under [Rollback](#rollback).

> _Prose — describes the seam's intent; `src/lib/api-client.ts` is authoritative._

The dashboard has **no backend of its own**. Every read/write goes through one
typed transport layer, `src/lib/api-client.ts`, to the C# API:

```
 React components ──▶ src/lib/api-client.ts ──HTTPS──▶ C# API (Azure) ──▶ Postgres
 (no fetch, no URLs)   (the only fetch/URL builder)     (managed identity)
```

- **Single seam.** Components never call `fetch` or build a URL; they call
  api-client functions (directly or via the SWR hooks in `src/lib/client.ts`).
  Re-pointing the whole app is a one-env-var change (`NEXT_PUBLIC_API_BASE_URL`).
- **Casing/shape adapter.** The C# API speaks camelCase and wraps some
  collections (`{items,…}`, `{window,items}`). `api-client.ts` maps those to the
  snake_case shapes the components read, and maps outgoing write bodies
  snake→camel. This is the only place that knows the wire format.
- **Framework-agnostic.** `api-client.ts` has no React/SWR imports, so it can also
  back a status page, exporter, or CLI.

> **History:** the dashboard previously ran its own Next.js `/api/*` route
> handlers + a pooled `pg` client. Those were removed when the C# API went live;
> the api-client seam made it a contained change with zero component edits.

### Endpoints (served by the C# API)

> _Pointer — the authoritative list lives with the code that serves it, not here._

The dashboard consumes **60+** endpoints; hand-listing them here drifts (this section once showed nine). Two
authoritative sources, neither hand-maintained in this README:

- **The full server-side list** — the C# API's [`docs/auth-gates.md`](https://github.com/craigoley/synthwatch-api/blob/main/docs/auth-gates.md), "the complete endpoint table" (which gate protects each, and the auth mechanism).
- **What this app actually calls** — whatever `src/lib/api-client.ts` builds; that file is the dashboard-side source of truth. All requests go under `NEXT_PUBLIC_API_BASE_URL`.

---

## Environment

> _Prose — verify against `.env.example` and the Vercel project settings._

| Variable | Required | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_API_BASE_URL` | yes (build + runtime) | Base URL of the C# API, **including** `/api` (e.g. `https://synthwatch-api.azurewebsites.net/api`). Inlined into the client bundle (`NEXT_PUBLIC_*`). |

Set it in Vercel (Production + Preview) and, for local dev, copy `.env.example`
to `.env.local`. The C# API's CORS (`Cors__AllowedOrigin`) must list the origin
the browser calls from (the Vercel origin in prod; a local browser on
`localhost` is blocked unless that origin is also allowed).

---

## Operations

> _Pointer — see the linked runbook (itself prose; it cites file:line that can drift)._

Accounts, OTP sign-in, adding/removing editors and admins, and the API-side
auth-enforcement flag: **[docs/operations.md](docs/operations.md)**. For deploying and reverting a build,
see [Rollback](#rollback) below.

---

## Local development

> _Commands are real (they map to `package.json` scripts); the surrounding notes are prose._

```bash
corepack enable               # use the pinned pnpm
pnpm install --frozen-lockfile
pnpm dev                      # http://localhost:3000
```

The package manager is pinned to `pnpm@10.34.4` (the `packageManager` field) so
Vercel installs with a matching pnpm and a frozen lockfile.

### Scripts

| Script | What it does |
| --- | --- |
| `pnpm dev` | Next dev server |
| `pnpm build` | Production build (no DB connection required) |
| `pnpm start` | Run the production build |
| `pnpm typecheck` | `tsc --noEmit` (strict) |
| `pnpm lint` | ESLint, `--max-warnings 0` |

---

## Rollback

> ⚠️ **DRAFT · UNREHEARSED · NEVER EXECUTED.** This is written from how the pieces work, not from a drill. Do
> not trust it under fire without validating each step — an untested rollback is not a rollback.

- **Reverting a bad build = Vercel Instant Rollback**, full stop. In the Vercel dashboard, promote the previous
  Production deployment. There is no other revert path — the app has no server/config to flip.
- **★ The env var will NOT save you.** `NEXT_PUBLIC_API_BASE_URL` is **baked into the client bundle at BUILD
  time** (`api-client.ts:177` reads `process.env.NEXT_PUBLIC_*`, which Next inlines). Changing it in Vercel
  settings does **nothing** to an already-built deployment — it requires a **rebuild + redeploy**, not a rollback.
  So a bad base URL is fixed by rolling back to a build that had the right one, or rebuilding — never by editing the setting alone.
- **⚠️ Dashboard ↔ API deploys are NOT atomic.** They ship from separate repos on separate pipelines. A wire-key
  rename on the API breaks the dashboard **mostly SILENTLY** — the `?? false` / `?? "prod"` mapper defaults
  swallow the now-absent field and render *healthy* (see the [Architecture trap](#architecture--a-thin-client-over-the-c-api)); only the trust seam goes loud. **Therefore:** a rollback on
  EITHER side must be checked against the OTHER side's *live* contract (the API's deployed shape vs the
  dashboard's `contract/real/*.json` fixtures), or you can roll one half into a silent mismatch.

---

## Design

> _Pointer — the visual/UX design language lives in [docs/design.md](docs/design.md)._

A "control room" instrument-panel aesthetic; **pass = green, warn = amber, fail/error = red** is the absolute
status-color law. Full rationale and conventions: **[docs/design.md](docs/design.md)**.

---

## Pages

> 🔒 **Gated (presence).** The `ROUTES:START`/`ROUTES:END` list below is enforced by
> `contract/readme-routes.contract.ts` to match `src/app/**/{page,route}.tsx` exactly — add/remove a route
> without updating it and CI fails. ★ Presence ONLY: the gate does **not** check that any description is correct.

<!-- ROUTES:START — presence-gated by contract/readme-routes.contract.ts (add/remove drift only, NOT descriptions). Keep sorted. -->
Page routes:

- `/`
- `/checks/[id]`
- `/glossary`
- `/incidents`
- `/incidents/[id]`
- `/monitors`
- `/notifications`
- `/reports`
- `/settings/environments`
- `/specs`
- `/status`
- `/throw-test`
- `/trust`
- `/users`

Route handlers:

- `/api/probe-echo`
- `/screenshot-proxy/[runId]`
<!-- ROUTES:END -->

**What each route does:** read the page component under `src/app/**` — the code is the description, and it can't
drift from itself. The high-traffic ones: `/` (status grid), `/checks/[id]` (run history + funnel + telemetry),
`/incidents` (open/resolved), `/monitors` (CRUD, soft-delete default). `/throw-test` is a dev-only
error-boundary probe.

---

## Project structure

> _Prose — a hand-drawn sketch that can drift; the filesystem and the gated route list above are authoritative._

```
src/
  lib/
    api-client.ts        # the ONLY fetch/URL builder — adapter over the C# API
    client.ts            # SWR hooks + mutations (delegates to api-client)
    schemas.ts           # zod input types for writes (CreateCheckInput, …)
    types.ts             # API response types (snake_case shapes for components)
    status.ts            # status → color/label metadata
    format.ts            # date / latency / bytes / pct formatting
  app/
    page.tsx             # status grid
    checks/[id]/page.tsx # check detail
    incidents/page.tsx   # (+ incidents/[id])
    monitors/page.tsx
    reports/  status/  users/  specs/  glossary/  trust/   # + 10 more page routes
    notifications/  settings/environments/
    screenshot-proxy/[runId]/route.ts  api/probe-echo/route.ts   # route handlers
  components/…           # UI (charts, funnel bar, cards, forms, SLA, …)
```

## Stack

> _Prose — verify against `package.json`._

Next.js (App Router) · TypeScript (strict) · Tailwind CSS v4 · recharts · SWR ·
zod · pnpm. No server-side DB driver — the C# API owns data access.
