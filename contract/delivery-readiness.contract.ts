import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getDeliveryReadiness } from "@/lib/api-client";

/**
 * Anchor the delivery-readiness mapper (getDeliveryReadiness) to the REAL API response
 * (contract/real/notifications_health.json, refreshed by `pnpm capture:contracts`). One of the two cheap
 * rich-seam anchors (recon 2026-07-09): `/notifications/health` serves 4 MULTI-WORD camelCase fields
 * (`channelsConfigured`, `routingConfigured`, `transportConfigured`, `detail`) — the divergence-class shape
 * (a rename to snake_case would leave the e2e mock green while prod read every flag as false/unknown).
 *
 * ★ The load-bearing contract: `transportConfigured` is null-PRESERVING (true/false only if the API can
 * see the ACS transport; null = UNKNOWN). The mapper must NEVER coerce null→false — that would render a
 * configured transport as "not set up". This test pins both the field names and that null-preservation.
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

test.describe("API contract — delivery-readiness mapper vs the real response", () => {
  test("GET /notifications/health: 4 multi-word camel fields mapped; transportConfigured null preserved", async () => {
    const raw = real("notifications_health");

    // ★ Pin the real MULTI-WORD camelCase field names the mapper reads (the rename-divergence class).
    for (const f of ["channelsConfigured", "routingConfigured", "transportConfigured", "detail"]) {
      expect(raw, `response has \`${f}\` (camelCase, not snake_case)`).toHaveProperty(f);
    }
    // The captured live shape has transportConfigured = null (the API can't see ACS from here) — the exact
    // value whose preservation is the point.
    expect(raw.transportConfigured, "captured transportConfigured is null (UNKNOWN)").toBeNull();

    const readiness = await withRealResponse(raw, () => getDeliveryReadiness());
    expect(readiness, "getDeliveryReadiness returns a value (not null) for a 200").toBeTruthy();
    expect(readiness!.channelsConfigured).toBe(Boolean(raw.channelsConfigured));
    expect(readiness!.routingConfigured).toBe(Boolean(raw.routingConfigured));
    expect(readiness!.detail).toBe(raw.detail ?? null);
    // ★ null preserved, NOT coerced to false — a configured-but-unverifiable transport stays UNKNOWN.
    expect(readiness!.transportConfigured).toBeNull();
  });

  // ★ MUST-GO-RED: rename a pinned camel field in the fixture → the mapper reads undefined → the flag flips
  // to a fabricated `false`, the exact silent-wrong the anchor exists to catch.
  test("teeth: renaming `channelsConfigured` → `channels_configured` flips the flag to a fake false", async () => {
    const raw = real("notifications_health");
    expect(Boolean(raw.channelsConfigured), "fixture has channelsConfigured true (so the flip is observable)").toBe(true);
    // Rebuild with the field renamed to snake_case (the API-drift we're guarding against); the original
    // camel key is simply absent.
    const poisoned = {
      channels_configured: raw.channelsConfigured,
      routingConfigured: raw.routingConfigured,
      transportConfigured: raw.transportConfigured,
      detail: raw.detail,
    };
    const readiness = await withRealResponse(poisoned, () => getDeliveryReadiness());
    // Mapper read `channelsConfigured` off a body that only has `channels_configured` → undefined → Boolean() → false.
    expect(readiness!.channelsConfigured).toBe(false);
    expect(readiness!.channelsConfigured).not.toBe(Boolean(raw.channelsConfigured));
  });
});
