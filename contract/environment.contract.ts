import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getCheck } from "@/lib/api-client";

/**
 * Anchor the env-aware read: the API (api #205) projects the authoritative `checks.environment` column onto
 * the check DTO, and `mapCheck` reads it into `Check.environment`. Anchored against the REAL captured staging
 * check (check 354, the Wegmans PREVIEW monitor — `environment: "staging"` live), NOT a hand-written shape.
 * This is the field the env badge / grid filter / status-banner guard / exclusion caption all key off, so a
 * rename or a drop on the API side must FAIL here rather than silently degrade every non-prod check to "prod".
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

test.describe("API contract — checks.environment (env-aware display)", () => {
  test("GET /checks/{id}: the real `environment` field maps to Check.environment (staging fixture)", async () => {
    const raw = real("check_detail_staging");

    // ★ Pin the real field name + a non-prod value (the fixture is a live staging capture).
    expect(raw, "response has `environment` (the authoritative column, api #205)").toHaveProperty("environment");
    expect(raw.environment, "the captured PREVIEW check is staging (a non-prod value exercises the badge/guard)").toBe("staging");

    const { check } = await withRealResponse(raw, () => getCheck(Number(raw.id)));
    expect(check.environment).toBe("staging"); // read verbatim from the real field — drives badge/filter/guard
  });

  // ★ MUST-GO-RED: if the API renamed `environment` (or dropped it), mapCheck's `?? "prod"` default would make
  // EVERY check read as prod — a staging fail would then flip the prod banner and no badge would show. Renaming
  // the field in the fixture must break the pin.
  test("teeth: renaming `environment` → `deployment_env` makes the check silently read as prod", async () => {
    const raw = real("check_detail_staging");
    const poisoned = { ...raw, deployment_env: raw.environment };
    delete poisoned.environment; // API renamed the field → the camel `environment` key is gone
    const { check } = await withRealResponse(poisoned, () => getCheck(Number(raw.id)));
    // mapCheck falls back to "prod" — proving the anchor is load-bearing: without the real field, staging is lost.
    expect(check.environment).toBe("prod");
    expect(check.environment).not.toBe(raw.environment);
  });
});
