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
  getSpecCache,
  getErrorDiff,
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
  getIncidentBreakdown,
  getSloReport,
  getCostReport,
  getDeploys,
  getEgressReport,
  getRegionHealth,
  getTrustReport,
  getTrustDetail,
  getStatus,
  getMttrReport,
  getNarrative,
  getReconcileDrift,
  getReconcilePlan,
  triggerReconcile,
  approveReconcilePlan,
  rejectReconcilePlan,
  applyReconcilePlans,
  getSpecCatalog,
  listEditors,
  addEditor as apiAddEditor,
  removeEditor as apiRemoveEditor,
  listAccessRequests,
  dismissAccessRequest as apiDismissAccessRequest,
  type ChannelInput,
  createCheck as apiCreateCheck,
  updateCheck as apiUpdateCheck,
  deleteCheck as apiDeleteCheck,
  setEnvironmentOverride as apiSetEnvironmentOverride,
  type EnvValue,
} from "@/lib/api-client";
import type { CreateCheckInput, UpdateCheckInput } from "@/lib/schemas";
import { runsDebug } from "@/lib/debug";
import type {
  IncidentWithCheck,
  ReportWindow,
  EgressWindow,
  RunOutcome,
  Routing,
  Run,
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
  specCache: (id: number) => ["spec-cache", id] as const,
  errorDiff: (id: number, runId: number | null) => ["error-diff", id, runId] as const,
  channels: ["channels"] as const,
  routing: ["routing"] as const,
  deliveryReadiness: ["delivery-readiness"] as const,
  checkTags: (id: number) => ["check-tags", id] as const,
  tags: ["tags"] as const,
  suggestedKeys: ["tags-suggested"] as const,
  availabilityReport: (w: string, g: string, t: string) => ["report-availability", w, g, t] as const,
  incidentBreakdown: (w: string, t: string) => ["report-incident-breakdown", w, t] as const,
  sloReport: (w: string, t: string) => ["report-slo", w, t] as const,
  costReport: () => ["report-cost"] as const,
  deploys: (h: string, w: string) => ["deploys", h, w] as const,
  egress: (w: string) => ["report-egress", w] as const,
  regionHealth: () => ["report-region-health"] as const,
  trust: (w: string) => ["report-trust", w] as const,
  trustDetail: (id: number, w: string) => ["report-trust", id, w] as const,
  status: () => ["status-page"] as const,
  mttrReport: (w: string, t: string) => ["report-mttr", w, t] as const,
  performanceReport: (w: string, g: string, t: string) => ["report-performance", w, g, t] as const,
  narrative: (scope: string, w: string, key: number | null) => ["narrative", scope, w, key] as const,
  reconcileDrift: ["reconcile-drift"] as const,
  reconcilePlan: ["reconcile-plan"] as const,
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

export function useChecks(opts: { fast?: boolean } = {}) {
  return useSWR(keys.checks, () => listChecks(), {
    ...live,
    // fast: while a "Run all" batch is in flight, poll at the run-active cadence so the aggregate
    // running/done/pass/fail counts advance live as each monitor's run settles. Idle 15s otherwise.
    ...(opts.fast ? { refreshInterval: RUN_ACTIVE_POLL_MS } : {}),
  });
}

/**
 * SHARED run-aware poll cadence (#108): poll FAST while a run is in-flight/expected, fall back to the idle
 * cadence otherwise — self-stopping. The status badge (useCheck) AND the run-history LIST + per-run TRACE
 * (useRunHistory) all consume this ONE rule, so the three seams stay in lockstep through a run's lifecycle
 * instead of the list/trace lagging on a static interval.
 */
const RUN_ACTIVE_POLL_MS = 2500;
const IDLE_POLL_MS = 15_000;
const runAwareInterval = (active: boolean): number => (active ? RUN_ACTIVE_POLL_MS : IDLE_POLL_MS);

export function useCheck(id: number | null, opts: { expectRun?: boolean } = {}) {
  return useSWR(id ? keys.check(id) : null, () => getCheck(id as number), {
    ...live,
    // ★ Scoped live-refresh: poll FAST while the latest run is 'running', or right after a manual trigger
    // (expectRun) so the imminent run is caught as it goes running→done — then fall back to the normal idle
    // cadence once it settles. Never a perpetual fast loop: the fast tick only persists while there's an
    // in-flight/expected run. (refreshInterval as a function is re-evaluated each tick against the latest data.)
    refreshInterval: (latest) =>
      runAwareInterval(Boolean(opts.expectRun) || latest?.recent_runs?.[0]?.status === "running"),
  });
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
  // Run-aware live refresh:
  //  - live: externally "a run is in-flight/expected" (primed by Run now + the post-terminal settle window)
  //  - runningWhile: derive in-flight from the loaded items (the newest run's status === 'running')
  //  - revalidateFirstPage: see the SAFE DEFAULT below (= true). A new item on these lists ALWAYS lands on
  //    page 0; if page 0 isn't revalidated on the poll it stays stale until a manual reload. Opt OUT (false)
  //    only for a NON-newest-first list where page 0 never gains the freshest row.
  //  - debugLabel: when set AND the "runs" debug channel is on, emit the gated [runs-debug] funnel (poll-tick →
  //    page-0 fetch response) so a live-update failure shows exactly where the newest item falls out. Off-by-default.
  opts: {
    live?: boolean;
    runningWhile?: (items: T[]) => boolean;
    revalidateFirstPage?: boolean;
    debugLabel?: string;
  } = {},
) {
  const getKey = (index: number, prev: CursorPageData<T> | null) => {
    if (!scope) return null;
    if (prev && prev.nextCursor === null) return null; // window exhausted — stop requesting
    const cursor = index === 0 ? null : (prev?.nextCursor ?? null);
    return [...scope, pageSize, cursor] as const;
  };

  const swr = useSWRInfinite<CursorPageData<T>>(
    getKey,
    async (key) => {
      const cursor = (key[key.length - 1] as string | null) ?? null;
      const res = await fetchPage(cursor);
      // ★ Funnel stage (b): does page 0's RESPONSE contain the new item? If newestId here is the fresh run but
      //   it never reaches "post-merge"/"render", the fault is SWR merge (c), not the fetch.
      if (opts.debugLabel) {
        const newest = res.items[0] as Record<string, unknown> | undefined;
        runsDebug(`${opts.debugLabel}: page-${cursor === null ? "0" : "N"} fetch ← returned ${res.items.length}`, {
          cursor: cursor ?? "(page0/null)",
          returned: res.items.length,
          newestId: newest?.id ?? null,
          newestStatus: newest?.status ?? null,
          nextCursor: res.nextCursor,
        });
      }
      return res;
    },
    {
      // SHARED run-aware cadence (matches useCheck): fast while a run is live, idle otherwise.
      refreshInterval: (pages) => {
        const active = Boolean(opts.live) || (opts.runningWhile?.((pages ?? []).flatMap((p) => p.items)) ?? false);
        const interval = runAwareInterval(active);
        // ★ Funnel stage (a): is the poll even fast-firing? interval=2500 → live/active; 15000 → idle. If this
        //   stays 15000 right after a "Run now", runLive never engaged on this page.
        if (opts.debugLabel) {
          const newest = (pages ?? [])[0]?.items?.[0] as Record<string, unknown> | undefined;
          runsDebug(`${opts.debugLabel}: poll-tick (interval recompute) interval=${interval}`, {
            live: Boolean(opts.live),
            runningActive: active,
            intervalMs: interval,
            loadedPages: (pages ?? []).length,
            newestLoadedId: newest?.id ?? null,
          });
        }
        return interval;
      },
      revalidateOnFocus: true,
      // ★ SAFE DEFAULT = true. Every consumer here is a NEWEST-FIRST list, so a brand-new item (run #115,
      // incident #123, the live auto-expand #126) always lands on page 0 — page 0 MUST be revalidated on
      // each poll tick or the new item never shows until a manual reload. We hit that exact bug three times
      // because the old default was false (bug-biased). Default true so new list consumers are correct by
      // default; a rare non-newest-first list opts OUT with an explicit revalidateFirstPage:false + reason.
      revalidateFirstPage: opts.revalidateFirstPage ?? true,
      keepPreviousData: true,
    },
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
  // ★ live: externally "a run is in-flight/expected" (Run now + the post-terminal settle window), so the
  // list + trace ride the SAME poll-while-running lifecycle as the status badge — no manual refresh.
  opts: { live?: boolean; outcome?: RunOutcome } = {},
) {
  const outcome = opts.outcome ?? "all";
  const h = useCursorHistory<Run>(
    // ★ outcome is in the KEY → changing the filter starts a FRESH cursor walk (no stale cursor from the
    // unfiltered set paged against the filtered one — api #153 is server-side, so the page must be re-fetched).
    id ? ["run-history", id, range.from ?? null, range.to ?? null, outcome] : null,
    (cursor) =>
      getRuns(id as number, { pageSize, from: range.from, to: range.to, cursor: cursor ?? undefined, outcome }).then(
        (p) => ({ items: p.runs, nextCursor: p.next_cursor }),
      ),
    pageSize,
    {
      live: opts.live,
      runningWhile: (items) => items[0]?.status === "running", // self-fast-poll while the newest run runs
      // revalidateFirstPage inherits the safe default (true) — page 0 holds the newest run.
      debugLabel: "run-history", // gated [runs-debug] funnel (poll + page-0 fetch); see src/lib/debug.ts
    },
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
    // Live-refresh the alert surface: a brand-new incident — always page 0 — appears on the steady poll via
    // the safe-default revalidateFirstPage (true), instead of staying stale until a manual reload. No
    // runLive/runningWhile here: incidents have no in-flight "running" signal (one can open from any scheduled
    // run at any time), so the STEADY idle poll (+ revalidateOnFocus) is the right trigger, not a fast poll.
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

export function useRunSteps(runId: number | null, live = false) {
  return useSWR(runId ? keys.steps(runId) : null, () => getSteps(runId as number), {
    // Ride the SAME fast cadence #108 uses for the run status: poll while the run is in flight so the
    // step checklist advances live (running → pass/fail); 0 = no auto-refresh once it's terminal/static.
    refreshInterval: live ? RUN_ACTIVE_POLL_MS : 0,
  });
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

/** The cached runtime-spec identity (commit SHA + fetched-at) for a Git-managed check — read-only observability. */
export function useSpecCache(id: number | null) {
  return useSWR(
    id ? keys.specCache(id) : null,
    () => getSpecCache(id as number),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
}

/** The error diff for a check's latest settled run (or `runId`) vs its last-N baseline. */
export function useErrorDiff(id: number | null, runId?: number | null) {
  return useSWR(
    id ? keys.errorDiff(id, runId ?? null) : null,
    () => getErrorDiff(id as number, runId != null ? { runId } : {}),
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

// "Reconcile now": POST → 202 { triggered }; the off-cron job re-syncs the drift snapshot (detected_at advances).
export { triggerReconcile, approveReconcilePlan, rejectReconcilePlan, applyReconcilePlans };

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
// The report aggregates take the SAME multi-select tag filter as the monitor list. The selected tags go into
// the SWR key (sorted → stable regardless of selection order) so the tiles REFETCH tag-scoped when it changes;
// empty tags → no ?tag= → whole fleet (the no-op default).
const tagKey = (tags: Tag[]) => tags.map((t) => `${t.key}:${t.value}`).sort().join(",");

export function useAvailabilityReport(window: ReportWindow, groupBy: string, tags: Tag[] = []) {
  return useSWR(keys.availabilityReport(window, groupBy, tagKey(tags)), () => getAvailabilityReport(window, groupBy, tags), {
    // fetch-once aggregate (no poll). revalidateOnFocus + a "fetched HH:MM" stamp + manual refresh (see panel)
    // — #178's regime, extended so the /reports page has ONE freshness story, not two.
    revalidateOnFocus: true,
    shouldRetryOnError: false,
  });
}

export function usePerformanceReport(window: ReportWindow, groupBy: string, tags: Tag[] = []) {
  return useSWR(keys.performanceReport(window, groupBy, tagKey(tags)), () => getPerformanceReport(window, groupBy, tags), {
    // fetch-once aggregate (no poll). revalidateOnFocus + stamp + manual refresh (see panel) — #178 regime.
    revalidateOnFocus: true,
    shouldRetryOnError: false,
  });
}

export function useIncidentBreakdown(window: ReportWindow, tags: Tag[] = []) {
  return useSWR(keys.incidentBreakdown(window, tagKey(tags)), () => getIncidentBreakdown(window, tags), {
    // fetch-once aggregate (no poll). revalidateOnFocus + stamp + manual refresh (see card) — #178 regime.
    revalidateOnFocus: true,
    shouldRetryOnError: false,
  });
}

export function useSloReport(window: ReportWindow, tags: Tag[] = []) {
  return useSWR(keys.sloReport(window, tagKey(tags)), () => getSloReport(window, tags), {
    // fetch-once aggregate (no poll — an expensive SLO rollup). revalidateOnFocus refreshes on tab-return; the
    // panel also shows a "fetched HH:MM" stamp + manual refresh so staleness is visible between focuses.
    revalidateOnFocus: true,
    shouldRetryOnError: false,
  });
}

// Fleet cost report — fetch-once aggregate (the API caches 60s; recomputes from live runs). Shared key so the
// overview summary and every monitor-detail cost panel dedupe onto one fetch.
export function useCostReport() {
  return useSWR(keys.costReport(), () => getCostReport(), {
    revalidateOnFocus: true,
    shouldRetryOnError: false,
  });
}

export function useDeploys(host: string | null, window: ReportWindow = "30d") {
  return useSWR(host ? keys.deploys(host, window) : null, () => getDeploys(host as string, window), {
    // fetch-once overlay data (no poll). revalidateOnFocus so a tab left open picks up new deploy markers on
    // return — the chart carries a caption, not a stamp (an overlay, not a panel; see charts.tsx).
    revalidateOnFocus: true,
    shouldRetryOnError: false,
  });
}

// Egress soak (GET /reports/egress). A live SNAT-rotation monitor → a gentle poll so a rotation surfaces
// without a reload. 404 → null (self-hide); never retried on error.
export function useEgress(window: EgressWindow = "all") {
  return useSWR(keys.egress(window), () => getEgressReport(window), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
    refreshInterval: 60000,
  });
}

// Region health (GET /reports/region-health, api #168 — the F-4 pair). A LIVE alarm for a silently-dead
// region, so it polls on the egress cadence (the /status regional-ops precedent) — a region going stale
// must surface without a reload. Polling panel → no staleness stamp (the #178 rule). 404 → null (self-hide).
export function useRegionHealth() {
  return useSWR(keys.regionHealth(), () => getRegionHealth(), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
    refreshInterval: 60000,
  });
}

// §D1 monitor-trust scorecard. 404 → null (self-hide). No poll — trust is a slow-moving audit view.
export function useTrustReport(window: ReportWindow = "30d") {
  return useSWR(keys.trust(window), () => getTrustReport(window), {
    // fetch-once audit view (no poll). ★ Was the LEAST-fresh surface in the app — now revalidates on focus +
    // shows a "fetched HH:MM" stamp + manual refresh so a tab left open doesn't silently show hour-old trust.
    revalidateOnFocus: true,
    shouldRetryOnError: false,
  });
}

export function useTrustDetail(checkId: number | null, window: ReportWindow = "30d") {
  return useSWR(
    checkId ? keys.trustDetail(checkId, window) : null,
    () => getTrustDetail(checkId as number, window),
    { revalidateOnFocus: true, shouldRetryOnError: false },
  );
}

export function useStatus() {
  return useSWR(keys.status(), () => getStatus(), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
    refreshInterval: 15000, // current state moves run-to-run — a gentle poll like the status grid
  });
}

export function useMttrReport(window: ReportWindow, tags: Tag[] = []) {
  return useSWR(keys.mttrReport(window, tagKey(tags)), () => getMttrReport(window, tags), {
    // fetch-once aggregate (no poll). revalidateOnFocus + a "fetched HH:MM" stamp + manual refresh (see panel).
    revalidateOnFocus: true,
    shouldRetryOnError: false,
  });
}

// AI narrative (Layer 3). shouldRetryOnError:false → a 404 (not enabled/generated) leaves
// data undefined and the card hides, never a retry loop or an error box.
export function useNarrative(scope: "fleet" | "monitor", window: ReportWindow, key: number | null = null) {
  return useSWR(
    keys.narrative(scope, window, key),
    () => getNarrative(scope, window, scope === "monitor" ? (key ?? undefined) : undefined),
    // fetch-once aggregate (no poll). revalidateOnFocus + stamp + manual refresh (see card) — #178 regime.
    { revalidateOnFocus: true, shouldRetryOnError: false },
  );
}

// Monitors-as-code drift (Phase 6b). shouldRetryOnError:false → a 404 (endpoint not deployed) leaves
// data null and the surface hides; an empty items array (reconcile ran, in sync) still renders the
// positive "in sync with Git" state. Read-only — there is no write/apply hook (apply is a later runner
// capability; reconcile runs in report mode).
export function useReconcileDrift(opts: { reconciling?: boolean } = {}) {
  return useSWR(keys.reconcileDrift, () => getReconcileDrift(), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
    // While a manual "Reconcile now" is in flight, fast-poll so the off-cron job's fresh snapshot (detected_at
    // advanced) is caught within seconds — the same scoped-fast-poll idea as useCheck's expectRun. Idle (no
    // auto-poll) otherwise: reconcile is hourly, the read is cheap-but-not-free, and the surface is read-only.
    refreshInterval: opts.reconciling ? 3000 : 0,
  });
}

// The DRY-RUN apply plan per drift (reconcile-apply Phase 0). Read-only preview alongside the drift list —
// nothing is applied or approved this phase. Same poll cadence as the drift hook (fresh after a reconcile).
export function useReconcilePlan(opts: { reconciling?: boolean } = {}) {
  return useSWR(keys.reconcilePlan, () => getReconcilePlan(), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
    refreshInterval: opts.reconciling ? 3000 : 0,
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

/** Dismiss a pending access request, then refresh the list. */
export async function dismissAccessRequest(email: string) {
  await apiDismissAccessRequest(email);
  await globalMutate(keys.accessRequests);
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

/** env PR-3: set/clear a check's env override (null = clear → revert to the derived env), then refresh caches. */
export async function setEnvironmentOverride(id: number, environmentOverride: EnvValue | null) {
  const result = await apiSetEnvironmentOverride(id, environmentOverride);
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
