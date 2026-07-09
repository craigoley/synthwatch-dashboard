import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getCheck } from "@/lib/api-client";

/**
 * Anchor the model-B credential READ shape (Step C) — how GET /api/checks/{id} projects the masked credential
 * slots and how `mapCheck` reads them. Model B: the API stores ENCRYPTED values and, on every read, masks each
 * configured slot to the literal "set" via `CredMask.Of` (synthwatch-api Dtos/CheckDtos.cs) — never the value
 * or ciphertext. The dashboard reads `secretHeaders`/`loginCredentials` (camelCase) → `secret_headers`/
 * `login_credentials`. A rename or a value-leak on the API side must FAIL here, not render a wrong panel.
 *
 * ★ FIXTURE PROVENANCE: `check_detail_creds.json` is an Option-B fixture — derived from the AUTHORITATIVE api
 * DTO (CredMask.Of + CredMaskTests: {"x-api-key":"set"} / {"username":"set","password":"set"}) over the real
 * captured `check_detail_10.json`, because the masked slots are editor-gated AND only present on a check that
 * has credentials, so an anonymous capture can't reach them. FOLLOW-UP (Craig): a tokened
 * `SYNTHWATCH_API_TOKEN=<editor> SYNTHWATCH_CRED_CHECK_ID=<b2c> pnpm capture:contracts` replaces it with a live
 * editor-session capture — the same open pattern as channels/ai-insights. Wired into capture.mjs.
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

const SET = "set"; // CredMask.Set — the only value a read ever exposes for a configured slot

test.describe("API contract — model-B credential masked read vs the DTO shape", () => {
  test("GET /checks/{id}: secretHeaders/loginCredentials map to { key -> 'set' }, never a value", async () => {
    const raw = real("check_detail_creds");

    // ★ Pin the real masked shape: camelCase maps whose every value is the literal "set".
    expect(raw, "response has `secretHeaders` (camelCase)").toHaveProperty("secretHeaders");
    expect(raw, "response has `loginCredentials` (camelCase)").toHaveProperty("loginCredentials");
    for (const v of Object.values(raw.secretHeaders as Record<string, string>)) expect(v).toBe(SET);
    for (const v of Object.values(raw.loginCredentials as Record<string, string>)) expect(v).toBe(SET);

    const { check } = await withRealResponse(raw, () => getCheck(Number(raw.id)));
    // camel → snake, masked map preserved verbatim (the editor renders slots from this)
    expect(check.secret_headers).toEqual(raw.secretHeaders);
    expect(check.login_credentials).toEqual(raw.loginCredentials);
    // ★ write-only guarantee at the seam: the mapped value is only ever "set", never a real value/ciphertext
    for (const v of Object.values(check.secret_headers ?? {})) expect(v).toBe(SET);
    for (const v of Object.values(check.login_credentials ?? {})) expect(v).toBe(SET);
  });

  // ★ MUST-GO-RED: if the API renamed `secretHeaders` (→ snake_case), the mapper reads undefined → the panel
  // would silently show no secret-header slots. Renaming it in the fixture must break the mapping.
  test("teeth: renaming `secretHeaders` → `secret_headers` in the response breaks the mapping", async () => {
    const raw = real("check_detail_creds");
    const realSlots = raw.secretHeaders;
    const poisoned = { ...raw, secret_headers: realSlots }; // API renamed to snake_case
    delete poisoned.secretHeaders; // camel key absent — the mapper reads undefined
    const { check } = await withRealResponse(poisoned, () => getCheck(Number(raw.id)));
    expect(check.secret_headers).toBeNull(); // read the camel field off a snake body → null, not the slots
    expect(check.secret_headers).not.toEqual(realSlots);
  });
});
