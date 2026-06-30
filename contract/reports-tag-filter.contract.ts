import { test, expect } from "@playwright/test";

import { getAvailabilityReport, getPerformanceReport, getIncidentBreakdown } from "@/lib/api-client";

/**
 * Pin the report tag-filter REQUEST contract (companion to synthwatch-api#130). The dashboard's multi-select
 * tags must go out as REPEATED `?tag=key:value` params — exactly the shape the API's `key||':'||value = ANY(...)`
 * AND-filter reads. An empty selection must send NO `tag` param at all (the whole-fleet no-op, matching the
 * API's cardinality=0 short-circuit). If the client ever stops sending it / changes the format, the aggregate
 * tiles would silently revert to whole-fleet under a filter — this fails loudly instead.
 */
async function captureUrl(fn: () => Promise<unknown>): Promise<URLSearchParams> {
  const orig = globalThis.fetch;
  let captured = "";
  globalThis.fetch = (async (u: string | URL) => {
    captured = String(u);
    return new Response(JSON.stringify({ window: "7d", groupBy: null, groups: [], buckets: [], total: 0, precision: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = orig;
  }
  return new URL(captured, "http://local").searchParams;
}

const TAGS = [
  { key: "env", value: "prod" },
  { key: "team", value: "web" },
];

test.describe("API contract — reports tag filter (?tag=)", () => {
  test("★ getAvailabilityReport sends repeated ?tag=key:value (AND); omits it when empty", async () => {
    const withTags = await captureUrl(() => getAvailabilityReport("7d", "none", TAGS));
    expect(withTags.getAll("tag")).toEqual(["env:prod", "team:web"]);
    const none = await captureUrl(() => getAvailabilityReport("7d", "none", []));
    expect(none.has("tag")).toBe(false); // empty selection → whole fleet (no param)
  });

  test("★ getPerformanceReport + getIncidentBreakdown send the same ?tag= contract", async () => {
    const perf = await captureUrl(() => getPerformanceReport("7d", "none", TAGS));
    expect(perf.getAll("tag")).toEqual(["env:prod", "team:web"]);

    const brk = await captureUrl(() => getIncidentBreakdown("30d", TAGS));
    expect(brk.getAll("tag")).toEqual(["env:prod", "team:web"]);
    const brkNone = await captureUrl(() => getIncidentBreakdown("30d", []));
    expect(brkNone.has("tag")).toBe(false);
  });

  // The group-by control forwards the tag KEY as ?groupBy= (the API GROUPs BY that key server-side). Pin the
  // request shape so the wiring can't silently revert to ungrouped. Composes with ?tag=.
  test("★ getAvailabilityReport + getPerformanceReport forward ?groupBy=<key> (composes with ?tag=)", async () => {
    const avail = await captureUrl(() => getAvailabilityReport("30d", "team", TAGS));
    expect(avail.get("groupBy")).toBe("team");
    expect(avail.getAll("tag")).toEqual(["env:prod", "team:web"]); // group-by + filter stack

    const perf = await captureUrl(() => getPerformanceReport("30d", "team", []));
    expect(perf.get("groupBy")).toBe("team");
  });
});
