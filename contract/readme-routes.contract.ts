import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * README route-PRESENCE gate.
 *
 * ★ WHAT THIS CHECKS: that the route list in README.md's `ROUTES:START`/`ROUTES:END` block matches the actual
 *   `src/app/**` route files EXACTLY — i.e. it catches ADD/REMOVE drift (a route file exists that the README
 *   omits, or the README lists a route that no longer exists). This is what let the README claim "4 pages" while
 *   the app grew to 14.
 * ★ WHAT THIS DOES NOT CHECK: whether the README's prose DESCRIBES each route correctly. This is a PRESENCE gate,
 *   not a MEANING gate — the descriptions under the marked block are human-maintained and unverified. Reading this
 *   as if it validated the descriptions would be its own fake-quiet: a partial gate masquerading as a full one.
 */

const ROOT = join(__dirname, "..");

/** A route file's path (relative to src/app) → its URL. `page.tsx` → the dir's URL; root `page.tsx` → "/". */
function fileToRoute(relFromApp: string): string {
  const dir = relFromApp.replace(/\/?(page|route)\.[tj]sx?$/, ""); // "checks/[id]" | "" (root)
  return "/" + dir; // "/checks/[id]" | "/"
}

/** All routes actually present under src/app, split by kind (page vs route handler). */
function filesystemRoutes(): { pages: string[]; handlers: string[] } {
  const appDir = join(ROOT, "src/app");
  const entries = readdirSync(appDir, { recursive: true, encoding: "utf8" });
  const pages: string[] = [];
  const handlers: string[] = [];
  for (const e of entries) {
    const rel = e.replace(/\\/g, "/"); // normalize Windows separators
    if (/(^|\/)page\.[tj]sx?$/.test(rel)) pages.push(fileToRoute(rel));
    else if (/(^|\/)route\.[tj]sx?$/.test(rel)) handlers.push(fileToRoute(rel));
  }
  return { pages: pages.sort(), handlers: handlers.sort() };
}

/** The routes DECLARED in the README's gated block, split into its "Page routes:" / "Route handlers:" sections. */
function readmeRoutes(): { pages: string[]; handlers: string[] } {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const block = readme.match(/<!-- ROUTES:START[\s\S]*?-->([\s\S]*?)<!-- ROUTES:END -->/);
  expect(block?.[1], "README.md must contain the ROUTES:START/END presence-contract block").toBeTruthy();
  const [pagePart = "", handlerPart = ""] = (block?.[1] ?? "").split(/Route handlers:/i);
  const paths = (s: string) => [...s.matchAll(/`(\/[^`]*)`/g)].map((m) => m[1] as string).sort();
  return { pages: paths(pagePart), handlers: paths(handlerPart) };
}

/** Pure diff — declared vs actual. `missing` = in the app but not the README; `extra` = in the README, not the app. */
function routeDrift(declared: string[], actual: string[]): { missing: string[]; extra: string[] } {
  const d = new Set(declared);
  const a = new Set(actual);
  return {
    missing: actual.filter((r) => !d.has(r)).sort(),
    extra: declared.filter((r) => !a.has(r)).sort(),
  };
}

test.describe("README route list — PRESENCE gate (add/remove drift, NOT description accuracy)", () => {
  test("★ every src/app page route is listed in the README, and vice versa (presence only)", () => {
    const fs = filesystemRoutes();
    const doc = readmeRoutes();
    const drift = routeDrift(doc.pages, fs.pages);
    expect(
      drift,
      `README page-route list is out of sync with src/app.\n` +
        `  in app/ but MISSING from README: ${JSON.stringify(drift.missing)}\n` +
        `  in README but NOT in app/ (stale): ${JSON.stringify(drift.extra)}\n` +
        `Update the ROUTES block in README.md. (This is presence only — it does NOT check descriptions.)`,
    ).toEqual({ missing: [], extra: [] });
  });

  test("every src/app route HANDLER is listed in the README, and vice versa (presence only)", () => {
    const fs = filesystemRoutes();
    const doc = readmeRoutes();
    expect(routeDrift(doc.handlers, fs.handlers)).toEqual({ missing: [], extra: [] });
  });

  // ★ Prove-can-fail, self-contained (no filesystem mutation): the drift checker must report BOTH directions.
  // This is what makes the presence gate real — remove either branch and this goes red.
  test("★ MUST-GO-RED: routeDrift detects a route the README omits AND one the README invented", () => {
    // a new route file appeared, README not updated → reported as MISSING
    expect(routeDrift(["/a"], ["/a", "/b"])).toEqual({ missing: ["/b"], extra: [] });
    // README lists a route whose file was deleted → reported as EXTRA (stale)
    expect(routeDrift(["/a", "/gone"], ["/a"])).toEqual({ missing: [], extra: ["/gone"] });
    // exact match → clean
    expect(routeDrift(["/a", "/b"], ["/b", "/a"])).toEqual({ missing: [], extra: [] });
  });
});
