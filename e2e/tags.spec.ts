import { test, expect, type Page } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

async function openNewMonitor(page: Page) {
  await page.goto("/monitors");
  await page.getByRole("button", { name: "+ New monitor" }).first().click();
  await page.getByRole("heading", { name: "New monitor" }).waitFor();
  // editor renders once /api/tags/suggested responds
  await page.getByLabel("tag key").waitFor();
}

// Phase 9a tags — editor in the monitor form + chip display on checks. Built to the
// contract (GET /tags/suggested, GET/PUT /checks/{id}/tags); mock implements it.
test.describe("tags editor", () => {
  test("add a key:value tag → it shows as a removable chip", async ({ page }) => {
    await mockApi(page);
    await openNewMonitor(page);
    await page.getByLabel("tag key").fill("env");
    await page.getByLabel("tag value").fill("prod");
    await page.getByRole("button", { name: "+ Add tag" }).click();

    const chips = page.getByTestId("tag-editor-chips");
    await expect(chips).toContainText("env");
    await expect(chips).toContainText("prod");
    await expect(page.getByRole("button", { name: "remove tag env" })).toBeVisible();
  });

  test("remove a tag", async ({ page }) => {
    await mockApi(page);
    await openNewMonitor(page);
    await page.getByLabel("tag key").fill("team");
    await page.getByLabel("tag value").fill("sre");
    await page.getByRole("button", { name: "+ Add tag" }).click();
    await expect(page.getByTestId("tag-editor-chips")).toContainText("sre");

    await page.getByRole("button", { name: "remove tag team" }).click();
    await expect(page.getByTestId("tag-editor-chips")).toHaveCount(0); // no chips left
  });

  test("suggested keys are offered as autocomplete", async ({ page }) => {
    await mockApi(page);
    await openNewMonitor(page);
    const opts = page.locator("#sw-tag-keys option");
    await expect(opts).toHaveCount(4);
    await expect(opts.nth(0)).toHaveAttribute("value", "env");
    await expect(page.locator('#sw-tag-keys option[value="criticality"]')).toHaveCount(1);
  });

  test("one value per key — re-adding a key replaces its value", async ({ page }) => {
    await mockApi(page);
    await openNewMonitor(page);
    const k = page.getByLabel("tag key");
    const v = page.getByLabel("tag value");
    const add = page.getByRole("button", { name: "+ Add tag" });

    await k.fill("env"); await v.fill("prod"); await add.click();
    await k.fill("env"); await v.fill("staging"); await add.click();

    const chips = page.getByTestId("tag-editor-chips");
    await expect(chips).toContainText("staging");
    await expect(chips).not.toContainText("prod"); // replaced, not duplicated
    await expect(page.getByRole("button", { name: "remove tag env" })).toHaveCount(1);
  });

  test("keys/values are normalized to lowercase", async ({ page }) => {
    await mockApi(page);
    await openNewMonitor(page);
    await page.getByLabel("tag key").fill("ENV");
    await page.getByLabel("tag value").fill("PROD");
    await page.getByRole("button", { name: "+ Add tag" }).click();
    const chips = page.getByTestId("tag-editor-chips");
    await expect(chips).toContainText("env");
    await expect(chips).toContainText("prod");
    await expect(chips).not.toContainText("ENV");
  });

  test("on save, PUTs the tag set to /checks/{id}/tags", async ({ page }) => {
    await mockApi(page);
    await openNewMonitor(page);
    await page.locator("input").first().fill("Tagged check");
    await page.locator('input[inputmode="url"]').fill("https://example.com/health");
    await page.getByLabel("tag key").fill("service");
    await page.getByLabel("tag value").fill("api");
    await page.getByRole("button", { name: "+ Add tag" }).click();

    const put = page.waitForRequest((r) => /\/api\/checks\/\d+\/tags$/.test(r.url()) && r.method() === "PUT");
    await page.getByRole("button", { name: /Create monitor/ }).click();
    const body = (await put).postDataJSON();
    expect(body.tags).toEqual([{ key: "service", value: "api" }]);
  });

  test("editing a check auto-saves a tag on add — no modal submit needed (Fix A)", async ({ page }) => {
    await mockApi(page);
    await page.goto("/checks/1");
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const modal = page.getByRole("dialog");
    await modal.getByLabel("tag key").waitFor();
    await expect(modal.getByText("Tags save automatically.")).toBeVisible();

    // Adding a chip fires the PUT IMMEDIATELY (the old bug: it only staged, lost if unsubmitted).
    const put = page.waitForRequest((r) => /\/api\/checks\/1\/tags$/.test(r.url()) && r.method() === "PUT");
    await modal.getByLabel("tag key").fill("team");
    await modal.getByLabel("tag value").fill("test");
    await modal.getByRole("button", { name: "+ Add tag" }).click();
    const body = (await put).postDataJSON();
    expect(body.tags).toContainEqual({ key: "team", value: "test" });
  });

  test("graceful pre-API: /tags/suggested 404 → editor hidden", async ({ page }) => {
    const world = defaultWorld();
    world.suggestedKeys = undefined; // 404
    await mockApi(page, world);
    await page.goto("/monitors");
    await page.getByRole("button", { name: "+ New monitor" }).first().click();
    await page.getByRole("heading", { name: "New monitor" }).waitFor();
    // the rest of the form still works; the tag editor just isn't there
    await expect(page.getByLabel("tag key")).toHaveCount(0);
    await expect(page.getByRole("dialog").getByText("Tags", { exact: true })).toHaveCount(0);
  });
});

test.describe("tags display", () => {
  test("a check's tags render as chips on its card", async ({ page }) => {
    const world = defaultWorld();
    // tags are embedded in the check list payload (check 1 = "API health")
    world.checks = world.checks.map((c) =>
      c.id === 1 ? { ...c, tags: [{ key: "env", value: "prod" }, { key: "team", value: "sre" }] } : c,
    );
    await mockApi(page, world);
    await page.goto("/");

    const card = page.locator('a[href="/checks/1"]');
    const chips = card.getByTestId("tag-chips");
    await expect(chips).toContainText("env");
    await expect(chips).toContainText("prod");
    await expect(chips).toContainText("sre");
    // a check WITHOUT tags shows no chip row
    await expect(page.locator('a[href="/checks/2"]').getByTestId("tag-chips")).toHaveCount(0);
  });
});
