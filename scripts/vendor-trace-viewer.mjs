// Re-vendor the Playwright trace viewer into public/trace-viewer/.
//
// WHY VENDORED (committed), not build-copied: the trace viewer is a static SPA we
// self-host so the in-app "View trace" iframe loads on the dashboard ORIGIN and
// fetches the trace SAME-ORIGIN through app/trace-proxy/[id] (no CORS — an off-domain
// viewer like trace.playwright.dev fetching a cross-origin/blob-backed trace is the
// documented-broken combination, Playwright #38622). It's committed (not generated at
// build) because the E2E webServer runs `next build` directly — bypassing npm
// prebuild hooks — and to keep Vercel builds independent of devDep internals.
//
// Run this after bumping @playwright/test (keep the viewer in sync):
//   node scripts/vendor-trace-viewer.mjs
import { createRequire } from "node:module";
import { cpSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const pwCore = dirname(require.resolve("playwright-core/package.json"));
const src = join(pwCore, "lib", "vite", "traceViewer");
const dest = join(process.cwd(), "public", "trace-viewer");

if (!existsSync(src)) {
  console.error(`[vendor-trace-viewer] source not found: ${src}`);
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`[vendor-trace-viewer] copied ${src} -> ${dest}`);

// ── Post-copy patch: tolerate a single unparseable NDJSON line ─────────────────────────────────
// The viewer's TraceModel._appendEvent JSON.parses every trace.trace/trace.network line and lets a
// SyntaxError bubble out of load() as the opaque "Could not load trace" — one malformed line nukes
// the whole trace. A sensitive-monitor REDACTED trace (runner traceRedact.ts) can emit exactly such
// a line (non-escape-aware header-text scrub truncating a JSON-escaped quote), so the trace is
// downloadable + a valid zip yet won't render inline. This makes the parse resilient: skip (and
// warn about) an unparseable line and render the rest. It is a STOPGAP — the real fix is runner-side
// (make the redactor escape-aware so it never breaks NDJSON). We deliberately keep the try AROUND the
// JSON.parse only, NOT around _innerAppendEvent, so a genuine TraceVersionError still surfaces.
// Idempotent + fails loudly: if a Playwright bump changes this codegen, FROM won't match and we
// exit non-zero so the patch is re-authored rather than silently dropped.
const SW = join(dest, "sw.bundle.js");
const FROM = `_appendEvent(t){if(!t)return;const e=this._modernize(JSON.parse(t));for(const n of e)this._innerAppendEvent(n)}`;
const TO = `_appendEvent(t){if(!t)return;let e;try{e=this._modernize(JSON.parse(t))}catch(sw_err){console.warn("[synthwatch trace-viewer] skipped an unparseable trace line (redacted-trace NDJSON corruption; real fix is runner traceRedact.ts):",sw_err&&sw_err.message);return}for(const n of e)this._innerAppendEvent(n)}`;
let sw = readFileSync(SW, "utf8");
const matches = sw.split(FROM).length - 1;
if (matches !== 1) {
  console.error(
    `[vendor-trace-viewer] resilience patch target not found (found ${matches}, expected 1). ` +
      `Playwright likely changed TraceModel._appendEvent — re-author the patch in scripts/vendor-trace-viewer.mjs.`,
  );
  process.exit(1);
}
writeFileSync(SW, sw.replace(FROM, TO));
console.log(`[vendor-trace-viewer] applied _appendEvent skip-unparseable-line resilience patch`);
