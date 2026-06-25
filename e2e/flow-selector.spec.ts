import { test, expect, type Page } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

// The New-monitor (free-form create) FLOW selector. Its source is now the Git manifest (spec_catalog)
// — the SAME list the /specs catalog + /monitors drift surface use — not just runner-baked flows. So a
// spec defined in Git but never run (recipe-nav) is selectable here, and the picker is a real combobox
// (name + description inline), not a native datalist + floating tooltip.
function worldWithSpecs() {
  const w = defaultWorld();
  w.specCatalog = {
    items: [
      {
        sourceKey: "wegmans-recipe-nav", name: "Wegmans: recipe navigation",
        specPath: "monitors/wegmans/recipe-nav.spec.ts", kind: "browser",
        target: "https://www.wegmans.com", suggestedIntervalSeconds: 1800, tags: [],
        description: "Navigate to a recipe and assert it loads.", enabledByDefault: false,
        runnable: true, notRunnableReason: null, monitored: false, checkId: null, checkName: null, enabled: null, health: null,
      },
      {
        sourceKey: "wegmans-search-product", name: "Wegmans: search → product",
        specPath: "monitors/wegmans/search-product.spec.ts", kind: "browser",
        target: "https://www.wegmans.com", suggestedIntervalSeconds: 1800, tags: [],
        description: "Search and open a product page.", enabledByDefault: false,
        runnable: true, notRunnableReason: null, monitored: false, checkId: null, checkName: null, enabled: null, health: null,
      },
      {
        // already monitored → must NOT appear (one check per source_key; a 2nd would 409)
        sourceKey: "already-live", name: "Already monitored",
        specPath: "monitors/x/already.spec.ts", kind: "browser", target: null,
        suggestedIntervalSeconds: null, tags: [], description: "Already has a live check.",
        enabledByDefault: false, runnable: true, notRunnableReason: null,
        monitored: true, checkId: 7, checkName: "Already monitored", enabled: true, health: null,
      },
    ],
  };
  return w;
}

async function openBrowserForm(page: Page) {
  await page.goto("/monitors");
  await page.getByRole("button", { name: "+ New monitor" }).first().click();
  await page.getByRole("heading", { name: "New monitor" }).waitFor();
  await page.getByRole("button", { name: "Browser", exact: true }).click();
}

const postCheck = (page: Page) =>
  page.waitForRequest((r) => r.url().endsWith("/api/checks") && r.method() === "POST");

test.describe("New-monitor flow selector", () => {
  test("lists Git-manifest specs incl. the never-run recipe-nav, with description inline", async ({ page }) => {
    await mockApi(page, worldWithSpecs());
    await openBrowserForm(page);

    await page.getByTestId("flow-combobox-input").click();
    const list = page.getByTestId("flow-combobox-list");
    await expect(list).toBeVisible();

    // ★ the originally-missing spec is now selectable, name + description shown INLINE in the row.
    const recipe = page.getByTestId("flow-option-recipe-nav");
    await expect(recipe).toBeVisible();
    await expect(recipe).toContainText("Wegmans: recipe navigation");
    await expect(recipe).toContainText("Navigate to a recipe and assert it loads.");
    await expect(page.getByTestId("flow-option-search-product")).toBeVisible();

    // a monitored spec is filtered out (can't create a second check for it).
    await expect(page.getByTestId("flow-option-already")).toHaveCount(0);

    // no native datalist (the old floating-tooltip pattern) remains.
    await expect(page.locator("datalist#sw-flows")).toHaveCount(0);
  });

  test("selecting a spec binds spec_path + source_key in the create payload", async ({ page }) => {
    await mockApi(page, worldWithSpecs());
    await openBrowserForm(page);

    await page.getByPlaceholder("Checkout flow — production").fill("Recipe nav monitor");
    await page.getByTestId("flow-combobox-input").click();
    await page.getByTestId("flow-option-recipe-nav").click();

    // input now holds the synthetic flow value; the spec-bound note shows the spec_path.
    await expect(page.getByTestId("flow-combobox-input")).toHaveValue("recipe-nav");
    await expect(page.getByTestId("flow-spec-bound")).toContainText("monitors/wegmans/recipe-nav.spec.ts");

    const reqP = postCheck(page);
    await page.getByRole("button", { name: "Create monitor" }).click();
    const body = JSON.parse((await reqP).postData() || "{}");
    // camelCase on the wire (toCamelBody): the runner fetches+runs the Git spec next tick.
    expect(body.specPath).toBe("monitors/wegmans/recipe-nav.spec.ts");
    expect(body.sourceKey).toBe("wegmans-recipe-nav");
    expect(body.flowName).toBe("recipe-nav"); // synthetic flow satisfies browser_needs_flow
    expect(body.targetUrl).toBe("https://www.wegmans.com"); // prefilled from the spec's target
  });

  test("typing a new flow name keeps the 'type new' affordance (no spec binding)", async ({ page }) => {
    await mockApi(page, worldWithSpecs());
    await openBrowserForm(page);

    await page.getByPlaceholder("Checkout flow — production").fill("Custom flow monitor");
    await page.getByPlaceholder("https://example.com/health").fill("https://example.com/app");
    const input = page.getByTestId("flow-combobox-input");
    await input.click();
    await input.fill("brand-new-flow");
    await expect(page.getByTestId("flow-spec-bound")).toHaveCount(0); // not a spec

    const reqP = postCheck(page);
    await page.getByRole("button", { name: "Create monitor" }).click();
    const body = JSON.parse((await reqP).postData() || "{}");
    expect(body.flowName).toBe("brand-new-flow");
    expect(body.specPath ?? null).toBeNull();
    expect(body.sourceKey ?? null).toBeNull();
  });
});
