import type { NextRequest } from "next/server";

import { query } from "@/lib/db";
import { badRequest, handleRoute, json, notFound, parseId } from "@/lib/api-helpers";
import { updateCheckSchema } from "@/lib/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// Columns the dashboard is allowed to write. (The runner owns last_run_at etc.)
const UPDATABLE = [
  "name",
  "kind",
  "target_url",
  "flow",
  "interval_seconds",
  "timeout_ms",
  "latency_warn_ms",
  "enabled",
  "failure_threshold",
  "lighthouse_enabled",
  "lighthouse_interval_seconds",
  "lighthouse_form_factor",
  "perf_budget_lcp_ms",
  "perf_budget_transfer_bytes",
] as const;

/** GET /api/checks/[id] — one check + its most recent runs. */
export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  return handleRoute(async () => {
    const id = parseId((await ctx.params).id);
    if (id === null) return badRequest("Invalid check id");

    const checkRes = await query(`SELECT * FROM checks WHERE id = $1`, [id]);
    if (checkRes.rowCount === 0) return notFound("Check not found");

    const runsRes = await query(
      `
      SELECT id, check_id, started_at, finished_at, status, duration_ms,
             runner_id, error_message, artifact_url
      FROM runs
      WHERE check_id = $1
      ORDER BY started_at DESC
      LIMIT 50
      `,
      [id],
    );

    return json({ check: checkRes.rows[0], recent_runs: runsRes.rows });
  });
}

/** PATCH /api/checks/[id] — partial edit / pause (enabled). */
export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  return handleRoute(async () => {
    const id = parseId((await ctx.params).id);
    if (id === null) return badRequest("Invalid check id");

    const body: unknown = await req.json().catch(() => ({}));
    const data = updateCheckSchema.parse(body);

    // Build a parameterized dynamic UPDATE from only the provided columns.
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const col of UPDATABLE) {
      if (Object.prototype.hasOwnProperty.call(data, col)) {
        values.push((data as Record<string, unknown>)[col]);
        sets.push(`${col} = $${values.length}`);
      }
    }
    if (sets.length === 0) return badRequest("No updatable fields provided");

    values.push(id);
    const result = await query(
      `UPDATE checks SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING *`,
      values,
    );
    if (result.rowCount === 0) return notFound("Check not found");

    return json(result.rows[0]);
  });
}

/**
 * DELETE /api/checks/[id]
 * Soft delete by default (sets enabled=false so history is preserved).
 * Pass ?hard=true to permanently remove the row.
 */
export async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
  return handleRoute(async () => {
    const id = parseId((await ctx.params).id);
    if (id === null) return badRequest("Invalid check id");

    const hard = req.nextUrl.searchParams.get("hard") === "true";

    if (hard) {
      const result = await query(`DELETE FROM checks WHERE id = $1 RETURNING id`, [id]);
      if (result.rowCount === 0) return notFound("Check not found");
      return json({ id, deleted: "hard" });
    }

    const result = await query(
      `UPDATE checks SET enabled = false WHERE id = $1 RETURNING *`,
      [id],
    );
    if (result.rowCount === 0) return notFound("Check not found");
    return json({ id, deleted: "soft", check: result.rows[0] });
  });
}
