/**
 * Client error breadcrumb ring — a bounded, IN-MEMORY sink for the errors this app previously only ever
 * console.error'd (the ai-insights "unavailable" incident had no in-tab trail to read). This is the SMALLEST
 * useful version by design: no persistence, no network, no API, no table — the ring lives for the tab's
 * lifetime and is surfaced ONLY through the existing debug.ts gate ({@link isDebugOn}, channel "errors").
 * A persistent cross-session sink (runner table + API POST) is a deliberately deferred, separate build.
 *
 * Capture points: window "error", window "unhandledrejection", and the app's error boundaries (which call
 * {@link record} alongside their existing console.error). Global handlers install ONCE per tab.
 */

export type BreadcrumbSource = "onerror" | "unhandledrejection" | "boundary";

export interface Breadcrumb {
  /** epoch ms */
  ts: number;
  source: BreadcrumbSource;
  message: string;
  /** Next's error `digest`, when the error carried one (boundary + some framework errors). */
  digest?: string;
  /** pathname + search at capture time, so a trail reads as a timeline of where things broke. */
  route: string;
}

/** Default ring capacity — oldest evicted past this. Small: this is a live-debug trail, not a log store. */
export const RING_CAPACITY = 50;

/**
 * A bounded FIFO ring. Pure + framework-free so it is unit-testable in the pure-Node contract harness
 * (no window, no React). The module singleton below is what the app actually writes to.
 */
export class BreadcrumbRing {
  private buf: Breadcrumb[] = [];
  constructor(private readonly capacity: number = RING_CAPACITY) {}

  push(entry: Breadcrumb): void {
    this.buf.push(entry);
    if (this.buf.length > this.capacity) {
      // evict oldest first — keep only the most recent `capacity` entries
      this.buf.splice(0, this.buf.length - this.capacity);
    }
  }

  entries(): Breadcrumb[] {
    return [...this.buf];
  }

  clear(): void {
    this.buf = [];
  }

  get size(): number {
    return this.buf.length;
  }
}

// ── Module singleton + snapshot store (drives useSyncExternalStore in the panel) ──────────────────────────

const ring = new BreadcrumbRing();
type Listener = () => void;
const listeners = new Set<Listener>();

/** Stable snapshot reference — only re-created on write, so useSyncExternalStore doesn't loop. */
let snapshot: Breadcrumb[] = ring.entries();
/** A single frozen empty array for the SSR snapshot (must be referentially stable across calls). */
const SERVER_SNAPSHOT: Breadcrumb[] = [];

function emit(): void {
  snapshot = ring.entries();
  for (const l of listeners) l();
}

function currentRoute(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.location.pathname + window.location.search;
  } catch {
    return "";
  }
}

function digestOf(err: unknown): string | undefined {
  if (err && typeof err === "object" && "digest" in err) {
    const d = (err as { digest?: unknown }).digest;
    if (typeof d === "string" && d) return d;
  }
  return undefined;
}

function messageOf(err: unknown, fallback?: string): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === "string" && err) return err;
  if (fallback) return fallback;
  try {
    return err == null ? "unknown error" : String(err);
  } catch {
    return "unknown error";
  }
}

/** Record one breadcrumb into the ring and notify subscribers. */
export function record(source: BreadcrumbSource, message: string, digest?: string): void {
  ring.push({ ts: Date.now(), source, message: message || "(no message)", digest, route: currentRoute() });
  emit();
}

/** Map a DOM `ErrorEvent` (or shaped stand-in) → a breadcrumb. Exported for the pure-Node tests. */
export function recordFromErrorEvent(e: { message?: string; error?: unknown }): void {
  record("onerror", messageOf(e.error, e.message), digestOf(e.error));
}

/** Map a `PromiseRejectionEvent` (or shaped stand-in) → a breadcrumb. Exported for the pure-Node tests. */
export function recordFromRejection(e: { reason?: unknown }): void {
  record("unhandledrejection", `Unhandled rejection — ${messageOf(e.reason)}`, digestOf(e.reason));
}

export function getBreadcrumbs(): Breadcrumb[] {
  return snapshot;
}

/** SSR snapshot for useSyncExternalStore — always the same empty ref (nothing is captured on the server). */
export function getServerBreadcrumbs(): Breadcrumb[] {
  return SERVER_SNAPSHOT;
}

export function clearBreadcrumbs(): void {
  ring.clear();
  emit();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ── Global handlers — install ONCE per tab ────────────────────────────────────────────────────────────────

// Guard on `window` (not a module-scope boolean) so a dev HMR module re-eval can't double-register the
// listeners — the flag rides the tab, which HMR preserves, mirroring the "install permissions once" pattern.
const INSTALL_FLAG = "__swBreadcrumbCaptureInstalled";

/** Idempotently attach the window error/rejection listeners. Safe to call on every mount; no-op after the first. */
export function installErrorCapture(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as Record<string, unknown>;
  if (w[INSTALL_FLAG]) return;
  w[INSTALL_FLAG] = true;
  window.addEventListener("error", (e) => recordFromErrorEvent(e as ErrorEvent));
  window.addEventListener("unhandledrejection", (e) => recordFromRejection(e as PromiseRejectionEvent));
}
