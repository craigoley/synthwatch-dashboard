import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getDeploys } from "@/lib/api-client";

/**
 * Deploy-markers seam (GET /reports/deploys?host=&window=, deploy-markers v1). LIVE — anchored against real
 * captures (contract/real/reports_deploys_*.json, refreshed by `pnpm capture:contracts`), so the mapper can't
 * silently assume a shape the API doesn't serve. Two real hosts pin the two label branches HONESTLY:
 *   • wegmans  → a real commit deploy (isSha=true, sha=<sentry-release SHA>) → labels with the short SHA.
 *   • meals2go → an etag-only deploy  (isSha=false, sha=null)               → "deploy detected", never a fake SHA.
 * Plus the null-safety guard (no host → null, no fetch).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const real = (name: string): any => JSON.parse(readFileSync(join(__dirname, "real", `${name}.json`), "utf8"));

/** Run `fn` with global fetch stubbed to return `body` as a 200 JSON response; restore fetch after. */
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

test.describe("API contract — deploy markers (/reports/deploys) — LIVE capture anchor", () => {
  test("★ real commit deploy: maps camel→snake by the API's actual field names (sha/isSha/source/deployedAt)", async () => {
    const raw = real("reports_deploys_wegmans");
    expect(Array.isArray(raw.deploys)).toBe(true);
    const row = raw.deploys[0];
    expect(row.isSha, "wegmans row is a real commit deploy").toBe(true);
    expect(typeof row.sha).toBe("string");

    const result = await withRealResponse(raw, () => getDeploys("www.wegmans.com", "90d"));
    expect(result).not.toBeNull();
    const d = result!.deploys[0]!;
    // field-name contract: API serves sha / isSha / source / deployedAt → mapper's sha / is_sha / source / deployed_at.
    expect(d.sha).toBe(row.sha);
    expect(d.is_sha).toBe(true);
    expect(d.source).toBe(row.source); // "sentry-release"
    expect(d.deployed_at).toBe(row.deployedAt);
  });

  test("★ etag-only deploy stays HONEST: sha=null, is_sha=false — never a fabricated SHA", async () => {
    const raw = real("reports_deploys_meals2go");
    const row = raw.deploys[0];
    expect(row.isSha, "meals2go row is an etag marker, not a commit").toBe(false);
    expect(row.sha, "the API itself sends sha=null for a non-commit marker").toBeNull();

    const result = await withRealResponse(raw, () => getDeploys("www.meals2go.com", "90d"));
    const d = result!.deploys[0]!;
    expect(d.sha).toBeNull(); // honest: no commit id → the chart labels "deploy detected", not a fake SHA
    expect(d.is_sha).toBe(false);
    expect(d.source).toBe(row.source); // "etag"
    expect(d.deployed_at).toBe(row.deployedAt);
  });

  test("null-safe: no host → null, without fetching", async () => {
    let fetched = false;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      expect(await getDeploys("", "90d")).toBeNull();
      expect(fetched, "no host must short-circuit before any fetch").toBe(false);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
