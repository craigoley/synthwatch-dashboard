import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

/**
 * Egress stability section on /status — the Wegmans allowlist artifact + the SNAT-rotation early-warning.
 * The whole point of the panel is that a ROTATION (distinctCount ≥ 2) is LOUD, not buried; the ★ test proves
 * the warn treatment fires (a test that passed whether or not it were loud would be the wrong test).
 */
test.describe("status — egress stability", () => {
  test("stable: 1 IP per region → calm green 'Stable', IP prominent + copy-friendly", async ({ page }) => {
    await mockApi(page, defaultWorld()); // DEFAULT_EGRESS = 3 regions, 1 IP each
    await page.goto("/status");

    await expect(page.getByTestId("egress-section")).toBeVisible();
    // each region shows the STABLE badge (not rotation) + its IP, copy-friendly
    for (const [loc, ip] of [
      ["eastus2", "20.85.72.149"],
      ["centralus", "172.169.169.109"],
      ["westus2", "20.80.135.196"],
    ] as const) {
      await expect(page.getByTestId(`egress-stable-${loc}`)).toBeVisible();
      await expect(page.getByTestId(`egress-stable-${loc}`)).toContainText("Stable");
      await expect(page.getByTestId(`egress-ip-${loc}`)).toContainText(ip);
      await expect(page.getByTestId(`egress-copy-${loc}`)).toBeVisible();
      // no rotation warning when stable
      await expect(page.getByTestId(`egress-rotation-${loc}`)).toHaveCount(0);
    }
    await expect(page.getByTestId("egress-copy-all")).toBeVisible(); // the allowlist artifact
  });

  test("★ rotation-is-LOUD: distinctCount ≥ 2 → warn 'Rotation detected', auto-expanded, 2nd IP's first-seen shown", async ({ page }) => {
    const w = defaultWorld();
    // eastus2 rotated: a 2nd IP appeared on 2026-07-01 — the allowlist is now stale.
    w.egressRegions = [
      {
        location: "eastus2",
        currentIps: ["20.85.72.149", "20.85.99.42"],
        distinctCount: 2,
        firstSeen: "2026-06-30T22:00:00Z",
        lastSeen: "2026-07-01T15:56:00Z",
        runCount: 1249,
        ips: [
          { ip: "20.85.72.149", firstSeen: "2026-06-30T22:00:00Z", lastSeen: "2026-07-01T09:00:00Z", runCount: 900 },
          { ip: "20.85.99.42", firstSeen: "2026-07-01T09:30:00Z", lastSeen: "2026-07-01T15:56:00Z", runCount: 349 },
        ],
      },
    ];
    await mockApi(page, w);
    await page.goto("/status");

    // ★ the LOUD treatment fires — rotation badge present, calm 'Stable' badge NOT
    const rotation = page.getByTestId("egress-rotation-eastus2");
    await expect(rotation).toBeVisible();
    await expect(rotation).toContainText("Rotation detected");
    await expect(rotation).toContainText("2 IPs");
    await expect(page.getByTestId("egress-stable-eastus2")).toHaveCount(0); // NOT rendered calmly

    // auto-expanded (no click): both IPs listed, with the 2nd IP's first-seen (the rotation moment) shown
    const ips = page.getByTestId("egress-ips-eastus2");
    await expect(ips).toBeVisible();
    await expect(ips).toContainText("20.85.99.42");
    await expect(page.getByTestId("egress-firstseen-20.85.99.42")).toBeVisible();
  });

  test("null-safe: endpoint 404 → the section self-hides (no crash), rest of /status renders", async ({ page }) => {
    const w = defaultWorld();
    w.reportsServed = false; // GET /reports/egress 404s (endpoint not deployed yet)
    await mockApi(page, w);
    await page.goto("/status");

    await expect(page.getByTestId("egress-section")).toHaveCount(0); // gone, not broken
    // the page itself still works (the overall status banner renders)
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
});
