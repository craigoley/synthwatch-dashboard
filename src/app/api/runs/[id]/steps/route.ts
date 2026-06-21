import type { NextRequest } from "next/server";

import { query } from "@/lib/db";
import { badRequest, handleRoute, json, parseId } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/runs/[id]/steps — ordered run_steps for the funnel stage-bar, so a
 * failed run shows which step it died at.
 */
export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  return handleRoute(async () => {
    const id = parseId((await ctx.params).id);
    if (id === null) return badRequest("Invalid run id");

    const result = await query(
      `
      SELECT id, run_id, step_index, label, status, duration_ms, detail
      FROM run_steps
      WHERE run_id = $1
      ORDER BY step_index ASC
      `,
      [id],
    );

    return json(result.rows);
  });
}
