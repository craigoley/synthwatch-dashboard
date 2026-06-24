/* eslint-disable security/detect-non-literal-fs-filename -- build script; paths come from require.resolve, not user input */
// Re-vendor the Playwright trace viewer into public/trace-viewer/.
//
// WHY VENDORED (committed), not build-copied: the trace viewer is a static SPA we
// self-host so the in-app "View trace" iframe loads on the dashboard ORIGIN — which
// is the ONLY origin the API's CORS allowlist permits to fetch the trace.zip
// (siteConfig.cors = the prod dashboard, never "*"; an off-domain viewer like
// trace.playwright.dev would be CORS-blocked). It's committed (not generated at
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
