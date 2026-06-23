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
  getIncident,
  listFlows,
  getSla,
  getAvailabilitySeries,
  getLocations,
  getCheckLocations,
  setCheckLocations as apiSetCheckLocations,
  listChannels,
  createChannel as apiCreateChannel,
  updateChannel as apiUpdateChannel,
  deleteChannel as apiDeleteChannel,
  getRouting,
  setRouting as apiSetRouting,
  getDeliveryReadiness,
  sendChannelTest,
  type ChannelInput,
  createCheck as apiCreateCheck,
  updateCheck as apiUpdateCheck,
  deleteCheck as apiDeleteCheck,
} from "@/lib/api-client";
import type { CreateCheckInput, UpdateCheckInput } from "@/lib/schemas";
import type { Routing, SlaWindow } from "@/lib/types";

// Logical SWR cache keys (NOT URLs). Centralized so reads and revalidation agree.
const keys = {
  checks: ["checks"] as const,
  check: (id: number) => ["check", id] as const,
  runs: (id: number, limit: number, offset: number) => ["runs", id, limit, offset] as const,
  steps: (runId: number) => ["steps", runId] as const,
  metrics: (id: number) => ["metrics", id] as const,
  incidents: ["incidents"] as const,
  incident: (id: number) => ["incident", id] as const,
  flows: ["flows"] as const,
  sla: (window: SlaWindow) => ["sla", window] as const,
  availability: (id: number, window: SlaWindow) => ["availability", id, window] as const,
  locations: ["locations"] as const,
  checkLocations: (id: number) => ["check-locations", id] as const,
  channels: ["channels"] as const,
  routing: ["routing"] as const,
  deliveryReadiness: ["delivery-readiness"] as const,
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

export function useIncident(id: number | null) {
  return useSWR(id ? keys.incident(id) : null, () => getIncident(id as number), live);
}

export function useFlows() {
  return useSWR(keys.flows, () => listFlows(), { revalidateOnFocus: false });
}

// Available run locations (selector options). shouldRetryOnError:false so that,
// until the parallel API PR serves /api/locations, a 404 just leaves data
// undefined (feature stays hidden) instead of retry-looping.
export function useLocations() {
  return useSWR(keys.locations, () => getLocations(), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
}

/** A check's current location assignment (edit only). */
export function useCheckLocations(id: number | null) {
  return useSWR(
    id ? keys.checkLocations(id) : null,
    () => getCheckLocations(id as number),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
}

// Alerting. shouldRetryOnError:false so a pre-API 404 leaves data undefined (the
// settings page shows "setup pending") rather than retry-looping.
export function useChannels() {
  return useSWR(keys.channels, () => listChannels(), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
}

export function useRouting() {
  return useSWR(keys.routing, () => getRouting(), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
}

/** Delivery-readiness (ACS transport configured?). null when the endpoint 404s. */
export function useDeliveryReadiness() {
  return useSWR(keys.deliveryReadiness, () => getDeliveryReadiness(), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
}

// One-shot test-send action (no cache). Re-exported so the page imports from the
// React data layer like everything else.
export { sendChannelTest };

export function useSla(window: SlaWindow = "24h") {
  return useSWR(keys.sla(window), () => getSla(window), live);
}

export function useAvailabilitySeries(id: number | null, window: SlaWindow = "24h") {
  return useSWR(
    id ? keys.availability(id, window) : null,
    () => getAvailabilitySeries(id as number, window),
    live,
  );
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

/** Set a check's location assignment, then refresh the affected caches. */
export async function setCheckLocations(id: number, locations: string[]) {
  const result = await apiSetCheckLocations(id, locations);
  await Promise.all([
    globalMutate(keys.checkLocations(id)),
    globalMutate(keys.check(id)),
    globalMutate(keys.checks),
  ]);
  return result;
}

// ─── alerting mutations ──────────────────────────────────────────────────────
export async function createChannel(input: ChannelInput) {
  const result = await apiCreateChannel(input);
  await globalMutate(keys.channels);
  return result;
}

export async function updateChannel(id: number, input: ChannelInput) {
  const result = await apiUpdateChannel(id, input);
  await globalMutate(keys.channels);
  return result;
}

export async function deleteChannel(id: number) {
  await apiDeleteChannel(id);
  // A deleted channel may also be referenced by routing — refresh both.
  await Promise.all([globalMutate(keys.channels), globalMutate(keys.routing)]);
}

export async function setRouting(routing: Routing) {
  const result = await apiSetRouting(routing);
  await globalMutate(keys.routing);
  return result;
}

export async function deleteCheck(id: number, hard = false) {
  const result = await apiDeleteCheck(id, hard);
  await revalidateChecks(id);
  return result;
}
