"use client";

/**
 * Read-only-by-default UX helpers (Phase 12 slice 3). A signed-out / read-only viewer sees a calm
 * "sign in to edit" banner and the write affordances are hidden by the pages (gated on useAuth().canWrite).
 *
 * ★ This is UX, NOT the security boundary. The API (slice 2's gate) enforces the real rule — a request
 * without a valid editor/admin session is denied server-side regardless of what the dashboard renders.
 */

import { useAuth } from "@/components/auth-provider";

/**
 * Shown atop a write-capable page when the viewer can't write. Hidden entirely for editors/admins.
 * While the initial /auth/me refresh is in flight we render nothing (avoid a flash of the banner for a
 * viewer who turns out to be signed in).
 */
export function SignInToEdit() {
  const { canWrite, isAuthed, loading, promptLogin } = useAuth();
  if (canWrite || loading) return null;

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm"
      style={{
        background: "color-mix(in srgb, var(--color-brand) 8%, var(--color-panel))",
        border: "1px solid color-mix(in srgb, var(--color-brand) 28%, var(--color-border))",
      }}
      data-testid="sign-in-to-edit"
    >
      <span className="text-[var(--color-ink-dim)]">
        {isAuthed
          ? "Your account is read-only — ask an admin for edit access."
          : "You're viewing in read-only mode. Sign in to create, edit, or pause monitors."}
      </span>
      {!isAuthed && (
        <button type="button" onClick={promptLogin} className="sw-btn sw-btn-primary sw-btn-sm">
          Sign in to edit
        </button>
      )}
    </div>
  );
}

/**
 * Shown in place of a panel whose READ is session-gated by the API (read-gate sweep: /reconcile/*,
 * /channels, …) when the viewer has no session (the GET 401'd without a bearer). Distinct from an
 * error: the data is fine, the viewer just isn't signed in — so it renders calm brand-tinted copy
 * with a sign-in affordance, never a red ErrorState and never an auto-popped modal.
 */
export function SignInToView({ what, testId }: { what: string; testId?: string }) {
  const { promptLogin } = useAuth();

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm"
      style={{
        background: "color-mix(in srgb, var(--color-brand) 8%, var(--color-panel))",
        border: "1px solid color-mix(in srgb, var(--color-brand) 28%, var(--color-border))",
      }}
      data-testid={testId ?? "sign-in-to-view"}
    >
      <span className="text-[var(--color-ink-dim)]">Sign in to view {what}.</span>
      <button type="button" onClick={promptLogin} className="sw-btn sw-btn-primary sw-btn-sm">
        Sign in
      </button>
    </div>
  );
}
