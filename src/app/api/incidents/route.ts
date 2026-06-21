import { query } from "@/lib/db";
import { handleRoute, json } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/incidents — open and resolved incidents, joined to their check, split
 * into two lists. Open are ordered critical-first then most-recent; resolved are
 * most-recently-resolved first.
 */
export async function GET(): Promise<Response> {
  return handleRoute(async () => {
    const result = await query(
      `
      SELECT
        i.id, i.check_id, i.status, i.severity, i.opened_at, i.resolved_at,
        i.opened_run_id, i.resolved_run_id, i.consecutive_failures, i.summary,
        c.name AS check_name, c.kind AS check_kind
      FROM incidents i
      JOIN checks c ON c.id = i.check_id
      ORDER BY
        (i.resolved_at IS NULL) DESC,
        CASE WHEN i.resolved_at IS NULL THEN (i.severity = 'critical') END DESC,
        COALESCE(i.resolved_at, i.opened_at) DESC
      `,
    );

    const open = result.rows.filter((r) => r.resolved_at === null);
    const resolved = result.rows.filter((r) => r.resolved_at !== null);

    return json({ open, resolved });
  });
}
