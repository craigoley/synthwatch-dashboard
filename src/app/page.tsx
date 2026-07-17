"use client";

import { Suspense, useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { useChecks, useSla, useTags, useCostReport, useIncidents } from "@/lib/client";
import { isWithinHours } from "@/lib/format";
import { CheckCard } from "@/components/check-card";
import { costEstimateLabel } from "@/components/cost";
import { FleetSlaSummary } from "@/components/sla";
import { TagFilter, useTagFilter, matchesTags } from "@/components/tag-filter";
import { EmptyState, ErrorState, Spinner } from "@/components/states";
import { MonitorChatInput } from "@/components/monitor-chat-input";
import { useCreateMonitor, CreateMonitorModal } from "@/components/create-monitor";
import { useAuth } from "@/components/auth-provider";
import type { CheckWithStatus, Tag } from "@/lib/types";
import { isNonProd } from "@/lib/env";

type StatusFilter = "all" | "attention" | "pass" | "paused" | "archived" | "removed";
type KindFilter = "all" | "http" | "browser" | "ssl";
type EnvFilter = "all" | "prod" | "nonprod";

function matches(
  check: CheckWithStatus,
  status: StatusFilter,
  kind: KindFilter,
  q: string,
  tags: Tag[],
  env: EnvFilter,
): boolean {
  if (kind !== "all" && check.kind !== kind) return false;
  if (env === "prod" && isNonProd(check)) return false;
  if (env === "nonprod" && !isNonProd(check)) return false;
  if (!matchesTags(check.tags, tags)) return false; // AND across selected tags (reuses the shared logic)
  if (q && !`${check.name} ${check.flow_name ?? ""} ${check.target_url ?? ""}`.toLowerCase().includes(q))
    return false;
  switch (status) {
    case "attention":
      return (
        !check.archived_at && // an archived monitor doesn't run → never demands attention
        !check.removed_at && // nor does a git-removed one (on the purge clock)
        (check.open_incident_count > 0 ||
          check.current_status === "fail" ||
          check.current_status === "error" ||
          check.current_status === "warn")
      );
    case "pass":
      return !check.archived_at && !check.removed_at && check.enabled && check.current_status === "pass";
    case "paused":
      // Archived + removed are distinct states (their own tabs) — neither is counted as paused.
      return !check.archived_at && !check.removed_at && !check.enabled;
    case "archived":
      // Removed supersedes archived — a git-removed check shows under Removed, not Archived.
      return check.archived_at != null && !check.removed_at;
    case "removed":
      return check.removed_at != null;
    default:
      // ★ "All" is the OPERATIONAL view — archived (= deliberately retired, 0071) monitors are excluded by
      // default and OPT-IN via the Archived tab above: a retired check rendering a full live-looking card
      // between healthy ones reads as a monitor mid-warmup, not one that will never run again. Removed
      // (purge-clock) checks stay visible — EVEN IF also archived — their loud state is a call to action
      // before the purge (removed supersedes archived, same precedence as the Archived tab above).
      return check.removed_at != null || check.archived_at == null;
  }
}

/**
 * ★ The banner is a "what needs me NOW" surface, so a recency window on the resolved count is deliberate —
 * unlike the check page (MonitorIncidentLink), which links to a check's most-recent incident at ANY age and
 * lets the operator judge relevance. One on-call rotation ≈ 24h: an incident that resolved overnight is still
 * worth a glance at the start of a shift, but a week-old one is history and belongs on /incidents, not nagging
 * the status header forever. Named, not a bare literal, so the choice is auditable. (from #282 24h-cliff audit)
 */
const RESOLVED_BANNER_WINDOW_HOURS = 24;

/**
 * ★ 2am routing banner. Surfaces OPEN incidents and any resolved within the on-call window above, linking to the
 * Incidents page (the root-cause surface). Self-hides when there's nothing — no clutter on a quiet fleet. Counts
 * only, no verdict (the RCA lives on the Incidents page; it isn't promoted here — the classifier is unproven).
 */
function IncidentBanner() {
  const { data } = useIncidents();
  const open = data?.open ?? [];
  const recentResolved = (data?.resolved ?? []).filter((i) =>
    isWithinHours(i.resolved_at, RESOLVED_BANNER_WINDOW_HOURS),
  );
  if (open.length === 0 && recentResolved.length === 0) return null;
  const isOpen = open.length > 0;
  const tone = isOpen ? "var(--color-fail)" : "var(--color-ink-dim)";
  return (
    <Link
      href="/incidents"
      data-testid="status-incident-banner"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-4 py-2.5 text-sm transition hover:bg-[var(--color-panel-2)]"
      style={{
        borderColor: isOpen ? "color-mix(in srgb, var(--color-fail) 34%, transparent)" : "var(--color-border)",
        background: isOpen ? "color-mix(in srgb, var(--color-fail) 8%, transparent)" : undefined,
      }}
    >
      <span aria-hidden style={{ color: tone }}>⚠</span>
      {open.length > 0 && (
        <span className="font-medium" style={{ color: "var(--color-fail)" }}>
          {open.length} open incident{open.length === 1 ? "" : "s"}
        </span>
      )}
      {open.length > 0 && recentResolved.length > 0 && <span className="text-[var(--color-ink-faint)]">·</span>}
      {recentResolved.length > 0 && (
        <span className="text-[var(--color-ink-dim)]">
          {recentResolved.length} resolved in the last 24h
        </span>
      )}
      <span className="ml-auto text-[var(--color-brand)]">View incidents →</span>
    </Link>
  );
}

function FilterTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
        active
          ? "bg-[var(--color-panel-2)] text-[var(--color-ink)]"
          : "text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
      }`}
    >
      {children}
    </button>
  );
}

function StatusGrid() {
  const router = useRouter();
  const params = useSearchParams();
  const { data, error, isLoading } = useChecks();
  const { data: sla24h } = useSla("24h");
  const { data: costReport } = useCostReport(); // one shared fetch; each card reads its own projected cost

  // 24h availability per check, for the small badge on each card.
  const availabilityByCheck = useMemo(() => {
    const map = new Map<number, { pct: number | null; insufficient: boolean }>();
    for (const row of sla24h?.items ?? [])
      map.set(row.check_id, { pct: row.availability_pct, insufficient: row.insufficient_data });
    return map;
  }, [sla24h]);

  // Per-check $ estimate (0091) from /reports/cost — the card shows the dollar only. The compute-share %
  // (0089) is intentionally NOT on the card: it's fleet-relative and lives on the detail page + Reports > Cost.
  const costByCheck = useMemo(() => {
    const map = new Map<number, number | null>();
    for (const c of costReport?.checks ?? []) map.set(c.check_id, c.estimated_monthly);
    return map;
  }, [costReport]);
  const costLabel = costReport ? costEstimateLabel(costReport) : undefined;

  const status = (params.get("status") as StatusFilter) || "all";
  const kind = (params.get("kind") as KindFilter) || "all";
  const env = (params.get("env") as EnvFilter) || "all";
  const q = (params.get("q") || "").toLowerCase();
  // Tags reuse the shared useTagFilter (useState + history.replaceState, same `?tags=env:prod` format as the
  // /monitors + /reports filters). Its clear() resets via state — reliable, unlike router.replace("/") which
  // is a no-op when it would empty the query. status/kind/q stay on useSearchParams below.
  const { selected: selectedTags, toggle: toggleTag, clear: clearTags } = useTagFilter();
  const { data: inUseTags } = useTags();
  const { canWrite } = useAuth();
  // Shared create surface (same hook/modal/chat-input as the Monitors page) — the chat-prefill is literally the
  // same component here, not a copy. Editor-gated; viewers keep the link to /monitors.
  const create = useCreateMonitor();

  const setParam = (key: string, value: string) => {
    // Read the LIVE url (window.location), not useSearchParams: that way a status/kind/q change preserves the
    // ?tags the useTagFilter set via history.replaceState (which useSearchParams doesn't observe).
    const next = new URLSearchParams(window.location.search);
    if (!value || value === "all") next.delete(key);
    else next.set(key, value);
    const qs = next.toString();
    router.replace(qs ? `/?${qs}` : "/", { scroll: false });
  };

  const filtered = useMemo(
    () => (data ?? []).filter((c) => matches(c, status, kind, q, selectedTags, env)),
    [data, status, kind, q, selectedTags, env],
  );
  // ★ The "N of M" DENOMINATOR is the CURRENT tab's universe (the status filter alone), NOT the whole fleet.
  // useChecks() returns archived + removed rows too (the Archived/Removed tabs read them), so `data.length`
  // counts monitors the default "All" view structurally excludes (archived is opt-in via its own tab). With
  // the fleet as the denominator, an UNFILTERED "All" view read "Showing 34 of 37" — implying an active
  // filter when none is set, and leaking 3 archived rows the view can't show. This is the archived-leak class
  // (cost_projection / narrative / availability / incident-breakdown): the count and the list must agree on
  // what "a monitor" is. Using the same `matches()` predicate the grid uses — with the OTHER facets off —
  // makes M = "monitors in THIS tab", so N === M on an unfiltered tab (the line hides) and "N of M" appears
  // only when a real facet (kind / env / search / tag) narrows the list.
  const statusUniverse = useMemo(
    () => (data ?? []).filter((c) => matches(c, status, "all", "", [], "all")),
    [data, status],
  );
  // The env facet only appears when the fleet actually HAS a non-prod check — a pure-prod fleet's grid is
  // visually unchanged (no extra control). Env is the authoritative column, never the user-mutable env: tag.
  const hasNonProd = useMemo(() => (data ?? []).some(isNonProd), [data]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="sw-eyebrow">Fleet status</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Monitors</h1>
        </div>
        {/* Editors get the in-place create surface (same as /monitors); viewers keep the link there. */}
        {canWrite ? (
          <button onClick={create.openBlank} className="sw-btn sw-btn-primary">
            + New monitor
          </button>
        ) : (
          <Link href="/monitors" className="sw-btn sw-btn-primary">
            + New monitor
          </Link>
        )}
      </header>

      {/* ★ 2am routing: when the grid is all-green after a resolved incident, "Needs attention" is empty and the
          grid is a dead end. This banner surfaces OPEN + recently-resolved incidents and routes to the
          Incidents page (which carries the root cause), so a paged operator isn't stranded. */}
      <IncidentBanner />

      {/* Chat-to-prefill — the SAME shared describe-input as /monitors; parse → seed the create modal (editor-only). */}
      {canWrite && <MonitorChatInput onPrefill={create.openPrefilled} />}

      <FleetSlaSummary />

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-0.5">
          <FilterTab active={status === "all"} onClick={() => setParam("status", "all")}>
            All
          </FilterTab>
          <FilterTab active={status === "attention"} onClick={() => setParam("status", "attention")}>
            Needs attention
          </FilterTab>
          <FilterTab active={status === "pass"} onClick={() => setParam("status", "pass")}>
            Passing
          </FilterTab>
          <FilterTab active={status === "paused"} onClick={() => setParam("status", "paused")}>
            Paused
          </FilterTab>
          <FilterTab active={status === "archived"} onClick={() => setParam("status", "archived")}>
            Archived
          </FilterTab>
          <FilterTab active={status === "removed"} onClick={() => setParam("status", "removed")}>
            Removed
          </FilterTab>
        </div>
        <div className="flex rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-0.5">
          <FilterTab active={kind === "all"} onClick={() => setParam("kind", "all")}>
            Any
          </FilterTab>
          <FilterTab active={kind === "http"} onClick={() => setParam("kind", "http")}>
            HTTP
          </FilterTab>
          <FilterTab active={kind === "browser"} onClick={() => setParam("kind", "browser")}>
            Browser
          </FilterTab>
          <FilterTab active={kind === "ssl"} onClick={() => setParam("kind", "ssl")}>
            SSL
          </FilterTab>
        </div>
        {/* Env facet — only when a non-prod check exists (a pure-prod fleet sees no extra control). */}
        {hasNonProd && (
          <div className="flex rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-0.5" data-testid="env-filter">
            <FilterTab active={env === "all"} onClick={() => setParam("env", "all")}>
              All envs
            </FilterTab>
            <FilterTab active={env === "prod"} onClick={() => setParam("env", "prod")}>
              Prod
            </FilterTab>
            <FilterTab active={env === "nonprod"} onClick={() => setParam("env", "nonprod")}>
              Non-prod
            </FilterTab>
          </div>
        )}
        <input
          className="sw-input sm:max-w-xs"
          placeholder="Search name, url, flow…"
          defaultValue={q}
          onChange={(e) => setParam("q", e.target.value)}
        />
      </div>

      {/* Tag filter — multi-select AND, URL-synced (?tags=env:prod). Reuses the shared TagFilter component
          (rows carry {key,value} Tag[], unlike the catalog's bare strings). Renders nothing until tags exist. */}
      <TagFilter
        available={inUseTags ?? []}
        selected={selectedTags}
        onToggle={toggleTag}
        onClear={clearTags}
      />

      {/* ★ Make an active filter OBVIOUS: a clear "showing N of M" whenever a facet narrows THIS tab. M is the
          current tab's universe (statusUniverse), not the whole fleet — so an unfiltered tab shows nothing
          (N === M) instead of the archived-leak "34 of 37". The fleet SLA summary above stays WHOLE-fleet on
          purpose (it's a fleet metric, not a filtered view). */}
      {filtered.length !== statusUniverse.length && (
        <p className="text-[11px] text-[var(--color-ink-faint)]" data-testid="filter-count">
          Showing {filtered.length} of {statusUniverse.length} monitors
        </p>
      )}

      {isLoading && !data ? (
        <div className="py-16">
          <Spinner label="Loading monitors…" />
        </div>
      ) : error ? (
        <ErrorState message={error instanceof Error ? error.message : "Failed to load checks."} />
      ) : filtered.length === 0 ? (
        <EmptyState
          title={data && data.length > 0 ? "No monitors match these filters." : "No monitors yet."}
          hint={
            data && data.length > 0
              ? "Try clearing the filters above."
              : "Create your first monitor to start watching."
          }
          action={
            canWrite ? (
              <button onClick={create.openBlank} className="sw-btn sw-btn-primary">
                + New monitor
              </button>
            ) : (
              <Link href="/monitors" className="sw-btn sw-btn-primary">
                + New monitor
              </Link>
            )
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((c) => {
            const sla = availabilityByCheck.get(c.id);
            return (
              <CheckCard
                key={c.id}
                check={c}
                availability={sla?.pct ?? null}
                availabilityInsufficient={sla?.insufficient ?? false}
                estimatedMonthly={costByCheck.get(c.id) ?? null}
                costEstimateLabel={costLabel}
              />
            );
          })}
        </div>
      )}

      {/* The shared create modal (blank or chat-prefilled) — same component as /monitors; opens only when creating. */}
      <CreateMonitorModal {...create.modal} />
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={<Spinner label="Loading…" />}>
      <StatusGrid />
    </Suspense>
  );
}
