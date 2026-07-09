"use client";

import { Suspense, useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { useChecks, useSla, useTags, useCostReport } from "@/lib/client";
import { CheckCard } from "@/components/check-card";
import { costEstimateLabel } from "@/components/cost";
import { FleetSlaSummary } from "@/components/sla";
import { TagFilter, useTagFilter, matchesTags } from "@/components/tag-filter";
import { EmptyState, ErrorState, Spinner } from "@/components/states";
import { MonitorChatInput } from "@/components/monitor-chat-input";
import { useCreateMonitor, CreateMonitorModal } from "@/components/create-monitor";
import { useAuth } from "@/components/auth-provider";
import type { CheckWithStatus, Tag } from "@/lib/types";

type StatusFilter = "all" | "attention" | "pass" | "paused";
type KindFilter = "all" | "http" | "browser" | "ssl";
type EnvFilter = "all" | "prod" | "nonprod";

/** Env facet from the authoritative checks.environment column (not the env: tag). */
const isNonProd = (check: CheckWithStatus) => (check.environment ?? "prod") !== "prod";

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
        check.open_incident_count > 0 ||
        check.current_status === "fail" ||
        check.current_status === "error" ||
        check.current_status === "warn"
      );
    case "pass":
      return check.enabled && check.current_status === "pass";
    case "paused":
      return !check.enabled;
    default:
      return true;
  }
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

  // Per-check projected $/mo from /reports/cost (no per-card compute, no API change — recon 2026-07-08).
  const costByCheck = useMemo(() => {
    const map = new Map<number, number>();
    for (const c of costReport?.checks ?? []) map.set(c.check_id, c.projected_monthly);
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

      {/* ★ Make an active filter OBVIOUS: a clear "showing N of M" whenever the list is a subset (any filter).
          The fleet SLA summary above stays WHOLE-fleet on purpose (it's a fleet metric, not a filtered view). */}
      {data && filtered.length !== data.length && (
        <p className="text-[11px] text-[var(--color-ink-faint)]" data-testid="filter-count">
          Showing {filtered.length} of {data.length} monitors
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
                projectedCost={costByCheck.get(c.id) ?? null}
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
