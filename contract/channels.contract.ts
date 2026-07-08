import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { listChannels } from "@/lib/api-client";

/**
 * Anchor GET /api/channels — the alerting channels list. This is the ONE read seam with NO mapper:
 * `listChannels` does `return raw ?? []`, casting the raw JSON straight to `Channel[]`. So "no one ever
 * checked the shape" — an unmapped divergence between the dashboard's `Channel`/`ChannelConfig` type and the
 * API's serialized shape would hide here (blank recipient/URL on the notifications channel list/form). This
 * pins the RAW field names against the authoritative server DTO.
 *
 * Fixture provenance (Option-B, per contract/README.md + the ai-insights precedent): the endpoint is
 * auth-gated (401 unauthenticated), so `contract/real/channels.json` is derived from the AUTHORITATIVE server
 * DTO — synthwatch-api `Dtos/AlertingDtos.cs` `ChannelDto {id,name,type,config,enabled}` + `Data/Entities/
 * Channel.cs` `ChannelConfig {to,url,authHeader}` (JSON policy = camelCase, DbContext.cs) — NOT the client's
 * assumption. Replace with a live authed capture via `SYNTHWATCH_API_TOKEN=… pnpm capture:contracts`.
 */

const REAL = join(__dirname, "real");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const real = (name: string): any => JSON.parse(readFileSync(join(REAL, `${name}.json`), "utf8"));

async function withRealResponse<T>(body: unknown, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

test.describe("API contract — /channels (no-mapper seam) vs the server DTO shape", () => {
  test("GET /channels is a BARE ARRAY of {id,name,type,config,enabled}; the raw shape IS the domain shape", async () => {
    const raw = real("channels");
    expect(Array.isArray(raw), "/channels is a bare array (not an envelope)").toBe(true);
    expect(raw.length, "fixture has ≥1 channel").toBeGreaterThan(0);

    // ★ Pin the exact serialized field names of ChannelDto — since there is NO mapper, a rename here (e.g.
    //   `channelType` instead of `type`) would silently produce a broken Channel with no bridge.
    for (const c of raw) {
      for (const f of ["id", "name", "type", "config", "enabled"]) {
        expect(c, `channel ${c.id} has ${f}`).toHaveProperty(f);
      }
      // nested ChannelConfig: email → {to:[]}, webhook → {url, authHeader}
      const cfgKeys = Object.keys(c.config);
      expect(cfgKeys.every((k) => ["to", "url", "authHeader"].includes(k)), `config keys ⊆ {to,url,authHeader}: ${cfgKeys}`).toBe(true);
    }

    const mapped = await withRealResponse(raw, () => listChannels());
    expect(mapped.length).toBe(raw.length);
    for (const rc of raw) {
      const m = mapped.find((x) => x.id === rc.id);
      expect(m, `channel ${rc.id} present after listChannels()`).toBeTruthy();
      // the passthrough must preserve every field verbatim (no mapper = the raw shape is the contract)
      expect(m!.name).toBe(rc.name);
      expect(m!.type).toBe(rc.type);
      expect(m!.enabled).toBe(rc.enabled);
      expect(m!.config).toEqual(rc.config); // nested config verbatim (to / url / authHeader)
    }
  });

  test("email + webhook channels both round-trip their config (the two ChannelConfig variants)", async () => {
    const raw = real("channels");
    const mapped = await withRealResponse(raw, () => listChannels());
    const email = mapped.find((c) => c.type === "email");
    const webhook = mapped.find((c) => c.type === "webhook");
    expect(email, "an email channel is present").toBeTruthy();
    expect(Array.isArray(email!.config.to), "email config carries `to[]`").toBe(true);
    expect(webhook, "a webhook channel is present").toBeTruthy();
    expect(typeof webhook!.config.url, "webhook config carries `url`").toBe("string");
  });
});
