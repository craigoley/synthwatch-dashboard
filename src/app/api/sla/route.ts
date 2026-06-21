import type { NextRequest } from "next/server";

import { query } from "@/lib/db";
import { badRequest, handleRoute, json } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/sla?window=24h|7d|30d
 * Per-check availability over a rolling window, from the runner-owned
 * sla_availability_<window> views. Defaults to 24h. Worst availability first so
 * the decommission-blocker signal is at the top.
 *
 * (Like the other route handlers, this is deleted when the C# API lands — it
 * already exposes the same GET /api/sla contract.)
 */
const VIEWS = {
  "24h": "sla_availability_24h",
  "7d": "sla_availability_7d",
  "30d": "sla_availability_30d",
} as const;

type Window = keyof typeof VIEWS;

export async function GET(req: NextRequest): Promise<Response> {
  return handleRoute(async () => {
    const window = req.nextUrl.searchParams.get("window") ?? "24h";
    if (!(window in VIEWS)) {
      return badRequest("Invalid window; expected one of: 24h, 7d, 30d");
    }
    // View name comes from a fixed allow-list (never user input), so it is safe
    // to interpolate. availability_pct is `numeric` (returned as a string by the
    // pg driver) — cast to float8 so the JSON contract is a real number.
    const view = VIEWS[window as Window];
    const result = await query(
      `
      SELECT
        check_id, check_name, kind, window_from, window_to,
        completed_runs, up_runs, down_runs,
        availability_pct::float8 AS availability_pct
      FROM ${view}
      ORDER BY availability_pct ASC NULLS FIRST, check_name ASC
      `,
    );

    return json(result.rows);
  });
}
