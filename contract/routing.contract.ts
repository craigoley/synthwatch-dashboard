import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getRouting } from "@/lib/api-client";

/**
 * Anchor the routing mapper (getRouting) to the REAL API response
 * (contract/real/routing.json, refreshed by `pnpm capture:contracts`). One of the two cheap rich-seam
 * anchors (recon 2026-07-09): `/routing` is a rich (divergence-class) seam — it serves a NESTED shape
 * `severity.{critical,warning}.channelIds` (a `RoutingRule` per severity), not a flat single-word row — yet
 * it was UNANCHORED. This is exactly the class where mock-vs-real drift has hidden: a rename of the nested
 * `channelIds` (→ `channel_ids`) or a re-nesting of `severity` would leave the e2e mock green while prod
 * dropped every routed channel.
 *
 * The mapper (`api-client.ts` getRouting) reads `severity`/`perCheck`/`tagRules` and passes the nested
 * `RoutingRule.channelIds` through verbatim. This test pins that nesting against the captured live shape.
 */

const REAL = join(__dirname, "real");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const real = (name: string): any => JSON.parse(readFileSync(join(REAL, `${name}.json`), "utf8"));

/** Run `fn` with global fetch stubbed to return `body` as a 200 JSON response; restore fetch after. */
async function withRealResponse<T>(body: unknown, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

test.describe("API contract — routing mapper vs the real response", () => {
  test("GET /routing: nested severity.{critical,warning}.channelIds mapped through verbatim", async () => {
    const raw = real("routing");

    // ★ Pin the real NESTED shape the mapper depends on: severity → {critical,warning} → {channelIds:number[]}.
    expect(raw, "response has `severity`").toHaveProperty("severity");
    expect(raw.severity, "severity has a `critical` rule").toHaveProperty("critical");
    expect(raw.severity, "severity has a `warning` rule").toHaveProperty("warning");
    expect(raw.severity.critical, "the critical rule nests `channelIds` (NOT channel_ids)").toHaveProperty("channelIds");
    expect(raw.severity.warning, "the warning rule nests `channelIds`").toHaveProperty("channelIds");
    expect(Array.isArray(raw.severity.critical.channelIds), "channelIds is a number[]").toBe(true);
    // top-level dimensions the mapper reads (null-safe → {} / [])
    for (const f of ["perCheck", "tagRules"]) expect(raw, `response has ${f}`).toHaveProperty(f);

    const routing = await withRealResponse(raw, () => getRouting());
    // The nested channelIds survive the mapper unchanged — the routed channels prod actually pages.
    // (`severity` is a Record → `.critical` is possibly-undefined under noUncheckedIndexedAccess; `?.` reads
    // the array when present, which is exactly what the real capture guarantees.)
    expect(routing.severity.critical?.channelIds).toEqual(raw.severity.critical.channelIds);
    expect(routing.severity.warning?.channelIds).toEqual(raw.severity.warning.channelIds);
    // null perCheck/tagRules become the null-safe empties the consumer iterates.
    expect(routing.perCheck).toEqual(raw.perCheck ?? {});
    expect(routing.tagRules).toEqual(raw.tagRules ?? []);
  });

  // ★ MUST-GO-RED: rename the pinned nested field in the fixture → the mapper reads undefined → the mapped
  // channelIds no longer match the real routed channels. Proves the anchor has teeth (not a tautology).
  test("teeth: renaming the nested `channelIds` → `channel_ids` breaks the mapping", async () => {
    const raw = real("routing");
    const realIds = raw.severity.critical.channelIds;
    const poisoned = {
      ...raw,
      severity: { ...raw.severity, critical: { channel_ids: realIds } }, // API renamed the nested field
    };
    const routing = await withRealResponse(poisoned, () => getRouting());
    // Mapper read `channelIds` off a row that only has `channel_ids` → undefined, NOT the real routed list.
    expect(routing.severity.critical?.channelIds).toBeUndefined();
    expect(routing.severity.critical?.channelIds).not.toEqual(realIds);
  });
});
