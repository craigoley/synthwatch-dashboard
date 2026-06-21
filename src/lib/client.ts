"use client";

/**
 * React/SWR data layer. This is the caching + auto-refresh layer that the live
 * monitoring UI uses. It owns NO transport details: every request is delegated
 * to the typed functions in src/lib/api-client.ts (the single API seam). There
 * are deliberately no `/api/...` URLs or `fetch` calls here — only api-client.ts
 * builds URLs. SWR cache keys are logical identifiers, not URLs, so they survive
 * the future base-URL swap unchanged.
 *
 * All state is server state + URL params (no browser storage).
 */

import useSWR, { type SWRConfiguration, mutate as globalMutate } from "swr";

import {
  listChecks,
  getCheck,
  getRuns,
  getSteps,
  getMetrics,
  listIncidents,
  listFlows,
  getSla,
  createCheck as apiCreateCheck,
  updateCheck as apiUpdateCheck,
  deleteCheck as apiDeleteCheck,
} from "@/lib/api-client";
import type { CreateCheckInput, UpdateCheckInput } from "@/lib/schemas";
import type { SlaWindow } from "@/lib/types";

// Logical SWR cache keys (NOT URLs). Centralized so reads and revalidation agree.
const keys = {
  checks: ["checks"] as const,
  check: (id: number) => ["check", id] as const,
  runs: (id: number, limit: number, offset: number) => ["runs", id, limit, offset] as const,
  steps: (runId: number) => ["steps", runId] as const,
  metrics: (id: number) => ["metrics", id] as const,
  incidents: ["incidents"] as const,
  flows: ["flows"] as const,
  sla: (window: SlaWindow) => ["sla", window] as const,
};

// Live dashboards: refresh on an interval, revalidate when the tab refocuses.
const live: SWRConfiguration = {
  refreshInterval: 15_000,
  revalidateOnFocus: true,
  keepPreviousData: true,
};

// ─── read hooks ────────────────────────────────────────────────────────────────

export function useChecks() {
  return useSWR(keys.checks, () => listChecks(), live);
}

export function useCheck(id: number | null) {
  return useSWR(id ? keys.check(id) : null, () => getCheck(id as number), live);
}

export function useRuns(id: number | null, limit = 50, offset = 0) {
  return useSWR(
    id ? keys.runs(id, limit, offset) : null,
    () => getRuns(id as number, { limit, offset }),
    live,
  );
}

export function useRunSteps(runId: number | null) {
  return useSWR(runId ? keys.steps(runId) : null, () => getSteps(runId as number));
}

export function useMetrics(id: number | null) {
  return useSWR(id ? keys.metrics(id) : null, () => getMetrics(id as number), live);
}

export function useIncidents() {
  return useSWR(keys.incidents, () => listIncidents(), live);
}

export function useFlows() {
  return useSWR(keys.flows, () => listFlows(), { revalidateOnFocus: false });
}

export function useSla(window: SlaWindow = "24h") {
  return useSWR(keys.sla(window), () => getSla(window), live);
}

// ─── mutations (transport via api-client, then refresh affected caches) ─────────

/** Revalidate the lists/detail that a write affects. */
export async function revalidateChecks(id?: number) {
  await Promise.all([
    globalMutate(keys.checks),
    globalMutate(keys.flows),
    id != null ? globalMutate(keys.check(id)) : Promise.resolve(),
  ]);
}

export async function createCheck(input: CreateCheckInput) {
  const result = await apiCreateCheck(input);
  await revalidateChecks();
  return result;
}

export async function updateCheck(id: number, input: UpdateCheckInput) {
  const result = await apiUpdateCheck(id, input);
  await revalidateChecks(id);
  return result;
}

export async function deleteCheck(id: number, hard = false) {
  const result = await apiDeleteCheck(id, hard);
  await revalidateChecks(id);
  return result;
}
