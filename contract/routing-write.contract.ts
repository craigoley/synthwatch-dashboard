import { test, expect } from "@playwright/test";

import { setRouting } from "@/lib/api-client";
import type { Routing } from "@/lib/types";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Contract ANCHOR — PUT /api/routing WRITE shape (F-05, the silent-integrity class on the alerting path).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A shape mismatch on the routing WRITE used to WIPE all alert routes while returning 200 — invisible until an
 * alert didn't fire during a real incident. The API now rejects a malformed write (400, no wipe); this pins
 * EXACTLY what the dashboard SENDS so a client-side rename/drift fails HERE instead of silently wiping.
 *
 * Must match synthwatch-api Dtos/AlertingDtos.cs (RoutingDto): severity/perCheck → { channelIds: number[] };
 * tagRules → { tagKey, tagValue, channelId }. If any inner key drifts, the API coalesces the bad dimension to
 * empty (a missing channelIds is now a 400, not a wipe) — but this test catches the drift one layer earlier.
 */

async function captureWriteBody(fn: () => Promise<unknown>): Promise<Record<string, unknown>> {
  const orig = globalThis.fetch;
  let captured: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    captured = init?.body ? JSON.parse(String(init.body)) : {};
    return new Response(JSON.stringify({ severity: {}, perCheck: {}, tagRules: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await fn();
    return captured;
  } finally {
    globalThis.fetch = orig;
  }
}

test.describe("API contract — PUT /routing write shape (F-05)", () => {
  test("★ setRouting pins the full { severity, perCheck, tagRules } shape the API binds (a drift would wipe)", async () => {
    const routing: Routing = {
      severity: { critical: { channelIds: [1, 2] }, warning: { channelIds: [1] } },
      perCheck: { "7": { channelIds: [2] } },
      tagRules: [{ tagKey: "team", tagValue: "payments", channelId: 1 }],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await captureWriteBody(() => setRouting(routing))) as any;

    // ★ All THREE dimensions are sent (omitting one tells the API "leave it untouched" — saving one dimension
    //   must never partial-wipe another; #66-safe). A missing key here would be the start of that bug.
    expect(Object.keys(body).sort()).toEqual(["perCheck", "severity", "tagRules"]);

    // ★ Inner severity/perCheck shape = { channelIds: number[] } — the exact key the API's ChannelIdsDto binds.
    //   Rename this and the API resolves the dimension to zero rows; pre-fix that WIPED, now it's a 400 — either
    //   way it must not drift, so anchor it.
    expect(body.severity.critical).toEqual({ channelIds: [1, 2] });
    expect(body.severity.warning).toEqual({ channelIds: [1] });
    expect(body.perCheck["7"]).toEqual({ channelIds: [2] });

    // ★ Tag-rule shape = { tagKey, tagValue, channelId } (RoutingDto.TagRuleDto) — not { key, value, … }.
    expect(body.tagRules[0]).toEqual({ tagKey: "team", tagValue: "payments", channelId: 1 });
  });
});
