/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Client session store — Phase 12 slice 3 (dashboard auth).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Holds the bearer session minted by POST /api/auth/verify and exposes the token to the api-client
 * request() seam (which attaches it as `Authorization: Bearer <token>`). Framework-agnostic (no React)
 * so request() can read the token synchronously; a tiny pub/sub powers the React layer.
 *
 * ★ STORAGE = localStorage. The C# API is a SEPARATE origin (Azure) and authenticates via the
 * Authorization HEADER, not a cookie — a cross-origin httpOnly cookie can't reach it without a same-origin
 * API proxy (out of scope). So the token must be JS-readable to set the header. TRADEOFF: localStorage is
 * readable by any XSS on this origin. Mitigations: the API is the real security boundary (the dashboard
 * only hides buttons), the token is an OPAQUE, DB-backed, server-revocable 30-day session (logout/expiry
 * kill it), and it is NEVER logged or placed in a URL. If a same-origin API proxy is added later, move to
 * an httpOnly cookie.
 */

export type Role = "admin" | "editor" | "anonymous";

export interface Session {
  token: string;
  email: string;
  role: Role;
  /** ISO-8601 session expiry from /verify. */
  expiresAt: string;
}

const STORAGE_KEY = "synthwatch.session";

/** Auth events raised by the request() interceptor on a 401/403 from a NON-auth endpoint. */
export type AuthEvent =
  | { type: "unauthorized" } // session expired/invalid mid-action → clear + prompt re-login
  | { type: "forbidden"; message: string }; // valid session, insufficient role → show, don't re-login

let current: Session | null = loadFromStorage();
const sessionListeners = new Set<() => void>();
const eventListeners = new Set<(e: AuthEvent) => void>();

function isLive(s: Session | null): s is Session {
  return !!s && !!s.token && new Date(s.expiresAt).getTime() > Date.now();
}

function loadFromStorage(): Session | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    if (!isLive(s)) {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

/** The live session, or null (also clears + returns null if it has expired since last read). */
export function getSession(): Session | null {
  if (current && !isLive(current)) clearSession();
  return current;
}

/** The bearer token for the Authorization header, or null when signed out/expired. */
export function getToken(): string | null {
  return getSession()?.token ?? null;
}

export function setSession(session: Session): void {
  current = session;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch {
      /* storage full / disabled — in-memory still works for this tab */
    }
  }
  emitSession();
}

export function clearSession(): void {
  if (current === null) return;
  current = null;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
  emitSession();
}

// ── React-facing pub/sub (used by useSyncExternalStore in the AuthProvider) ──
export function subscribe(fn: () => void): () => void {
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
}
function emitSession(): void {
  for (const fn of sessionListeners) fn();
}
/** Snapshot for useSyncExternalStore — referentially stable between mutations. */
export function snapshot(): Session | null {
  return current;
}

// ── auth-event bus (the request() interceptor → the AuthProvider) ──
export function onAuthEvent(fn: (e: AuthEvent) => void): () => void {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}
export function emitAuthEvent(e: AuthEvent): void {
  for (const fn of eventListeners) fn(e);
}
