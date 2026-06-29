import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getBaselineDiff } from "@/lib/api-client";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Contract check — POST /api/runs/{id}/baseline-diff (the gated location comparison).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Anchors the new seam against the mock-vs-real drift class (the #96 lesson): the client RENAMES the API's
 * A/B fields (diff.console.onlyInA → console.onlyInThisRun; diff.network.totalRequestsA →
 * network.totalRequestsThisRun) and normalizes the insight taxonomy. A regress in either mapping FAILS here.
 *
 * Fixture provenance (contract/README.md): derived from the authoritative server DTO (synthwatch-api
 * Dtos/LocationDiffDto.cs) — the endpoint is gated + newly added, so a live authed capture via
 * `SYNTHWATCH_API_TOKEN=… pnpm capture:contracts` can replace baseline_diff_ok.json once deployed.
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

test.describe("API contract — POST /runs/{id}/baseline-diff (LocationDiffDto)", () => {
  test("★ OK body: diff A/B fields map to this-run/baseline, insight taxonomy preserved", async () => {
    const raw = real("baseline_diff_ok");
    // Pin the server shape: diff with A/B console + network, a non-null insight with likelyCause + isFlaky.
    expect(raw.configured).toBe(true);
    expect(raw.diff.console).toHaveProperty("onlyInA");
    expect(raw.diff.network).toHaveProperty("totalRequestsA");
    expect(raw.insight).not.toBeNull();

    const res = await withRealResponse(raw, () => getBaselineDiff(844834));
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return; // type-narrow

    // ★ the A/B → this-run/baseline RENAME (the drift-prone seam):
    expect(res.diff.console.onlyInThisRun.length).toBe(raw.diff.console.onlyInA.length);
    expect(res.diff.console.onlyInThisRun[0]!.text).toBe(raw.diff.console.onlyInA[0].text);
    expect(res.diff.console.onlyInThisRun[0]!.origin).toBe(raw.diff.console.onlyInA[0].origin);
    expect(res.diff.console.shared).toBe(raw.diff.console.shared);
    expect(res.diff.network.totalRequestsThisRun).toBe(raw.diff.network.totalRequestsA);
    expect(res.diff.network.totalRequestsBaseline).toBe(raw.diff.network.totalRequestsB);
    expect(res.diff.network.failedHostsOnlyInThisRun).toEqual(raw.diff.network.failedHostsOnlyInA);
    expect(res.diff.network.thirdPartyOnlyInThisRun[0]!.host).toBe(raw.diff.network.thirdPartyOnlyInA[0].host);
    expect(res.diff.failing.location).toBe(raw.failing.location);
    expect(res.diff.baseline.source).toBe(raw.baseline.source);

    // ★ verdict (#118) — the primary "which layer failed" classification, mapped through:
    expect(raw.insight.verdict).toBe("site-failure");
    expect(res.insight.verdict).toBe(raw.insight.verdict);

    // ★ the insight taxonomy + flakiness call:
    expect(res.insight.likelyCause).toBe(raw.insight.likelyCause);
    expect(res.insight.isFlaky).toBe(raw.insight.isFlaky);
    expect(res.insight.confidence).toBe(raw.insight.confidence);
    expect(res.insight.findings[0]!.title).toBe(raw.insight.findings[0].title);
    expect(res.insight.findings[0]!.evidence).toBe(raw.insight.findings[0].evidence);
    expect(res.insight.caveats).toEqual(raw.insight.caveats);
  });

  test("configured:false body → not_configured, diff still present, message from `note`", async () => {
    const raw = real("baseline_diff_not_configured");
    expect(raw.configured).toBe(false);
    expect(raw.insight).toBeNull();

    const res = await withRealResponse(raw, () => getBaselineDiff(844834));
    expect(res.status).toBe("not_configured");
    if (res.status !== "not_configured") return; // type-narrow
    // The diff is shown even when the AI is off.
    expect(res.diff.console.onlyInThisRun.length).toBe(raw.diff.console.onlyInA.length);
    // message comes from the API's `note`.
    expect(res.message).toBe(raw.note);
  });

  // ★ verdict back-compat: a LEGACY insight (pre-#118, no verdict) and an OFF-TAXONOMY value both map to
  // null → the dashboard renders NO verdict badge (never a broken/garbage badge). "undetermined" is a real
  // taxonomy value and is preserved (it gets a neutral badge).
  test("verdict is null when absent (legacy) or off-taxonomy; a valid value (incl. undetermined) is kept", async () => {
    const base = real("baseline_diff_ok");

    const legacy = { ...base, insight: { ...base.insight } };
    delete legacy.insight.verdict; // pre-#118 shape
    const r1 = await withRealResponse(legacy, () => getBaselineDiff(1));
    expect(r1.status === "ok" && r1.insight.verdict).toBe(null);

    const garbage = { ...base, insight: { ...base.insight, verdict: "aliens" } };
    const r2 = await withRealResponse(garbage, () => getBaselineDiff(1));
    expect(r2.status === "ok" && r2.insight.verdict).toBe(null);

    const undet = { ...base, insight: { ...base.insight, verdict: "undetermined" } };
    const r3 = await withRealResponse(undet, () => getBaselineDiff(1));
    expect(r3.status === "ok" && r3.insight.verdict).toBe("undetermined");
  });
});
