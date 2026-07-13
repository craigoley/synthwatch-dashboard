"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useChecks } from "@/lib/client";
import { useAuth } from "@/components/auth-provider";

const NAV: { href: string; label: string; match: (p: string) => boolean; adminOnly?: boolean }[] = [
  { href: "/", label: "Status", match: (p: string) => p === "/" || p.startsWith("/checks") },
  { href: "/incidents", label: "Incidents", match: (p: string) => p.startsWith("/incidents") },
  { href: "/monitors", label: "Monitors", match: (p: string) => p.startsWith("/monitors") },
  { href: "/specs", label: "Catalog", match: (p: string) => p.startsWith("/specs") },
  { href: "/notifications", label: "Notifications", match: (p: string) => p.startsWith("/notifications") },
  { href: "/reports", label: "Reports", match: (p: string) => p.startsWith("/reports") || p.startsWith("/trust") },
  { href: "/settings/environments", label: "Environments", match: (p: string) => p.startsWith("/settings/environments") },
  // Admin-only. Hiding it is UX; /api/editors is admin-gated server-side regardless (the real boundary).
  { href: "/users", label: "Users", match: (p: string) => p.startsWith("/users"), adminOnly: true },
];

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9.5" stroke="var(--color-brand)" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="2.4" fill="var(--color-brand)" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" stroke="var(--color-brand)" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M12 12l4.7-2.7" stroke="var(--color-brand)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Live fleet summary shown in the header. */
function FleetPulse() {
  const { data, isLoading } = useChecks();

  if (isLoading || !data) {
    return <span className="sw-mono text-xs text-[var(--color-ink-faint)]">syncing…</span>;
  }

  // ★ Archived monitors never count in the header pulse. Today the api's 0071 projection masks their
  // current_status to "archived" (matching no bucket below), but the exclusion must be structural, not an
  // artifact of that projection — a retired monitor's stale fail/pass must never move the fleet counts.
  const enabled = data.filter((c) => c.enabled && !c.archived_at);
  const failing = enabled.filter(
    (c) => c.current_status === "fail" || c.current_status === "error",
  ).length;
  const warning = enabled.filter((c) => c.current_status === "warn").length;
  const passing = enabled.filter((c) => c.current_status === "pass").length;

  const items = [
    { n: failing, cls: "sw-dot-fail", color: "var(--color-fail)" },
    { n: warning, cls: "sw-dot-warn", color: "var(--color-warn)" },
    { n: passing, cls: "sw-dot-pass", color: "var(--color-pass)" },
  ];

  return (
    <div className="flex items-center gap-3" aria-label="fleet status summary">
      {items.map((it, i) => (
        <span key={i} className="flex items-center gap-1.5">
          <span className={`sw-dot ${it.cls}`} />
          <span className="sw-mono text-xs" style={{ color: it.color }}>
            {it.n}
          </span>
        </span>
      ))}
    </div>
  );
}

/** Sign-in / account control in the header. Reflects the live session (read-only-by-default cue). */
function AccountControl() {
  const { isAuthed, email, role, isAdmin, promptLogin, signOut } = useAuth();

  if (!isAuthed) {
    return (
      <button type="button" onClick={promptLogin} className="sw-btn sw-btn-sm" data-testid="sign-in">
        Sign in to edit
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2" data-testid="account">
      <span className="hidden flex-col items-end leading-tight sm:flex">
        <span className="sw-mono max-w-[160px] truncate text-[11px] text-[var(--color-ink-dim)]" title={email ?? ""}>
          {email}
        </span>
        <span
          className="sw-mono text-[9px] uppercase tracking-wider"
          style={{ color: isAdmin ? "var(--color-brand)" : "var(--color-ink-faint)" }}
          data-testid="account-role"
        >
          {role}
        </span>
      </span>
      <button type="button" onClick={() => void signOut()} className="sw-btn sw-btn-ghost sw-btn-sm" data-testid="sign-out">
        Sign out
      </button>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  const { isAdmin } = useAuth();

  // The public status page is stakeholder-facing — it brings its own clean chrome
  // and must not show the operator nav / fleet pulse.
  if (pathname.startsWith("/status")) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-bg)_82%,transparent)] backdrop-blur-md">
        {/* Mobile AND tablet: wraps to two rows — logo + fleet pulse on row 1, the full nav on row 2 (so
            every tab stays tappable). The single h-14 row engages at xl: — MEASURED: seven nav items +
            logo + the right cluster only fit one row from ~1150px (at lg/1024 the row still overflows
            112px), so the nowrap transition sits at xl (1280), not sm. */}
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6 xl:h-14 xl:flex-nowrap xl:py-0">
          <Link href="/" className="flex shrink-0 items-center gap-2.5">
            <Logo />
            <span className="flex flex-col leading-none">
              <span className="text-[15px] font-semibold tracking-tight">
                Synth<span className="text-[var(--color-brand)]">Watch</span>
              </span>
              <span className="sw-mono text-[9px] tracking-[0.2em] text-[var(--color-ink-faint)]">
                SYNTHETIC MONITOR
              </span>
            </span>
          </Link>

          {/* ★ MOBILE + TABLET: the nav WRAPS instead of scrolling. The old overflow-x-auto clipped items
              at the viewport edge with no fade/chevron/any affordance ("Catalog" rendered as "atalog") —
              hidden navigation, the same failure #253 fixed on the Reports sub-tabs. Wrapping means every
              item is always visible. The inline single-row form engages at xl: alongside the container's
              h-14 row (see above — one row only fits from ~1150px; sm: left a 640–1150px band where the
              nowrap row overflowed with no recovery, #254's review catch). */}
          <nav className="order-last w-full flex flex-wrap items-center gap-1 xl:order-none xl:ml-2 xl:w-auto xl:flex-nowrap">
            {NAV.filter((item) => !item.adminOnly || isAdmin).map((item) => {
              const active = item.match(pathname);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`sw-nav shrink-0 whitespace-nowrap ${active ? "sw-nav-active" : ""}`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-4">
            <FleetPulse />
            <span className="hidden items-center gap-1.5 sm:flex">
              <span className="sw-dot sw-dot-running" />
              <span className="sw-mono text-[10px] tracking-wider text-[var(--color-ink-faint)]">
                LIVE
              </span>
            </span>
            <AccountControl />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}
