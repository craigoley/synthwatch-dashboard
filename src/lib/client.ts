"use client";

/**
 * Client-side data layer. Components fetch the app's OWN /api/* endpoints with
 * SWR (relative URLs in the browser) — they NEVER touch Postgres. Auto-refresh
 * is what makes this a live monitoring console; all state is server state +
 * URL params, no browser storage.
 */

import useSWR, { type SWRConfiguration, mutate as globalMutate } from "swr";

import type {
  CheckDetail,
  CheckWithStatus,
  IncidentsResponse,
  MetricPoint,
  RunStep,
  RunsPage,
} from "@/lib/types";
import type { CreateCheckInput, UpdateCheckInput } from "@/lib/schemas";

export class ApiRequestError extends Error {
  status: number;
  details: unknown;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
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

// Live dashboards: refresh on an interval, revalidate when the tab refocuses.
const live: SWRConfiguration = {
  refreshInterval: 15_000,
  revalidateOnFocus: true,
  keepPreviousData: true,
};

export function useChecks() {
  return useSWR<CheckWithStatus[]>("/api/checks", fetcher, live);
}

export function useCheck(id: number | null) {
  return useSWR<CheckDetail>(id ? `/api/checks/${id}` : null, fetcher, live);
}

export function useRuns(id: number | null, limit = 50, offset = 0) {
  return useSWR<RunsPage>(
    id ? `/api/checks/${id}/runs?limit=${limit}&offset=${offset}` : null,
    fetcher,
    live,
  );
}

export function useRunSteps(runId: number | null) {
  return useSWR<RunStep[]>(runId ? `/api/runs/${runId}/steps` : null, fetcher);
}

export function useMetrics(id: number | null) {
  return useSWR<MetricPoint[]>(id ? `/api/checks/${id}/metrics` : null, fetcher, live);
}

export function useIncidents() {
  return useSWR<IncidentsResponse>("/api/incidents", fetcher, live);
}

export function useFlows() {
  return useSWR<string[]>("/api/flows", fetcher, { revalidateOnFocus: false });
}

// ─── mutations ───────────────────────────────────────────────────────────────

async function mutateRequest<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let payload: { error?: string; details?: unknown } = {};
    try {
      payload = await res.json();
    } catch {
      /* ignore */
    }
    throw new ApiRequestError(
      payload.error ?? `Request failed (${res.status})`,
      res.status,
      payload.details,
    );
  }
  return res.json() as Promise<T>;
}

/** Revalidate the lists/detail that a write affects. */
export async function revalidateChecks(id?: number) {
  await Promise.all([
    globalMutate("/api/checks"),
    globalMutate("/api/flows"),
    id ? globalMutate(`/api/checks/${id}`) : Promise.resolve(),
  ]);
}

export async function createCheck(input: CreateCheckInput) {
  const result = await mutateRequest("/api/checks", "POST", input);
  await revalidateChecks();
  return result;
}

export async function updateCheck(id: number, input: UpdateCheckInput) {
  const result = await mutateRequest(`/api/checks/${id}`, "PATCH", input);
  await revalidateChecks(id);
  return result;
}

export async function deleteCheck(id: number, hard = false) {
  const result = await mutateRequest(
    `/api/checks/${id}${hard ? "?hard=true" : ""}`,
    "DELETE",
  );
  await revalidateChecks(id);
  return result;
}
