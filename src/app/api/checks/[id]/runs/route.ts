import type { NextRequest } from "next/server";

import { query } from "@/lib/db";
import { badRequest, handleRoute, json, parseId } from "@/lib/api-helpers";
import { runsQuerySchema } from "@/lib/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/checks/[id]/runs?limit=&offset= — paginated run history. */
export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  return handleRoute(async () => {
    const id = parseId((await ctx.params).id);
    if (id === null) return badRequest("Invalid check id");

    const { limit, offset } = runsQuerySchema.parse({
      limit: req.nextUrl.searchParams.get("limit") ?? undefined,
      offset: req.nextUrl.searchParams.get("offset") ?? undefined,
    });

    const [rows, count] = await Promise.all([
      query(
        `
        SELECT id, check_id, status, started_at, finished_at, duration_ms,
               http_status, error_message, failed_step, screenshot_url
        FROM runs
        WHERE check_id = $1
        ORDER BY started_at DESC
        LIMIT $2 OFFSET $3
        `,
        [id, limit, offset],
      ),
      query(`SELECT COUNT(*)::int AS total FROM runs WHERE check_id = $1`, [id]),
    ]);

    return json({
      runs: rows.rows,
      total: count.rows[0]?.total ?? 0,
      limit,
      offset,
    });
  });
}
