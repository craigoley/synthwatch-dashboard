import Link from "next/link";

/**
 * App-level 404 — Next renders this (inside the root layout, so nav/theme survive) for any
 * unknown route. Before this file existed, unknown URLs got Next's unstyled default: off-brand
 * and link-free, a dead end for a mistyped/stale link (handoff-era polish).
 */
export default function NotFound() {
  return (
    <div className="flex flex-col items-start gap-4 py-16">
      <p className="sw-eyebrow">404</p>
      <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-ink)]">
        This page doesn&apos;t exist.
      </h1>
      <p className="max-w-md text-sm text-[var(--color-ink-dim)]">
        The link may be stale — monitors and incidents can be deleted or renumbered. The fleet
        grid and incident list below are always current.
      </p>
      <div className="flex flex-wrap gap-3">
        <Link href="/" className="sw-btn sw-btn-primary">
          Fleet grid
        </Link>
        <Link href="/incidents" className="sw-btn">
          Incidents
        </Link>
        <Link href="/status" className="sw-btn">
          Status
        </Link>
      </div>
    </div>
  );
}
