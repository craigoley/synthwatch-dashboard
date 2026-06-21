/**
 * ─────────────────────────────────────────────────────────────────────────────
 * SynthWatch API client — the single seam between the UI and the backend.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every read/write the dashboard performs goes through the typed functions in
 * this module. Nothing else in the app builds an API URL or calls `fetch` — the
 * React components and the SWR hooks (src/lib/client.ts) only ever call these
 * functions. This is the strangler-fig seam for moving the backend to a
 * standalone C# API on Azure.
 *
 * Today these functions hit the app's OWN Next.js route handlers under /api/*
 * (same-origin), so there is NO behavior change.
 *
 * ── TWO-STEP SWAP to the external C# API (when it is live) ───────────────────
 *   1. Set NEXT_PUBLIC_API_BASE_URL to the Azure API base URL
 *      (e.g. https://synthwatch-api.azurewebsites.net). Every call in this file
 *      becomes `${base}/api/...` instead of same-origin `/api/...`.
 *   2. Delete src/app/api/* (the route handlers) and src/lib/db.ts (the pooled
 *      pg client). The C# API now serves the same /api/* contract.
 *
 * The React components never change for the swap — they only ever talk to this
 * module. Keep this file framework-agnostic (no "use client", no React/SWR
 * imports) so it can also back a status page, Prometheus exporter, or CLI.
 */

import type {
  Check,
  CheckDetail,
  CheckWithStatus,
  IncidentsResponse,
  MetricPoint,
  RunStep,
  RunsPage,
} from "@/lib/types";
import type { CreateCheckInput, UpdateCheckInput } from "@/lib/schemas";

/**
 * Base URL for the API. Defaults to "" (empty) = same-origin, so requests go to
 * the local /api/* route handlers exactly as before. Set
 * NEXT_PUBLIC_API_BASE_URL to point the whole app at the external C# API.
 */
const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");

/** Error thrown for any non-2xx API response. Carries the HTTP status + details. */
export class ApiRequestError extends Error {
  status: number;
  details: unknown;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.details = details;
  }
}

type QueryValue = string | number | boolean | null | undefined;

/** Build a full URL from the API base, a path, and optional query params. */
function buildUrl(path: string, params?: Record<string, QueryValue>): string {
  let url = `${API_BASE}${path}`;
  if (params) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) qs.set(key, String(value));
    }
    const query = qs.toString();
    if (query) url += `?${query}`;
  }
  return url;
}

/**
 * The one place that performs `fetch`, checks status, and parses JSON. Non-2xx
 * responses become ApiRequestError without leaking transport details.
 */
async function request<T>(path: string, init?: RequestInit, params?: Record<string, QueryValue>): Promise<T> {
  const res = await fetch(buildUrl(path, params), {
    ...init,
    headers: { accept: "application/json", ...init?.headers },
  });

  if (!res.ok) {
    let body: { error?: string; details?: unknown } = {};
    try {
      body = await res.json();
    } catch {
      /* non-JSON error body */
    }
    throw new ApiRequestError(body.error ?? `Request failed (${res.status})`, res.status, body.details);
  }

  return res.json() as Promise<T>;
}

/** JSON-body request helper for writes (POST/PATCH/DELETE). */
function mutate<T>(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
  params?: Record<string, QueryValue>,
): Promise<T> {
  return request<T>(
    path,
    {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    params,
  );
}

export interface RunsQuery {
  limit?: number;
  offset?: number;
}

export interface DeleteCheckResult {
  id: number;
  deleted: "soft" | "hard";
  check?: Check;
}

// ─── reads ───────────────────────────────────────────────────────────────────

/** GET /api/checks — all checks with derived status for the grid. */
export function listChecks(): Promise<CheckWithStatus[]> {
  return request<CheckWithStatus[]>("/api/checks");
}

/** GET /api/checks/:id — one check + its recent runs. */
export function getCheck(id: number): Promise<CheckDetail> {
  return request<CheckDetail>(`/api/checks/${id}`);
}

/** GET /api/checks/:id/runs — paginated run history. */
export function getRuns(id: number, query: RunsQuery = {}): Promise<RunsPage> {
  return request<RunsPage>(`/api/checks/${id}/runs`, undefined, {
    limit: query.limit,
    offset: query.offset,
  });
}

/** GET /api/runs/:id/steps — run_steps for the funnel stage-bar. */
export function getSteps(runId: number): Promise<RunStep[]> {
  return request<RunStep[]>(`/api/runs/${runId}/steps`);
}

/** GET /api/checks/:id/metrics — run_metrics time series. */
export function getMetrics(id: number): Promise<MetricPoint[]> {
  return request<MetricPoint[]>(`/api/checks/${id}/metrics`);
}

/** GET /api/incidents — open + resolved incidents. */
export function listIncidents(): Promise<IncidentsResponse> {
  return request<IncidentsResponse>("/api/incidents");
}

/** GET /api/flows — distinct non-null flow_name values. */
export function listFlows(): Promise<string[]> {
  return request<string[]>("/api/flows");
}

// ─── writes ──────────────────────────────────────────────────────────────────

/** POST /api/checks — create a check. */
export function createCheck(input: CreateCheckInput): Promise<Check> {
  return mutate<Check>("/api/checks", "POST", input);
}

/** PATCH /api/checks/:id — edit / pause a check. */
export function updateCheck(id: number, input: UpdateCheckInput): Promise<Check> {
  return mutate<Check>(`/api/checks/${id}`, "PATCH", input);
}

/** DELETE /api/checks/:id — soft delete by default; hard=true for permanent. */
export function deleteCheck(id: number, hard = false): Promise<DeleteCheckResult> {
  return mutate<DeleteCheckResult>(`/api/checks/${id}`, "DELETE", undefined, {
    hard: hard ? true : undefined,
  });
}
