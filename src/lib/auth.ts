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

/**
 * ★ Same-origin cookie mirroring JUST the bearer token, for the screenshot-proxy (app/screenshot-proxy/*).
 * That route runs SERVER-side and streams a forensic screenshot from the C# API, which (synthwatch-api #154)
 * now gates behind a bearer. (Traces no longer use a proxy — they're fetched directly via a short-TTL SAS; see
 * TraceViewer.) A server route can't read localStorage, and the browser attaches nothing to the viewer's
 * iframe/download/fetch — so the token is also mirrored here where the proxy can read it (req.cookies) and
 * forward it as `Authorization: Bearer`. SameSite=Lax + same-origin: it is NEVER sent to the cross-origin API,
 * only to the dashboard's own proxy. Not httpOnly (set client-side) — SAME XSS exposure as the localStorage
 * token, no worse; the API is still the real boundary (opaque, server-revocable session).
 */
export const PROXY_COOKIE = "sw_proxy_session";

function writeProxyCookie(session: Session): void {
  if (typeof document === "undefined") return;
  const maxAge = Math.max(0, Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000));
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${PROXY_COOKIE}=${encodeURIComponent(session.token)}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`;
}
function clearProxyCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${PROXY_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

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
      clearProxyCookie();
      return null;
    }
    writeProxyCookie(s); // resync the proxy cookie with the restored session (cookie may have lapsed)
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
    writeProxyCookie(session); // mirror the bearer for the server-side screenshot-proxy
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
    clearProxyCookie(); // drop the proxy bearer on logout/expiry (the viewer reverts to 401 → "sign in")
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
