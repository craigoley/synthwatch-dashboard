import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getReconcilePlan } from "@/lib/api-client";

/**
 * Anchor GET /api/reconcile/plan — the dry-run apply plan. `getReconcilePlan` maps
 * sourceKey→source_key, driftType→drift_type, computedAt→computed_at, and passes `plan` (runner jsonb)
 * through verbatim.
 *
 * Fixture provenance (Option-B): the endpoint is auth-gated (401 unauthenticated), so
 * `contract/real/reconcile_plan.json` is derived from the AUTHORITATIVE server DTO — synthwatch-api
 * `Dtos/ReconcileDto.cs` `ReconcileApplyPlanItemDto {sourceKey,driftType,status,plan,computedAt}` + the
 * documented `plan` jsonb shape `{summary,disposition,statements:[{purpose,text,values?,regions?}],
 * blockedReason?}` — NOT the client's assumption. (The sibling GET /reconcile/drift is anchored against a
 * live capture and uses the same `sourceKey`/`driftType` camelCase, corroborating this shape.) Replace with a
 * live authed capture via `SYNTHWATCH_API_TOKEN=… pnpm capture:contracts`.
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

test.describe("API contract — /reconcile/plan mapper vs the server DTO shape", () => {
  test("GET /reconcile/plan: items[] mapped by the real field names (sourceKey/driftType/computedAt)", async () => {
    const raw = real("reconcile_plan");
    expect(Array.isArray(raw.items), "items is an array").toBe(true);
    expect(raw.items.length, "fixture has ≥1 plan item").toBeGreaterThan(0);

    const r0 = raw.items[0];
    for (const f of ["sourceKey", "driftType", "status", "plan", "computedAt"]) {
      expect(r0, `plan item has ${f}`).toHaveProperty(f);
    }

    const res = await withRealResponse(raw, () => getReconcilePlan());
    expect(res, "getReconcilePlan returns a plan (not null) for a 200").toBeTruthy();
    expect(res!.items.length).toBe(raw.items.length);
    expect(res!.computed_at).toBe(raw.computedAt ?? null);

    for (let i = 0; i < raw.items.length; i++) {
      const rp = raw.items[i];
      const m = res!.items[i]!;
      expect(m.source_key).toBe(rp.sourceKey); // ★ sourceKey → source_key
      expect(m.drift_type).toBe(rp.driftType); // ★ driftType → drift_type
      expect(m.status).toBe(rp.status);
      expect(m.computed_at).toBe(rp.computedAt); // ★ computedAt → computed_at
      // plan jsonb passthrough — nested shape verbatim
      expect(m.plan.summary).toBe(rp.plan.summary);
      expect(m.plan.disposition).toBe(rp.plan.disposition);
      expect(m.plan.statements).toEqual(rp.plan.statements);
    }
  });

  // ★ The `plan` jsonb is runner-written and shape-varies (a blocked item carries `blockedReason`). Pin that
  // the mapper passes it through verbatim (it must NOT drop blockedReason or the statements array).
  test("plan jsonb passes through verbatim, incl. a blocked item's blockedReason", async () => {
    const raw = real("reconcile_plan");
    const res = await withRealResponse(raw, () => getReconcilePlan());
    const blocked = res!.items.find((x) => x.status === "blocked");
    const rawBlocked = raw.items.find((x: Record<string, unknown>) => x.status === "blocked");
    expect(blocked, "a blocked plan item is present").toBeTruthy();
    expect(blocked!.plan.blockedReason).toBe(rawBlocked.plan.blockedReason);
  });
});
