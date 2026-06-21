import "server-only";

import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { attachDatabasePool } from "@vercel/functions";

/**
 * The ONE shared, pooled pg client for the whole dashboard.
 *
 * Why a single pooled client behind the /api layer (and never in components):
 *  - The shared Postgres is an Azure Burstable B1ms with a LOW max-connection
 *    ceiling. Serverless functions scale out without bound, so an unpooled or
 *    per-request client would exhaust connections and break the runner's writes.
 *    This pool (small `max`) is the gatekeeper that keeps us under the ceiling.
 *  - DATABASE_URL stays server-side, behind a narrow read/CRUD API.
 *  - One implementation is reused by every consumer (dashboard, status page,
 *    Prometheus exporter, CLI) via the HTTP API rather than direct DB access.
 *
 * `attachDatabasePool` (from @vercel/functions) lets Fluid Compute close idle
 * connections before a function instance suspends, preventing connection leaks
 * across the serverless lifecycle.
 *
 * ESCALATION PATH — if the B1ms ever exhausts connections despite this pool:
 * enable PgBouncer on the Azure Postgres Flexible Server and point DATABASE_URL
 * at the pooled port (6432) instead of the direct port (5432). No app changes
 * are required; the connection string alone moves us behind PgBouncer.
 *
 * This module is server-only (`import "server-only"`). Importing it from a
 * client component is a build-time error — that is the guard that keeps Postgres
 * access out of the React tree.
 */

const connectionString = process.env.DATABASE_URL;

function createPool(): Pool {
  // The Pool is lazy: constructing it does NOT open a socket, so importing this
  // module during `next build` (no DATABASE_URL, no DB reachable) is safe. A
  // connection is only opened on the first query, which only happens at request
  // time inside a route handler.
  const pool = new Pool({
    connectionString,
    // Keep this small: B1ms has very few connection slots, and many serverless
    // instances may each hold a pool. See escalation note above.
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // Azure Postgres Flexible Server requires TLS. We trust the server cert via
    // sslmode=require in the URL; rejectUnauthorized:false avoids shipping the
    // Azure CA bundle. Disabled automatically for local/in-cluster Postgres.
    ssl: requiresSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  });

  // Surface pool-level errors (e.g. backend terminated) without crashing the
  // process; individual queries still reject and are handled per-request.
  pool.on("error", (err) => {
    console.error("[db] idle client error", err.message);
  });

  // Let Fluid Compute drain idle connections before suspend.
  attachDatabasePool(pool);

  return pool;
}

function requiresSsl(url: string | undefined): boolean {
  if (!url) return false;
  if (/sslmode=disable/.test(url)) return false;
  if (/localhost|127\.0\.0\.1/.test(url)) return false;
  return true;
}

// Reuse a single pool across HMR reloads in dev and across warm invocations in
// production. `globalThis` survives module-cache resets that `next dev` triggers.
const globalForDb = globalThis as unknown as { __swPool?: Pool };

export const pool: Pool = globalForDb.__swPool ?? createPool();
if (process.env.NODE_ENV !== "production") {
  globalForDb.__swPool = pool;
}

/**
 * Typed query helper. Routes call this instead of touching the pool directly so
 * the row type is explicit at the call site.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: ReadonlyArray<unknown>,
): Promise<QueryResult<T>> {
  if (!connectionString) {
    // Defensive: only reachable at request time (never at build). Gives a clear
    // operator-facing error instead of a confusing driver failure.
    throw new Error("DATABASE_URL is not configured");
  }
  return pool.query<T>(text, params as unknown[]);
}
