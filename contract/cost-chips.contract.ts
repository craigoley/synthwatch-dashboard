import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getNarrative } from "@/lib/api-client";

/**
 * Anchor the Layer-3 cost-citation chips: `toFactChips` derives cost chips from the STRUCTURED
 * `factPack.cost` the runner writes ({ fleetProjected, fleetMeasured, fleetDivergence, notable:[…] }), NOT the
 * narrative prose. Anchored against the REAL captured fleet narrative (narrative_fleet_7d.json — live cost
 * present). A rename of a cost key must FAIL the chip pin, not silently drop the citation.
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

const chip = (facts: { label: string; value: string; delta?: string | null }[], label: string) =>
  facts.find((f) => f.label === label);

test.describe("API contract — Layer-3 cost-citation chips (fact-pack sourced)", () => {
  test("fleet narrative: cost chips derive from factPack.cost, field-for-field", async () => {
    const raw = real("narrative_fleet_7d");
    // Pin the real structured cost shape the chips read.
    expect(raw.factPack, "factPack carries a structured cost object (not prose)").toHaveProperty("cost");
    const cost = raw.factPack.cost as {
      fleetProjected: number;
      fleetMeasured: number;
      fleetDivergence: number;
      notable: { name: string; projected: number; divergenceFlag: boolean }[];
    };
    expect(cost.fleetProjected, "fixture is a real cost-bearing narrative").toBeGreaterThan(0);

    const res = await withRealResponse(raw, () => getNarrative("fleet", "7d"));
    const facts = res!.factPack;

    // ★ Cost chips cite the REAL fact-pack figures, verbatim.
    expect(chip(facts, "Proj. cost")?.value).toBe(`$${cost.fleetProjected.toFixed(2)}/mo`);
    expect(chip(facts, "Measured")?.value).toBe(`$${cost.fleetMeasured.toFixed(2)}/mo`);
    // divergence (measured/projected) → signed % under/over projected
    const expectedPct = Math.round((cost.fleetDivergence - 1) * 100);
    expect(chip(facts, "Measured")?.delta).toBe(`${expectedPct >= 0 ? "+" : ""}${expectedPct}%`);
    // top cost driver from notable[0], cited with its projected $ + name
    const top0 = cost.notable[0]!;
    expect(chip(facts, "Top cost")?.value).toBe(`$${top0.projected.toFixed(2)}/mo`);
    expect(chip(facts, "Top cost")?.delta).toContain(top0.name.slice(0, 10));
    // the existing reliability chips are untouched (no regression)
    expect(chip(facts, "Availability")).toBeTruthy();
  });

  // ★ MUST-GO-RED: rename the pinned cost key → the mapper reads undefined → the Proj. cost chip vanishes.
  test("teeth: renaming factPack.cost.fleetProjected drops the cost chips", async () => {
    const raw = real("narrative_fleet_7d");
    raw.factPack.cost.fleet_projected = raw.factPack.cost.fleetProjected; // API renamed to snake_case
    delete raw.factPack.cost.fleetProjected;
    const res = await withRealResponse(raw, () => getNarrative("fleet", "7d"));
    expect(chip(res!.factPack, "Proj. cost"), "no fleetProjected key → no cost chip").toBeUndefined();
    expect(chip(res!.factPack, "Measured")).toBeUndefined();
    // reliability chips still render — the cost branch is self-contained
    expect(chip(res!.factPack, "Availability")).toBeTruthy();
  });

  // Graceful absence: an OLDER narrative with no cost object renders zero cost chips (no crash, no fake $0).
  test("graceful: a narrative with no factPack.cost renders no cost chips", async () => {
    const raw = real("narrative_fleet_7d");
    delete raw.factPack.cost;
    const res = await withRealResponse(raw, () => getNarrative("fleet", "7d"));
    expect(chip(res!.factPack, "Proj. cost")).toBeUndefined();
    expect(chip(res!.factPack, "Top cost")).toBeUndefined();
    expect(res!.factPack.length, "reliability chips still present").toBeGreaterThan(0);
  });

  // Scope guard: a MONITOR-scope pack must not cite the whole fleet's cost.
  test("scope guard: monitor-scope pack does not emit fleet cost chips", async () => {
    const raw = real("narrative_fleet_7d");
    raw.factPack.scopeType = "monitor"; // same cost object, but scoped to one monitor
    const res = await withRealResponse(raw, () => getNarrative("monitor", "7d", 1));
    expect(chip(res!.factPack, "Proj. cost"), "fleet cost is not cited on a monitor card").toBeUndefined();
  });
});
