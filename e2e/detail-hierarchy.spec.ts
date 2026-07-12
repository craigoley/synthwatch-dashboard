import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";
import { detail, run } from "./fixtures";

/**
 * Detail-page information hierarchy — env demoted to a config chip, Trust split into summary + one
 * disclosure. The tests that matter are the EXCEPTION-VISIBILITY ones: progressive disclosure that hides
 * exceptions makes the tool worse, so a manual env override and every bad Trust state must be visible on
 * load WITHOUT opening anything — only the boring collapses. And nothing became unreachable: every element
 * of the old ENVIRONMENT card and every Trust datum is ≤1 deliberate tap away.
 */

const FULL_SHA = "4b8617890123456789abcdef0123456789abcdef0123456789abcdef01234567"; // 64 chars

test.describe("environment — a config chip, not a card", () => {
  test("derived (normal) case: a neutral chip in the config row; the old card is gone; ONE tap reaches everything", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/checks/1"); // env defaults prod, no override

    // the chip lives IN the config row, closed by default — no standalone card, no overridden marker
    const row = page.getByTestId("config-row");
    const chip = row.getByTestId("env-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("prod");
    await expect(page.getByTestId("env-chip-overridden")).toHaveCount(0);
    await expect(page.getByTestId("env-disclosure")).toHaveCount(0);

    // ONE tap → the ENTIRE old card: explainer, selector, Clear override, guardrail copy + Settings link
    await chip.click();
    const panel = page.getByTestId("env-disclosure");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Derived as prod");
    await expect(panel).toContainText("No manual override set");
    await expect(panel.getByTestId("env-set-prod")).toBeVisible();
    await expect(panel.getByTestId("env-set-staging")).toBeVisible();
    await expect(panel.getByTestId("env-set-dev")).toBeVisible();
    await expect(panel.getByTestId("env-clear-override")).toBeVisible();
    await expect(panel.getByTestId("env-clear-override")).toBeDisabled(); // no override to clear
    await expect(panel).toContainText("never gets clobbered by a reconcile");
    await expect(panel.getByRole("link", { name: "Settings → Environments" })).toHaveAttribute(
      "href",
      "/settings/environments",
    );

    // second tap closes it again (a toggle, not a one-way reveal)
    await chip.click();
    await expect(page.getByTestId("env-disclosure")).toHaveCount(0);
  });

  test("★ override (exception) case: the OVERRIDDEN marker is visible ON LOAD, warn-toned, without opening anything", async ({ page }) => {
    const w = defaultWorld();
    w.details[355] = detail(
      { id: 355, name: "Wegmans PREVIEW checkout", kind: "browser", environment: "staging", environmentOverride: "prod" },
      [run({ id: 900, checkId: 355, status: "pass" })],
    );
    await mockApi(page, w);
    await page.goto("/checks/355");

    // ★ the exception SHOUTS on load — no tap needed
    const marker = page.getByTestId("env-chip-overridden");
    await expect(marker).toBeVisible();
    await expect(marker).toContainText(/overridden/i);
    // warn-toned (the attention color token), distinct from the neutral derived chip
    const color = await marker.evaluate((el) => getComputedStyle(el).color);
    const neutral = await page
      .getByTestId("config-row")
      .locator("span", { hasText: /^Interval$/ })
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    expect(color).not.toBe(neutral);
    await expect(page.getByTestId("env-disclosure")).toHaveCount(0); // still closed — the marker alone carries it

    // one tap → the override story + a now-enabled Clear override
    await page.getByTestId("env-chip").click();
    const panel = page.getByTestId("env-disclosure");
    await expect(panel).toContainText("Manually overridden");
    await expect(panel).toContainText("the derived env is staging");
    await expect(panel).toContainText("This override survives reconcile");
    await expect(panel.getByTestId("env-clear-override")).toBeEnabled();
  });
});

test.describe("trust — glance summary + one disclosure, exceptions never collapsed", () => {
  test("★ a non-zero incident count sits in the SUMMARY on load; tapping it opens the by-cause breakdown", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/checks/3"); // incidents total 3 (real 1, perf 1, unclassified 1)

    const card = page.getByTestId("trust-card");
    // ★ exception visible without opening anything
    const count = card.getByTestId("trust-incidents-count");
    await expect(count).toBeVisible();
    await expect(count).toContainText("3");
    await expect(card.getByTestId("trust-details-body")).toHaveCount(0); // disclosure still closed
    // the honest red-test gap also stays in the glance layer
    await expect(card.getByTestId("trust-redtest")).toContainText("not captured");

    // tapping the count IS the one tap to the breakdown
    await count.click();
    await expect(card.getByTestId("trust-details-body")).toBeVisible();
    await expect(card.getByTestId("trust-incident-real_outage")).toContainText("1");
    await expect(card.getByTestId("trust-incident-perf_regression")).toContainText("1");
  });

  test("a ZERO incident count adds nothing to the summary (a good state doesn't spend glance space)", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/checks/1"); // incidents total 0
    await expect(page.getByTestId("trust-card")).toBeVisible();
    await expect(page.getByTestId("trust-incidents-count")).toHaveCount(0);
  });

  test("spec integrity: SHORT sha + copy affordance in the summary; the full 64-char hash one tap away (never two wrapped lines at a glance)", async ({ page }) => {
    const w = defaultWorld();
    w.trustMonitors = [
      {
        checkId: 3, checkName: "Checkout flow", lastGreenAt: "2026-07-11T12:00:00Z",
        runCount: 300, retryCount: 60, retryRate: 0.2, incidents: {
          total: 0, realOutage: 0, flakyTransient: 0, selectorDrift: 0, environmentRegional: 0, perfRegression: 0, unclassified: 0,
        },
        redTest: { captured: false },
        specProvenance: { executedSha256: FULL_SHA, specPath: "monitors/shop/checkout.spec.ts" },
        trust: "nominal",
      },
    ];
    await mockApi(page, w);
    await page.goto("/checks/3");

    const card = page.getByTestId("trust-card");
    // summary: the 8-char short form + copy affordance — NOT the full hash
    const short = card.getByTestId("trust-spec-short");
    await expect(short).toBeVisible();
    await expect(short).toContainText(FULL_SHA.slice(0, 8));
    await expect(card.getByTestId("trust-spec-copy")).toBeVisible();
    await expect(card).not.toContainText(FULL_SHA);

    // one tap → the forensic layer: full hash + spec path
    await card.getByTestId("trust-details-toggle").click();
    await expect(card.getByTestId("trust-provenance")).toContainText(FULL_SHA);
    await expect(card.getByTestId("trust-provenance")).toContainText("monitors/shop/checkout.spec.ts");
  });
});

test.describe("mobile (390px, touch) — tap-driven, card height reclaimed", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("no standalone env card, no horizontal overflow, and the disclosures open by TAP (not hover)", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/checks/3");
    await expect(page.getByTestId("config-row")).toBeVisible();

    // the old full-width ENVIRONMENT card is gone — env renders only as the chip in the config row
    await expect(page.locator(".sw-eyebrow", { hasText: "Environment" })).toHaveCount(0);
    // no horizontal overflow at phone width
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);

    // tap-driven disclosure — a real touch tap, no hover involved
    await page.getByTestId("env-chip").tap();
    await expect(page.getByTestId("env-disclosure")).toBeVisible();
    await page.getByTestId("trust-details-toggle").tap();
    await expect(page.getByTestId("trust-details-body")).toBeVisible();
  });
});
