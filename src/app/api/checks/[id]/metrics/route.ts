import type { NextRequest } from "next/server";

import { query } from "@/lib/db";
import { badRequest, handleRoute, json, parseId } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/checks/[id]/metrics
 * run_metrics time series for the detail-page charts, joined to each run's
 * start time and status. HTTP checks produce no run_metrics rows, so this can
 * legitimately be empty (the UI shows "browser checks only").
 */
export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  return handleRoute(async () => {
    const id = parseId((await ctx.params).id);
    if (id === null) return badRequest("Invalid check id");

    const limitParam = Number(req.nextUrl.searchParams.get("limit"));
    const limit = Number.isInteger(limitParam) && limitParam > 0 && limitParam <= 500
      ? limitParam
      : 100;

    const result = await query(
      `
      SELECT
        m.run_id, m.captured_at, r.started_at, r.status,
        m.ttfb_ms, m.dom_content_loaded_ms, m.load_event_ms, m.fcp_ms, m.lcp_ms,
        m.transfer_bytes, m.resource_count, m.dom_node_count, m.js_heap_bytes,
        m.cpu_time_ms, m.layout_count, m.recalc_style_count
      FROM run_metrics m
      JOIN runs r ON r.id = m.run_id
      WHERE r.check_id = $1
      ORDER BY r.started_at DESC
      LIMIT $2
      `,
      [id, limit],
    );

    // Return oldest-first so charts read left-to-right in time.
    return json(result.rows.reverse());
  });
}
