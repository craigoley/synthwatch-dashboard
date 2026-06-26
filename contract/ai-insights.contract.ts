import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getAiInsights } from "@/lib/api-client";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Contract check — POST /api/runs/{id}/ai-insights (the gated AOAI endpoint).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 4th occurrence of the mock-vs-real drift class (#96): the client (#100) assumed a NESTED
 * { configured, message, insights: { summary, … } } body; the live API (AiInsightsDto, slice 2) returns a
 * FLAT body { configured, summary, performance[], network[], errors[], suggestions[], caveats[], note }.
 * The nested mock agreed with the nested client → tests passed, prod broke. #102 fixed the client to flat;
 * this anchors it: getAiInsights runs against the captured real shape, so a regress to nested FAILS here.
 *
 * Fixture provenance (see contract/README.md): captured Option-B — derived from the authoritative server
 * DTO (synthwatch-api Dtos/AiInsightsDto.cs), NOT the client's assumption. ai_insights_not_configured.json
 * is the exact serialization of `AiInsightsDto.NotConfigured`. A live authed capture (the endpoint is gated)
 * can replace ai_insights_ok.json via `SYNTHWATCH_API_TOKEN=… pnpm capture:contracts`.
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

test.describe("API contract — POST /runs/{id}/ai-insights (FLAT AiInsightsDto)", () => {
  test("★ OK body is FLAT (categories top-level, not wrapped) → the client renders them", async () => {
    const raw = real("ai_insights_ok");
    // Pin the flat shape to the captured ground truth: NO `insights` wrapper, categories at the top level,
    // the non-fatal message is `note` (not `message`). The #102 bug was reading a nested { insights:{…} }.
    expect(raw, "the API body is flat — no `insights` wrapper").not.toHaveProperty("insights");
    expect(Array.isArray(raw.performance), "performance is a top-level array").toBe(true);
    expect(raw).toHaveProperty("note");
    expect(raw.configured).toBe(true);

    const res = await withRealResponse(raw, () => getAiInsights(844515));
    // A nested-assuming client reads raw.insights (undefined) → status "unavailable"; flat → "ok".
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return; // type-narrow
    expect(res.insights.summary).toBe(raw.summary);
    expect(res.insights.performance.length).toBe(raw.performance.length);
    expect(res.insights.errors.length + res.insights.performance.length, "categories populated").toBeGreaterThan(0);
    // field-name contracts on an insight: title / detail / severity / confidence / evidence
    const err0 = res.insights.errors[0];
    expect(err0, "an error insight is present").toBeTruthy();
    expect(err0!.title).toBe(raw.errors[0].title);
    expect(err0!.severity).toBe(raw.errors[0].severity);
    expect(err0!.evidence).toBe(raw.errors[0].evidence);
    expect(res.insights.caveats).toEqual(raw.caveats);
  });

  test("configured:false body → not_configured, message read from `note`", async () => {
    const raw = real("ai_insights_not_configured");
    expect(raw.configured).toBe(false);

    const res = await withRealResponse(raw, () => getAiInsights(844515));
    expect(res.status).toBe("not_configured");
    if (res.status !== "not_configured") return; // type-narrow
    // ★ The message comes from the API's `note` — the nested client read `message` (undefined) → its own
    // hardcoded default, which would NOT equal the real note. Pins the note-vs-message fix too.
    expect(res.message).toBe(raw.note);
  });
});
