import { query } from "@/lib/db";
import { handleRoute, json } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/flows — distinct non-null `checks.flow_name` values, for the
 * browser-check flow dropdown.
 *
 * TODO: source flows from a runner-emitted manifest rather than from the checks
 * table itself. Reading them back from `checks` only surfaces flows that already
 * have a check, which is circular for first-time setup. The manifest would list
 * every flow the runner knows how to execute.
 */
export async function GET(): Promise<Response> {
  return handleRoute(async () => {
    const result = await query(
      `
      SELECT DISTINCT flow_name
      FROM checks
      WHERE flow_name IS NOT NULL AND flow_name <> ''
      ORDER BY flow_name ASC
      `,
    );

    return json(result.rows.map((r) => r.flow_name as string));
  });
}
