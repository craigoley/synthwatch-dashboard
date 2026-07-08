import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getSteps } from "@/lib/api-client";

/**
 * Anchor GET /api/runs/{id}/steps — the multistep run's step chain (check-detail). `getSteps` maps
 * RawStep[] → RunStep[] via mapStep (runId→run_id, stepIndex→step_index, durationMs→duration_ms,
 * errorMessage→error_message, startedAt→started_at).
 *
 * Fixture provenance (Option-B): this seam is DORMANT — there are ZERO multistep checks in prod right now,
 * so a live GET /runs/{id}/steps returns `[]` and can't exercise the shape. `contract/real/runs_steps.json`
 * is therefore derived from the AUTHORITATIVE server DTO — synthwatch-api `Dtos/RunDtos.cs` `RunStepDto
 * {Id,RunId,StepIndex,Name,Status,DurationMs,ErrorMessage,StartedAt}` under the API's camelCase JSON policy
 * (`DbContext.cs` PropertyNamingPolicy = CamelCase) — NOT the client's assumption. Re-capture against a real
 * multistep run once one exists.
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

test.describe("API contract — /runs/{id}/steps mapper vs the server DTO shape", () => {
  test("GET /runs/{id}/steps is a BARE ARRAY; mapped by the real camelCase field names", async () => {
    const raw = real("runs_steps");
    expect(Array.isArray(raw), "/steps is a bare array (not an envelope)").toBe(true);
    expect(raw.length, "fixture has ≥1 step").toBeGreaterThan(0);

    const s0 = raw[0];
    for (const f of ["id", "runId", "stepIndex", "name", "status", "durationMs", "errorMessage", "startedAt"]) {
      expect(s0, `step has ${f}`).toHaveProperty(f);
    }

    const mapped = await withRealResponse(raw, () => getSteps(5000));
    expect(mapped.length).toBe(raw.length);
    for (let i = 0; i < raw.length; i++) {
      const rs = raw[i];
      const m = mapped[i]!;
      expect(m.id).toBe(rs.id);
      expect(m.run_id).toBe(rs.runId); // ★ runId → run_id
      expect(m.step_index).toBe(rs.stepIndex); // ★ stepIndex → step_index
      expect(m.name).toBe(rs.name);
      expect(m.status).toBe(rs.status);
      expect(m.duration_ms).toBe(rs.durationMs); // ★ durationMs → duration_ms
      expect(m.error_message).toBe(rs.errorMessage); // ★ errorMessage → error_message
      expect(m.started_at).toBe(rs.startedAt); // ★ startedAt → started_at
    }
  });
});
