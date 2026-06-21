# SynthWatch — dashboard

Operator console for the self-hosted **SynthWatch** synthetic monitoring system.
A Next.js (App Router, TypeScript) app deployed on Vercel that reads the data the
SynthWatch **runner** writes to a shared Azure Postgres, and does CRUD on the
`checks` table.

This repo is the **dashboard MVP** (UI + API layer) only. The security stack and
`claude-review.yml` are a separate follow-up (Phase 2a).

---

## Architecture — an API layer, never direct DB access

React components **never** query Postgres. They fetch the app's own Next.js route
handlers under `/api/*`, and **only** those route handlers touch the database,
through **one shared pooled `pg` client** (`src/lib/db.ts`).

```
 React components ──fetch──▶ /api/* route handlers ──pg Pool──▶ Azure Postgres
 (browser, no DB)            (server-only)            (one small pool)
```

Why this matters:

- **Connection exhaustion.** The Postgres is an Azure **Burstable B1ms** with a
  low max-connection ceiling. Serverless functions scale out without bound, so an
  unpooled/per-request client would exhaust connections and break the **runner's
  writes**. The single small pool behind the API is the gatekeeper.
- **Security.** `DATABASE_URL` stays server-side, behind a narrow API. It is
  never shipped to the browser.
- **Reuse.** A status page, a Prometheus exporter, or a CLI can reuse the same
  HTTP endpoints instead of re-implementing DB access.

The DB client is marked `import "server-only"`, so importing it into a client
component is a build-time error — that is the guard that keeps Postgres out of the
React bundle. Fluid Compute closes idle connections before suspend via
`attachDatabasePool` from `@vercel/functions`.

### API-client seam

Components never call `fetch` directly either — every request goes through
`src/lib/api-client.ts`, the single typed transport layer that owns the base URL,
fetching, error handling, and JSON parsing. Today it targets the same-origin
`/api/*` route handlers, so there is no behavior change. This is a strangler-fig
seam for moving the backend to a standalone C# API on Azure: that migration
becomes a one-env-var change (`NEXT_PUBLIC_API_BASE_URL`) plus deleting the route
handlers, with no component edits.

### API routes (all server-side, Node runtime, `force-dynamic`)

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/checks` | list checks + derived current status, 24h p50/p95, sparkline, open incidents |
| POST | `/api/checks` | create a check (zod-validated) |
| GET | `/api/checks/[id]` | one check + recent runs |
| PATCH | `/api/checks/[id]` | edit / pause (`enabled`) |
| DELETE | `/api/checks/[id]` | **soft delete** (`enabled=false`) by default; `?hard=true` for a real delete |
| GET | `/api/checks/[id]/runs` | paginated run history (`?limit=&offset=`) |
| GET | `/api/checks/[id]/metrics` | `run_metrics` time series for charts |
| GET | `/api/runs/[id]/steps` | `run_steps` for the funnel stage-bar |
| GET | `/api/incidents` | open + resolved incidents, joined to their check |
| GET | `/api/flows` | distinct non-null `checks.flow_name` values |

Writes are validated (zod, `src/lib/schemas.ts`). Errors return proper status
codes; raw DB errors are logged server-side and **never** leaked to the client.

---

## Data contract — the runner owns the schema

The runner owns these tables (read-only truth for the dashboard; do not redesign):
`checks`, `runs`, `run_steps`, `run_metrics`, `incidents`.

TypeScript types for the schema live in **`src/db-types.ts`**, which is
**committed** and is the contract the API route handlers import.

### `gen:types` workflow (commit-time, NOT build-time)

Regenerate the types from the live DB whenever the runner changes the schema:

```bash
export DATABASE_URL='postgres://…?sslmode=require'
pnpm gen:types         # runs pg-to-ts, writes src/db-types.ts
git add src/db-types.ts && git commit -m "chore: regen db types"
```

> **The Vercel build must never require a database connection.** This is a
> monitoring tool — its dashboard build cannot hinge on DB reachability. Type
> generation is therefore a manual, commit-time step. The committed
> `db-types.ts` is the contract; `next build` does not run `gen:types`.

---

## Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | runtime only | Azure Postgres connection string. Server-side only; **not** required to build. Keep `sslmode=require`. |

Copy `.env.example` to `.env.local` for local development.

### Vercel Postgres firewall requirement

Azure Postgres Flexible Server blocks inbound connections by default. For the
Vercel deployment to reach it at **runtime**, you must allow Vercel's egress:

- In the Azure portal → your Flexible Server → **Networking** → firewall rules,
  add the IP ranges your Vercel functions egress from, **or**
- enable **"Allow public access from any Azure service / trusted ranges"** as
  appropriate for your security posture, **or**
- front the database with a static-egress proxy and allow that IP.

Because the build does not touch the DB, a missing/incorrect firewall rule does
**not** break deploys — only runtime data fetching. If `/api/*` returns 500s
right after deploy, the firewall is the first thing to check.

### PgBouncer escalation (connection exhaustion)

The pooled API layer keeps us under the B1ms connection ceiling. If it is ever
not enough:

1. Enable **PgBouncer** on the Azure Postgres Flexible Server.
2. Point `DATABASE_URL` at the **pooled port `6432`** instead of the direct
   `5432`.

No application changes are required — the connection string alone moves us behind
PgBouncer. (Also noted inline in `src/lib/db.ts`.)

---

## Local development

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
| `pnpm gen:types` | Regenerate `src/db-types.ts` from `$DATABASE_URL` (commit the result) |

---

## Design

A "control room" instrument-panel aesthetic: deep instrument-dark surfaces, a
faint technical grid, a phosphor-teal brand accent, and IBM Plex Sans / Plex Mono.
The status color law is absolute throughout: **pass = green, warn = amber,
fail/error = red**. Dense but legible, one screenful on mobile, dark-native. All
state is server state + URL params — **no browser storage APIs**.

### Pages

- **`/`** — status grid: a card per check with current state, last run, 24h
  p50/p95 and a sparkline. Sorted open-incident → enabled → disabled. Filter by
  status/kind/search (URL params).
- **`/checks/[id]`** — run-history table with the funnel stage-bar (`run_steps`),
  latency-over-time chart, tier-1 telemetry charts (`run_metrics`, rendering only
  series with data), and inline failure-artifact screenshots.
- **`/incidents`** — open + resolved incidents with severity, duration, summary.
- **`/monitors`** — CRUD: create/edit/pause/delete via the API, with a soft-delete
  default and an explicit hard-delete confirm.

---

## Project structure

```
src/
  db-types.ts            # committed schema contract (pg-to-ts shape)
  lib/
    db.ts                # the ONE shared pooled pg client (server-only)
    schemas.ts           # zod validation for writes
    types.ts             # API response types (JSON shapes for components)
    status.ts            # status → color/label metadata
    format.ts            # date / latency / bytes formatting
    api-helpers.ts       # route handler envelopes + error handling
    client.ts            # SWR hooks + mutations (client-only data layer)
  app/
    api/…                # route handlers — the ONLY place that imports db.ts
    page.tsx             # status grid
    checks/[id]/page.tsx # check detail
    incidents/page.tsx
    monitors/page.tsx
  components/…           # UI (charts, funnel bar, cards, forms, …)
```

## Stack

Next.js (App Router) · TypeScript (strict) · Tailwind CSS v4 · recharts · SWR ·
`pg` · `@vercel/functions` · zod · pnpm.

<!-- claude-review end-to-end validation: trivial docs touch, safe to merge. -->
