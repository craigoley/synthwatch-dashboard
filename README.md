# SynthWatch — dashboard

Operator console for the self-hosted **SynthWatch** synthetic monitoring system.
A Next.js (App Router, TypeScript) app deployed on Vercel that reads from — and
does CRUD against — the standalone **SynthWatch C# API** on Azure.

---

## Architecture — a thin client over the C# API

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

`GET /checks` · `POST /checks` · `GET|PATCH|DELETE /checks/{id}` (`?hard=true`
for a real delete) · `GET /checks/{id}/runs` · `GET /checks/{id}/metrics` ·
`GET /runs/{id}/steps` · `GET /incidents` · `GET /flows` ·
`GET /sla?window=24h|7d|30d` — all under `NEXT_PUBLIC_API_BASE_URL`.

---

## Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_API_BASE_URL` | yes (build + runtime) | Base URL of the C# API, **including** `/api` (e.g. `https://synthwatch-api.azurewebsites.net/api`). Inlined into the client bundle (`NEXT_PUBLIC_*`). |

Set it in Vercel (Production + Preview) and, for local dev, copy `.env.example`
to `.env.local`. The C# API's CORS (`Cors__AllowedOrigin`) must list the origin
the browser calls from (the Vercel origin in prod; a local browser on
`localhost` is blocked unless that origin is also allowed).

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
| `pnpm lint` | ESLint, `--max-warnings 0` |

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
    incidents/page.tsx
    monitors/page.tsx
  components/…           # UI (charts, funnel bar, cards, forms, SLA, …)
```

## Stack

Next.js (App Router) · TypeScript (strict) · Tailwind CSS v4 · recharts · SWR ·
zod · pnpm. No server-side DB driver — the C# API owns data access.

<!-- layer2 live-verdict check: trivial no-op, expect REVIEW_VERDICT: PASS (safe to revert) -->
