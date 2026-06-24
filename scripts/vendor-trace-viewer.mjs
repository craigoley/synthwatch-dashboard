/* eslint-disable security/detect-non-literal-fs-filename -- build script; paths come from require.resolve, not user input */
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
import { cpSync, rmSync, existsSync } from "node:fs";
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
