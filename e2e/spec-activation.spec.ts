import { test, expect, type Page } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

// A catalog with one UNMONITORED + runnable spec (the activation target) and one ORPHAN (not runnable).
function worldWithUnmonitored() {
  const w = defaultWorld();
  w.specCatalog = {
    items: [
      {
        sourceKey: "wegmans-search-product",
        name: "Wegmans — search product",
        specPath: "monitors/wegmans/search-product.spec.ts",
        kind: "browser",
        target: "https://www.wegmans.com",
        suggestedIntervalSeconds: 600,
        tags: ["team:web", "journey:search"],
        runnable: true,
        notRunnableReason: null,
        monitored: false,
        checkId: null,
        checkName: null,
        enabled: null,
        health: null,
      },
      {
        sourceKey: "broken-spec",
        name: "Broken Mon",
        specPath: "monitors/broken/broken.spec.ts",
        kind: "browser",
        target: null,
        suggestedIntervalSeconds: null,
        tags: [],
        runnable: false,
        notRunnableReason: "won't compile: SyntaxError",
        monitored: false,
        checkId: null,
        checkName: null,
        enabled: null,
        health: null,
      },
    ],
  };
  return w;
}

const dialog = (page: Page) => page.getByRole("dialog");

test.describe("phase 13 — spec activation (set up monitor)", () => {
  test("Unmonitored+Runnable → prefilled/locked form → submit creates the monitor → row flips Active", async ({ page }) => {
    await mockApi(page, worldWithUnmonitored());
    await page.goto("/specs");

    const setup = page.getByTestId("setup-wegmans-search-product");
    await expect(setup).toBeEnabled();
    await setup.click();

    // Modal opens with the LOCKED spec identity banner (kind=browser, spec_path, synthetic flow_name)…
    await expect(dialog(page).getByTestId("activation-banner")).toContainText("monitors/wegmans/search-product.spec.ts");
    await expect(dialog(page).getByTestId("activation-banner")).toContainText("search-product"); // synthetic flow
    // …and the editable identity PREFILLED from the manifest (name + target + interval).
    await expect(dialog(page).getByPlaceholder("Checkout flow — production")).toHaveValue("Wegmans — search product");
    await expect(dialog(page).locator('input[inputmode="url"]')).toHaveValue("https://www.wegmans.com");

    // Submit → POST /api/checks carries the locked spec binding + synthetic flow_name + browser kind.
    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().endsWith("/api/checks") && r.method() === "POST"),
      dialog(page).getByRole("button", { name: "Set up monitor" }).click(),
    ]);
    const body = req.postDataJSON();
    expect(body.specPath).toBe("monitors/wegmans/search-product.spec.ts");
    expect(body.sourceKey).toBe("wegmans-search-product");
    expect(body.flowName).toBe("search-product"); // flowNameFor(spec_path), satisfies browser_needs_flow
    expect(body.kind).toBe("browser");
    // ★ Interval round-trips through the minutes UI: suggested 600s → shown as 10 min → sent back as 600s.
    expect(body.intervalSeconds).toBe(600);

    // The catalog re-reads → the spec is now MONITORED, so it leaves the default "not set up" view (#141:
    // the catalog defaults to not-set-up). Switch to "All" to confirm the row flipped Unmonitored → Active.
    await page.getByTestId("view-all").click();
    await expect
      .poll(() => page.getByTestId("spec-row-wegmans-search-product").getAttribute("data-coverage"))
      .toBe("active");
  });

  test("Orphan (not runnable) → 'Set up monitor' is DISABLED with the reason", async ({ page }) => {
    await mockApi(page, worldWithUnmonitored());
    await page.goto("/specs");

    const setup = page.getByTestId("setup-broken-spec");
    await expect(setup).toBeDisabled();
    await expect(setup).toHaveAttribute("title", /won't compile/);
    await expect(page.getByTestId("setup-blocked-broken-spec")).toBeVisible(); // fix-in-Git hint
    await expect(page.getByTestId("spec-row-broken-spec")).toContainText("won't compile"); // probe reason

    // An Active/Paused row has NO activation button (it already has a check) — sanity that the button
    // is scoped to Unmonitored rows only.
    await expect(page.getByTestId("setup-wegmans-search-product")).toBeEnabled();
  });

  test("duplicate source_key → a clear 'already exists' message (the API 409)", async ({ page }) => {
    const w = worldWithUnmonitored();
    w.createResponse = {
      status: 409,
      body: { error: "conflict", message: "A monitor for spec 'wegmans-search-product' already exists." },
    };
    await mockApi(page, w);
    await page.goto("/specs");

    await page.getByTestId("setup-wegmans-search-product").click();
    await dialog(page).getByRole("button", { name: "Set up monitor" }).click();

    await expect(dialog(page).getByText("A monitor for this spec already exists.")).toBeVisible();
    // The modal stays open (the activation didn't complete).
    await expect(dialog(page)).toBeVisible();
    // ★ A FAILED setup leaves NO phantom row: the create threw → no cache invalidation → the row reflects
    // truth (still unmonitored), never an optimistic "active" lie that didn't persist.
    await expect(page.getByTestId("spec-row-wegmans-search-product")).not.toHaveAttribute("data-coverage", "active");
  });
});
