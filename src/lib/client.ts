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
import useSWRInfinite from "swr/infinite";

import {
  listChecks,
  getCheck,
  getRuns,
  getSteps,
  getMetrics,
  listIncidents,
  getIncidents,
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
  getChannelTestStatus,
  runCheckNow,
  getCheckTags,
  setCheckTags as apiSetCheckTags,
  getTags,
  getSuggestedKeys,
  getAvailabilityReport,
  getPerformanceReport,
  getNarrative,
  getReconcileDrift,
  getSpecCatalog,
  listEditors,
  addEditor as apiAddEditor,
  removeEditor as apiRemoveEditor,
  listAccessRequests,
  type ChannelInput,
  createCheck as apiCreateCheck,
  updateCheck as apiUpdateCheck,
  deleteCheck as apiDeleteCheck,
} from "@/lib/api-client";
import type { CreateCheckInput, UpdateCheckInput } from "@/lib/schemas";
import type {
  IncidentWithCheck,
  ReportWindow,
  Routing,
  Run,
  RunsPage,
  SlaWindow,
  Tag,
} from "@/lib/types";

/** Default page size for cursor-paginated run history (matches the API default/max bounds). */
export const RUN_PAGE_SIZE = 50;

// Logical SWR cache keys (NOT URLs). Centralized so reads and revalidation agree.
const keys = {
  checks: ["checks"] as const,
  check: (id: number) => ["check", id] as const,
  runs: (id: number, pageSize: number, from: string | null, to: string | null) =>
    ["runs", id, pageSize, from, to] as const,
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
  checkTags: (id: number) => ["check-tags", id] as const,
  tags: ["tags"] as const,
  suggestedKeys: ["tags-suggested"] as const,
  availabilityReport: (w: string, g: string) => ["report-availability", w, g] as const,
  performanceReport: (w: string, g: string) => ["report-performance", w, g] as const,
  narrative: (scope: string, w: string, key: number | null) => ["narrative", scope, w, key] as const,
  reconcileDrift: ["reconcile-drift"] as const,
  specCatalog: ["spec-catalog"] as const,
  editors: ["editors"] as const,
  accessRequests: ["access-requests"] as const,
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

/**
 * A single recent page of runs (no load-more) — for summaries like the report
 * drill-down's "recent errors". `range` bounds the window; omit it and the API
 * defaults to its recent window so the query stays bounded.
 */
export function useRuns(
  id: number | null,
  pageSize = RUN_PAGE_SIZE,
  range?: { from?: string; to?: string },
) {
  return useSWR(
    id ? keys.runs(id, pageSize, range?.from ?? null, range?.to ?? null) : null,
    () => getRuns(id as number, { pageSize, from: range?.from, to: range?.to }),
    live,
  );
}

// ── shared cursor pagination (runs + incidents) ─────────────────────────────────
// One useSWRInfinite engine for every cursor list. The fetcher returns the normalized
// { items, nextCursor } shape; each domain hook adapts its API page to it. The cache key
// carries the scope + date-range, so changing either starts a fresh walk; the trailing
// element is the cursor (null = first page) threaded from the prior page's nextCursor.

interface CursorPageData<T> {
  items: T[];
  nextCursor: string | null;
}

function useCursorHistory<T>(
  // null disables the hook (e.g. no id yet). Otherwise the stable scope identity for the cache key.
  scope: readonly (string | number | null)[] | null,
  fetchPage: (cursor: string | null) => Promise<CursorPageData<T>>,
  pageSize: number,
) {
  const getKey = (index: number, prev: CursorPageData<T> | null) => {
    if (!scope) return null;
    if (prev && prev.nextCursor === null) return null; // window exhausted — stop requesting
    const cursor = index === 0 ? null : (prev?.nextCursor ?? null);
    return [...scope, pageSize, cursor] as const;
  };

  const swr = useSWRInfinite<CursorPageData<T>>(
    getKey,
    (key) => fetchPage((key[key.length - 1] as string | null) ?? null),
    { refreshInterval: 15_000, revalidateOnFocus: true, revalidateFirstPage: false, keepPreviousData: true },
  );

  const pages = swr.data ?? [];
  const items = pages.flatMap((p) => p.items);
  const lastPage = pages.length > 0 ? pages[pages.length - 1] : null;
  // hasMore: the last loaded page still carries a cursor (false before anything loads — the
  // hook itself gates the first fetch via getKey).
  const hasMore = lastPage ? lastPage.nextCursor !== null : false;

  return {
    items,
    error: swr.error as Error | undefined,
    isLoading: swr.isLoading,
    isLoadingMore: swr.isValidating && pages.length > 0, // validating a page beyond the first
    hasMore,
    loadMore: () => swr.setSize(swr.size + 1),
    reset: () => swr.setSize(1),
  };
}

/**
 * Cursor-paginated run history with load-more. `range` is the date-range window; changing it
 * resets the walk (it's part of the cache key). Thin wrapper over the shared cursor engine.
 */
export function useRunHistory(
  id: number | null,
  range: { from?: string; to?: string },
  pageSize = RUN_PAGE_SIZE,
) {
  const h = useCursorHistory<Run>(
    id ? ["run-history", id, range.from ?? null, range.to ?? null] : null,
    (cursor) =>
      getRuns(id as number, { pageSize, from: range.from, to: range.to, cursor: cursor ?? undefined }).then(
        (p) => ({ items: p.runs, nextCursor: p.next_cursor }),
      ),
    pageSize,
  );
  return { runs: h.items, ...rest(h) };
}

/**
 * Cursor-paginated incidents with load-more — the SAME engine as run history, keyed on opened_at.
 * `filter.status` selects open vs resolved (open is window-exempt server-side); `range` bounds the
 * resolved/historical window. Changing the filter or range resets the walk (both are keyed in).
 */
export function useIncidentHistory(
  filter: { status?: "open" | "resolved"; checkId?: number },
  range: { from?: string; to?: string },
  pageSize = RUN_PAGE_SIZE,
) {
  const h = useCursorHistory<IncidentWithCheck>(
    ["incident-history", filter.status ?? null, filter.checkId ?? null, range.from ?? null, range.to ?? null],
    (cursor) =>
      getIncidents({
        status: filter.status,
        checkId: filter.checkId,
        pageSize,
        from: range.from,
        to: range.to,
        cursor: cursor ?? undefined,
      }).then((p) => ({ items: p.incidents, nextCursor: p.next_cursor })),
    pageSize,
  );
  return { incidents: h.items, ...rest(h) };
}

// The pagination controls shared by every cursor-history wrapper (everything but the item list).
function rest<T>(h: ReturnType<typeof useCursorHistory<T>>) {
  return {
    error: h.error,
    isLoading: h.isLoading,
    isLoadingMore: h.isLoadingMore,
    hasMore: h.hasMore,
    loadMore: h.loadMore,
    reset: h.reset,
  };
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

// Async test-send: enqueue (POST → 202 { requestId }) + poll the runner job's
// status (GET .../test/status). No cache — these are imperative one-offs, but
// re-exported so the page imports from the React data layer like everything else.
export { sendChannelTest, getChannelTestStatus };

// On-demand "Run now": POST → 202 { requestId }; the run then appears in the history.
export { runCheckNow };

/** Revalidate a check's run-history (all date-range pages) — call after triggering an on-demand run
 *  so the new run shows up live. Matches the useRunHistory cache key ["run-history", checkId, …]. */
export async function revalidateRunHistory(checkId: number) {
  await globalMutate(
    (k) => Array.isArray(k) && k[0] === "run-history" && k[1] === checkId,
    undefined,
    { revalidate: true },
  );
}

// Tags (Phase 9a). shouldRetryOnError:false so a pre-API 404 leaves data undefined
// (the editor hides) rather than retry-looping.
export function useSuggestedKeys() {
  return useSWR(keys.suggestedKeys, () => getSuggestedKeys(), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
}

/** A check's current tag set (edit seeding + incident-detail display). */
export function useCheckTags(id: number | null) {
  return useSWR(
    id ? keys.checkTags(id) : null,
    () => getCheckTags(id as number),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
}

/** Distinct in-use tags — for the future 9b filter bar (built now, unused in the UI). */
export function useTags() {
  return useSWR(keys.tags, () => getTags(), { revalidateOnFocus: false, shouldRetryOnError: false });
}

// Reports. shouldRetryOnError:false so a pre-API 404 (→ null) shows "reports pending".
export function useAvailabilityReport(window: ReportWindow, groupBy: string) {
  return useSWR(keys.availabilityReport(window, groupBy), () => getAvailabilityReport(window, groupBy), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
}

export function usePerformanceReport(window: ReportWindow, groupBy: string) {
  return useSWR(keys.performanceReport(window, groupBy), () => getPerformanceReport(window, groupBy), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
}

// AI narrative (Layer 3). shouldRetryOnError:false → a 404 (not enabled/generated) leaves
// data undefined and the card hides, never a retry loop or an error box.
export function useNarrative(scope: "fleet" | "monitor", window: ReportWindow, key: number | null = null) {
  return useSWR(
    keys.narrative(scope, window, key),
    () => getNarrative(scope, window, scope === "monitor" ? (key ?? undefined) : undefined),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
}

// Monitors-as-code drift (Phase 6b). shouldRetryOnError:false → a 404 (endpoint not deployed) leaves
// data null and the surface hides; an empty items array (reconcile ran, in sync) still renders the
// positive "in sync with Git" state. Read-only — there is no write/apply hook (apply is a later runner
// capability; reconcile runs in report mode).
export function useReconcileDrift() {
  return useSWR(keys.reconcileDrift, () => getReconcileDrift(), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
}

// Spec catalog (Phase 13 — read-only inventory). shouldRetryOnError:false → a 404 (endpoint not
// deployed) leaves data null and the page hides gracefully; an empty items array (reconcile hasn't
// populated spec_catalog yet) renders the "no specs yet" state. Read-only — no write/activation hook.
export function useSpecCatalog() {
  return useSWR(keys.specCatalog, () => getSpecCatalog(), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
}

// Editor (user) management — admin-only (Phase 12 slice 3). The API 403s a non-admin; the dashboard
// only renders these on the admin /users view. enabled=false skips the fetch entirely (non-admins never
// call it). shouldRetryOnError:false so a stray 401/403 doesn't retry-loop.
export function useEditors(enabled = true) {
  return useSWR(enabled ? keys.editors : null, () => listEditors(), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
}

export function useAccessRequests(enabled = true) {
  return useSWR(enabled ? keys.accessRequests : null, () => listAccessRequests(), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
}

/** Add an editor, then refresh the list (+ access requests, since the email drops off pending). */
export async function addEditor(email: string) {
  const result = await apiAddEditor(email);
  await Promise.all([globalMutate(keys.editors), globalMutate(keys.accessRequests)]);
  return result;
}

/** Remove an editor, then refresh the list. */
export async function removeEditor(email: string) {
  await apiRemoveEditor(email);
  await Promise.all([globalMutate(keys.editors), globalMutate(keys.accessRequests)]);
}

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
    // The spec catalog's coverage is check-derived (GET /api/specs LEFT JOINs checks by source_key), so a
    // check create/edit/pause/delete flips a catalog row Unmonitored↔Active/Paused. Invalidate it HERE —
    // in the mutation owner — so the catalog updates live like the checks/flows lists, regardless of which
    // page triggered the write (catalog activation OR a spec-bound New-monitor). Previously this lived only
    // in the catalog page's onActivated callback, so other paths left the catalog stale until a refresh.
    globalMutate(keys.specCatalog),
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

/** Set a check's tag set, then refresh the affected caches (incl. embedded-tag lists). */
export async function setCheckTags(id: number, tags: Tag[]) {
  const result = await apiSetCheckTags(id, tags);
  await Promise.all([
    globalMutate(keys.checkTags(id)),
    globalMutate(keys.check(id)),
    globalMutate(keys.checks),
    globalMutate(keys.tags),
  ]);
  return result;
}

export async function deleteCheck(id: number, hard = false) {
  const result = await apiDeleteCheck(id, hard);
  await revalidateChecks(id);
  return result;
}
