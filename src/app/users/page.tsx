"use client";

/**
 * Admin-only user management (Phase 12 slice 3). Lists the editor allowlist, adds/removes editors, and
 * surfaces pending edit-access requests so an admin can act on them. ★ Hiding this for non-admins is UX
 * only — /api/editors is admin-gated server-side (the real boundary); a non-admin who reaches this page
 * sees the gate's 403, never the data.
 */

import { useState } from "react";

import { useAuth } from "@/components/auth-provider";
import { useEditors, useAccessRequests, addEditor, removeEditor } from "@/lib/client";
import { ApiRequestError } from "@/lib/api-client";
import { EmptyState, ErrorState, Spinner } from "@/components/states";
import { formatRelative } from "@/lib/format";

export default function UsersPage() {
  const { isAdmin, isAuthed, promptLogin } = useAuth();
  const editorsQ = useEditors(isAdmin);
  const requestsQ = useAccessRequests(isAdmin);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function add(target: string) {
    const e = target.trim();
    if (!e) return;
    setBusy(e);
    setError(null);
    try {
      await addEditor(e);
      setEmail("");
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not add editor.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(target: string) {
    setBusy(target);
    setError(null);
    try {
      await removeEditor(target);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not remove editor.");
    } finally {
      setBusy(null);
    }
  }

  // Not an admin → no data. (The API enforces; this is the matching UX.)
  if (!isAdmin) {
    return (
      <div className="space-y-6">
        <Header />
        <EmptyState
          title={isAuthed ? "Admins only." : "Sign in as an admin to manage users."}
          hint={isAuthed ? "Your account doesn't have the admin role." : undefined}
          action={
            !isAuthed ? (
              <button onClick={promptLogin} className="sw-btn sw-btn-primary">Sign in</button>
            ) : undefined
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Header />

      {error && <ErrorState message={error} />}

      {/* Add editor */}
      <form
        onSubmit={(e) => { e.preventDefault(); void add(email); }}
        className="sw-panel flex flex-wrap items-end gap-3 p-4"
      >
        <label className="block flex-1 min-w-[220px]">
          <span className="sw-label">Add an editor</span>
          <input
            className="sw-input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@example.com"
            data-testid="add-editor-email"
          />
        </label>
        <button type="submit" disabled={!email.trim() || busy !== null} className="sw-btn sw-btn-primary" data-testid="add-editor-submit">
          {busy === email.trim() ? "Adding…" : "Add editor"}
        </button>
      </form>

      {/* Editor list */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">Editors</h2>
        {editorsQ.isLoading && !editorsQ.data ? (
          <div className="py-10"><Spinner label="Loading editors…" /></div>
        ) : editorsQ.error ? (
          <ErrorState message={editorsQ.error instanceof Error ? editorsQ.error.message : "Failed to load editors."} />
        ) : (editorsQ.data?.length ?? 0) === 0 ? (
          <EmptyState title="No editors yet." hint="Admins (from ADMIN_EMAILS) always have access; add editors to grant write access to others." />
        ) : (
          <div className="sw-panel divide-y divide-[var(--color-border)] overflow-hidden" data-testid="editor-list">
            {editorsQ.data!.map((ed) => (
              <div key={ed.email} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3" data-testid={`editor-${ed.email}`}>
                <div className="min-w-0">
                  <span className="sw-mono block truncate text-sm text-[var(--color-ink)]">{ed.email}</span>
                  <span className="sw-mono block text-[11px] text-[var(--color-ink-faint)]">
                    added by {ed.added_by} · {formatRelative(ed.added_at)}
                  </span>
                </div>
                <button
                  onClick={() => void remove(ed.email)}
                  disabled={busy === ed.email}
                  className="sw-btn sw-btn-ghost sw-btn-sm"
                  style={{ color: "var(--color-fail)" }}
                  data-testid={`remove-${ed.email}`}
                >
                  {busy === ed.email ? "…" : "Remove"}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Pending access requests */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">Pending access requests</h2>
        {(requestsQ.data?.length ?? 0) === 0 ? (
          <div className="sw-panel px-4 py-5 text-sm text-[var(--color-ink-dim)]">
            No pending requests. People who ask for access via the sign-in screen appear here.
          </div>
        ) : (
          <div className="sw-panel divide-y divide-[var(--color-border)] overflow-hidden" data-testid="request-list">
            {requestsQ.data!.map((r) => (
              <div key={r.email} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3" data-testid={`request-${r.email}`}>
                <div className="min-w-0">
                  <span className="sw-mono block truncate text-sm text-[var(--color-ink)]">{r.email}</span>
                  <span className="sw-mono block text-[11px] text-[var(--color-ink-faint)]">
                    requested {formatRelative(r.requested_at)}{r.count > 1 ? ` · ${r.count}×` : ""}
                  </span>
                </div>
                <button
                  onClick={() => void add(r.email)}
                  disabled={busy === r.email}
                  className="sw-btn sw-btn-sm"
                  data-testid={`grant-${r.email}`}
                >
                  {busy === r.email ? "…" : "Add as editor"}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Header() {
  return (
    <header>
      <p className="sw-eyebrow">Administration</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Users</h1>
    </header>
  );
}
