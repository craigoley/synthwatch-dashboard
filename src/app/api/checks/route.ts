import type { NextRequest } from "next/server";

import { query } from "@/lib/db";
import { handleRoute, json } from "@/lib/api-helpers";
import { createCheckSchema } from "@/lib/schemas";

// pg needs the Node runtime (not edge); data is always request-time, never built.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/checks
 * List every check enriched with derived current status, 24h latency
 * percentiles, a recent-run sparkline, and open-incident info. Sorted so the
 * grid shows: open-incident first, then enabled, then disabled.
 */
export async function GET(): Promise<Response> {
  return handleRoute(async () => {
    const result = await query(
      `
      SELECT
        c.*,
        lr.status        AS current_status,
        lr.started_at    AS last_started_at,
        lr.finished_at   AS last_finished_at,
        lr.error_message AS last_error_message,
        stats.p50_ms,
        stats.p95_ms,
        COALESCE(stats.runs_24h, 0)        AS runs_24h,
        COALESCE(oi.open_incident_count, 0) AS open_incident_count,
        oi.max_open_severity,
        COALESCE(spark.points, '[]'::json)  AS spark
      FROM checks c
      LEFT JOIN LATERAL (
        SELECT r.status, r.started_at, r.finished_at, r.error_message
        FROM runs r
        WHERE r.check_id = c.id
        ORDER BY r.started_at DESC
        LIMIT 1
      ) lr ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          percentile_cont(0.5)  WITHIN GROUP (ORDER BY r.duration_ms) AS p50_ms,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY r.duration_ms) AS p95_ms,
          COUNT(*)::int AS runs_24h
        FROM runs r
        WHERE r.check_id = c.id
          AND r.started_at >= NOW() - INTERVAL '24 hours'
          AND r.duration_ms IS NOT NULL
      ) stats ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS open_incident_count,
          (
            SELECT i2.severity FROM incidents i2
            WHERE i2.check_id = c.id AND i2.resolved_at IS NULL
            ORDER BY (i2.severity = 'critical') DESC, i2.opened_at DESC
            LIMIT 1
          ) AS max_open_severity
        FROM incidents i
        WHERE i.check_id = c.id AND i.resolved_at IS NULL
      ) oi ON TRUE
      LEFT JOIN LATERAL (
        SELECT json_agg(p ORDER BY p.t) AS points
        FROM (
          SELECT r.started_at AS t, r.duration_ms AS d, r.status AS s
          FROM runs r
          WHERE r.check_id = c.id
          ORDER BY r.started_at DESC
          LIMIT 30
        ) p
      ) spark ON TRUE
      ORDER BY
        (COALESCE(oi.open_incident_count, 0) > 0) DESC,
        c.enabled DESC,
        c.name ASC
      `,
    );

    return json(result.rows);
  });
}

/**
 * POST /api/checks — create a check.
 */
export async function POST(req: NextRequest): Promise<Response> {
  return handleRoute(async () => {
    const body: unknown = await req.json().catch(() => ({}));
    const data = createCheckSchema.parse(body);

    const result = await query(
      `
      INSERT INTO checks (
        name, kind, target_url, flow, interval_seconds, timeout_ms,
        latency_warn_ms, enabled, failure_threshold, lighthouse_enabled,
        lighthouse_interval_seconds, lighthouse_form_factor,
        perf_budget_lcp_ms, perf_budget_transfer_bytes
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
      )
      RETURNING *
      `,
      [
        data.name,
        data.kind,
        data.target_url,
        data.flow,
        data.interval_seconds,
        data.timeout_ms,
        data.latency_warn_ms,
        data.enabled,
        data.failure_threshold,
        data.lighthouse_enabled,
        data.lighthouse_interval_seconds,
        data.lighthouse_form_factor,
        data.perf_budget_lcp_ms,
        data.perf_budget_transfer_bytes,
      ],
    );

    return json(result.rows[0], { status: 201 });
  });
}
