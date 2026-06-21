"use client";

import { Suspense, useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { useChecks } from "@/lib/client";
import { CheckCard } from "@/components/check-card";
import { EmptyState, ErrorState, Spinner } from "@/components/states";
import type { CheckWithStatus } from "@/lib/types";

type StatusFilter = "all" | "attention" | "pass" | "paused";
type KindFilter = "all" | "http" | "browser";

function matches(check: CheckWithStatus, status: StatusFilter, kind: KindFilter, q: string): boolean {
  if (kind !== "all" && check.kind !== kind) return false;
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

  const status = (params.get("status") as StatusFilter) || "all";
  const kind = (params.get("kind") as KindFilter) || "all";
  const q = (params.get("q") || "").toLowerCase();

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (!value || value === "all") next.delete(key);
    else next.set(key, value);
    router.replace(next.toString() ? `/?${next.toString()}` : "/", { scroll: false });
  };

  const filtered = useMemo(
    () => (data ?? []).filter((c) => matches(c, status, kind, q)),
    [data, status, kind, q],
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="sw-eyebrow">Fleet status</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Monitors</h1>
        </div>
        <Link href="/monitors" className="sw-btn sw-btn-primary">
          + New monitor
        </Link>
      </header>

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
        </div>
        <input
          className="sw-input sm:max-w-xs"
          placeholder="Search name, url, flow…"
          defaultValue={q}
          onChange={(e) => setParam("q", e.target.value)}
        />
      </div>

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
            <Link href="/monitors" className="sw-btn sw-btn-primary">
              + New monitor
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((c) => (
            <CheckCard key={c.id} check={c} />
          ))}
        </div>
      )}
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
