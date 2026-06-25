"use client";

/**
 * Phase 12 slice 3 — the dashboard auth layer.
 *
 * Owns the React view of the client session (from src/lib/auth.ts), the OTP login modal, and the
 * 401/403 response handling raised by the api-client request() seam:
 *   • 401 (session expired/invalid mid-action) → the session is already cleared; prompt re-login.
 *   • 403 (valid session, wrong role) → a permission toast; NOT a re-login (they ARE signed in).
 *
 * ★ This is UX adaptation, not the security boundary. The API (slice 2's gate) is the real enforcement —
 * a signed-out user hitting the API directly is still denied. Hiding buttons here is convenience only.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { authMe, authVerify, authRequestCode, authRequestAccess, authLogout } from "@/lib/api-client";
import {
  clearSession,
  onAuthEvent,
  setSession,
  snapshot,
  subscribe,
  type Role,
  type Session,
} from "@/lib/auth";
import { Modal } from "@/components/modal";

interface AuthContextValue {
  session: Session | null;
  email: string | null;
  role: Role;
  isAuthed: boolean;
  /** editor or admin — the dashboard's read-only-by-default switch for write affordances. */
  canWrite: boolean;
  isAdmin: boolean;
  /** the initial GET /auth/me refresh is in flight (a stored session is being re-validated). */
  loading: boolean;
  promptLogin: () => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const session = useSyncExternalStore(subscribe, snapshot, () => null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [forbidden, setForbidden] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const refreshed = useRef(false);

  // On first mount with a stored session, re-validate it (GET /auth/me) so the role is LIVE and a
  // revoked/expired token is dropped immediately. The token attaches via the request() seam.
  useEffect(() => {
    if (refreshed.current || !snapshot()) return;
    refreshed.current = true;
    setLoading(true);
    authMe()
      .then((me) => {
        const s = snapshot();
        if (!s) return;
        if (!me) clearSession();
        else if (me.role !== s.role || me.email !== s.email) setSession({ ...s, email: me.email, role: me.role });
      })
      .finally(() => setLoading(false));
  }, []);

  // 401/403 from the api-client interceptor.
  useEffect(() => {
    return onAuthEvent((e) => {
      if (e.type === "unauthorized") setLoginOpen(true);
      else setForbidden(e.message);
    });
  }, []);

  const promptLogin = useCallback(() => setLoginOpen(true), []);
  const signOut = useCallback(async () => {
    await authLogout();
    clearSession();
  }, []);

  const role: Role = session?.role ?? "anonymous";
  const value: AuthContextValue = {
    session,
    email: session?.email ?? null,
    role,
    isAuthed: session !== null,
    canWrite: role === "editor" || role === "admin",
    isAdmin: role === "admin",
    loading,
    promptLogin,
    signOut,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
      {forbidden && <ForbiddenToast message={forbidden} onDismiss={() => setForbidden(null)} />}
    </AuthContext.Provider>
  );
}

/** A persistent permission banner for a 403 — they're signed in, just lack the role. */
function ForbiddenToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 px-4" role="alert" data-testid="forbidden-toast">
      <div
        className="flex items-center gap-3 rounded-lg px-4 py-3 text-sm shadow-lg"
        style={{
          background: "color-mix(in srgb, var(--color-warn) 14%, var(--color-panel))",
          border: "1px solid color-mix(in srgb, var(--color-warn) 45%, transparent)",
          color: "var(--color-ink)",
        }}
      >
        <span className="sw-mono text-[11px] uppercase tracking-wider" style={{ color: "var(--color-warn)" }}>
          Permission
        </span>
        <span>{message}</span>
        <button type="button" onClick={onDismiss} className="ml-2 text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]">
          ✕
        </button>
      </div>
    </div>
  );
}

// ─── the OTP login modal ──────────────────────────────────────────────────────────────────────────

type Step = "email" | "code" | "requested";

function LoginModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setStep("email");
    setEmail("");
    setCode("");
    setNotice(null);
    setError(null);
    setBusy(false);
  }
  function close() {
    reset();
    onClose();
  }

  async function sendCode(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await authRequestCode(email.trim());
      setNotice(res.message); // enumeration-safe message — display as-is
      setStep("code");
    } catch {
      setError("Could not send a code. Check the email and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verify(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const s = await authVerify(email.trim(), code.trim());
      setSession({ token: s.token, email: s.email, role: s.role, expiresAt: s.expiresAt });
      close();
    } catch {
      setError("That code is invalid or has expired.");
    } finally {
      setBusy(false);
    }
  }

  // Enumeration-safe: the backend ALWAYS returns the same uniform message regardless of whether the email
  // is unknown / an editor / an admin. We display it as-is and never branch the UI on the email — so the
  // request-access flow leaks nothing. (Backend also rate-limits.) On success we move to the dedicated
  // "requested" confirmation so the user gets clear feedback (the old code set the message but never showed
  // it on the email step — a silent no-op).
  async function requestAccess() {
    setError(null);
    setBusy(true);
    try {
      const res = await authRequestAccess(email.trim());
      setNotice(res.message);
      setStep("requested");
    } catch {
      setError("Could not submit the request. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={close} title="Sign in" width={460}>
      <div className="space-y-4" data-testid="login-modal">
        <p className="text-sm text-[var(--color-ink-dim)]">
          Sign in with a one-time code to edit monitors. Reading the dashboard never requires sign-in.
        </p>

        {error && (
          <div
            className="rounded-lg px-3 py-2 text-sm"
            style={{ background: "color-mix(in srgb, var(--color-fail) 12%, transparent)", color: "var(--color-fail)" }}
            data-testid="login-error"
          >
            {error}
          </div>
        )}

        {step === "email" ? (
          <form onSubmit={sendCode} className="space-y-3">
            <label className="block">
              <span className="sw-label">Email</span>
              <input
                className="sw-input"
                type="email"
                autoFocus
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                data-testid="login-email"
              />
            </label>
            <button type="submit" disabled={busy || !email.trim()} className="sw-btn sw-btn-primary w-full" data-testid="login-send">
              {busy ? "Sending…" : "Send sign-in code"}
            </button>
            <button
              type="button"
              onClick={requestAccess}
              disabled={busy || !email.trim()}
              className="sw-btn sw-btn-ghost w-full"
              data-testid="request-access"
            >
              Don&apos;t have access? Request it
            </button>
          </form>
        ) : step === "code" ? (
          <form onSubmit={verify} className="space-y-3">
            {notice && (
              <div className="rounded-lg px-3 py-2 text-sm text-[var(--color-ink-dim)]" data-testid="login-notice"
                style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>
                {notice}
                <span className="mt-1 block text-[11px] text-[var(--color-ink-faint)]">
                  ★ Check your spam folder — the sign-in email can land there.
                </span>
              </div>
            )}
            <label className="block">
              <span className="sw-label">6-digit code</span>
              <input
                className="sw-input sw-mono tracking-[0.3em]"
                inputMode="numeric"
                autoFocus
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                data-testid="login-code"
              />
            </label>
            <button type="submit" disabled={busy || code.length < 6} className="sw-btn sw-btn-primary w-full" data-testid="login-verify">
              {busy ? "Verifying…" : "Verify + sign in"}
            </button>
            <button
              type="button"
              onClick={() => { setStep("email"); setCode(""); setError(null); }}
              className="sw-btn sw-btn-ghost w-full"
            >
              Use a different email
            </button>
            {/* The dead-end fix: a denied user waiting for a code that never comes (they aren't an
                editor/admin) can request access right here. Enumeration-safe — same uniform result. */}
            <p className="pt-1 text-center text-[12px] text-[var(--color-ink-dim)]">
              No code arriving? You may not have access yet —{" "}
              <button
                type="button"
                onClick={requestAccess}
                disabled={busy}
                className="text-[var(--color-brand)] underline-offset-2 hover:underline disabled:opacity-50"
                data-testid="request-access-from-code"
              >
                request access
              </button>
              .
            </p>
          </form>
        ) : (
          // "requested" — the uniform, enumeration-safe confirmation (identical for any email).
          <div className="space-y-3" data-testid="request-confirmation">
            <div
              className="rounded-lg px-3 py-3 text-sm"
              style={{ background: "color-mix(in srgb, var(--color-brand) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--color-brand) 28%, var(--color-border))" }}
            >
              <p className="font-medium text-[var(--color-ink)]">{notice}</p>
              <p className="mt-1 text-[12px] text-[var(--color-ink-dim)]">
                An admin will review your request. Once they grant access, sign in with a one-time code.
              </p>
            </div>
            <button
              type="button"
              onClick={() => { setStep("email"); setCode(""); setError(null); }}
              className="sw-btn sw-btn-ghost w-full"
            >
              Back to sign in
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
