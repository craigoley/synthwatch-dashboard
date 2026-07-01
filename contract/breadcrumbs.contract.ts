import { test, expect } from "@playwright/test";

import {
  BreadcrumbRing,
  RING_CAPACITY,
  clearBreadcrumbs,
  getBreadcrumbs,
  record,
  recordFromErrorEvent,
  recordFromRejection,
} from "@/lib/breadcrumbs";
import { isDebugOn } from "@/lib/debug";

/**
 * Client breadcrumb ring — pure-logic contract (runs in the no-browser Node harness). Pins the invariants the
 * debug panel depends on: bounded eviction, faithful capture of the three sources (onerror / unhandledrejection
 * / boundary), and that the panel's gate is OFF by default (no window → isDebugOn false). The live browser
 * gate-ON + capture path is covered by e2e (breadcrumbs.spec.ts).
 */

test("ring evicts oldest past capacity", () => {
  const r = new BreadcrumbRing(3);
  for (let i = 0; i < 5; i++) {
    r.push({ ts: i, source: "boundary", message: `m${i}`, route: "/" });
  }
  expect(r.size).toBe(3);
  const msgs = r.entries().map((b) => b.message);
  expect(msgs).toEqual(["m2", "m3", "m4"]); // oldest (m0, m1) evicted
});

test("default ring capacity is bounded + small", () => {
  expect(RING_CAPACITY).toBe(50);
  expect(new BreadcrumbRing().size).toBe(0);
});

test("captures window error, unhandled rejection, and a boundary error", () => {
  clearBreadcrumbs();
  recordFromErrorEvent({ message: "script boom", error: new TypeError("cannot read 'tone'") });
  recordFromRejection({ reason: new Error("fetch failed") });
  record("boundary", "render threw", "digest-abc123");

  const got = getBreadcrumbs();
  expect(got).toHaveLength(3);

  expect(got[0]?.source).toBe("onerror");
  expect(got[0]?.message).toContain("cannot read 'tone'");

  expect(got[1]?.source).toBe("unhandledrejection");
  expect(got[1]?.message).toContain("fetch failed");

  expect(got[2]?.source).toBe("boundary");
  expect(got[2]?.message).toBe("render threw");
  expect(got[2]?.digest).toBe("digest-abc123"); // Next digest preserved for cross-referencing
});

test("clear empties the ring", () => {
  record("boundary", "x");
  expect(getBreadcrumbs().length).toBeGreaterThan(0);
  clearBreadcrumbs();
  expect(getBreadcrumbs()).toHaveLength(0);
});

test("gate is OFF with no window (server / default) — panel stays hidden", () => {
  expect(isDebugOn("errors")).toBe(false);
});
