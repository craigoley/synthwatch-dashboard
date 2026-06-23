import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

// Dashboard-managed alerting — channels + routing settings page. Built to the API
// contract (GET/POST /channels, PUT/DELETE /channels/{id}, GET/PUT /routing);
// the mock implements it statefully, so CRUD + routing saves are end-to-end verified.
test.describe("notifications settings", () => {
  test("create an email channel (recipients + from) → appears in the list", async ({ page }) => {
    await mockApi(page); // channels: []
    await page.goto("/notifications");

    await page.getByRole("button", { name: "+ New channel" }).first().click();
    await page.getByRole("heading", { name: "New channel" }).waitFor();
    await page.getByLabel("Name", { exact: true }).fill("On-call email");
    // type defaults to email; recipients only — the sender is a transport property
    await page.getByLabel("recipients").fill("oncall@example.com, sre@example.com");
    await page.getByRole("button", { name: "Create channel" }).click();

    await expect(page.getByTestId("channel-list").getByText("On-call email")).toBeVisible();
    await expect(page.getByText("oncall@example.com, sre@example.com")).toBeVisible();
  });

  test("create a webhook channel (URL)", async ({ page }) => {
    await mockApi(page);
    await page.goto("/notifications");
    await page.getByRole("button", { name: "+ New channel" }).first().click();
    await page.getByLabel("Name", { exact: true }).fill("Slack hook");
    await page.getByRole("button", { name: "webhook" }).click();
    await page.getByLabel("webhook url").fill("https://hooks.example.com/sw");
    await page.getByRole("button", { name: "Create channel" }).click();

    await expect(page.getByTestId("channel-list").getByText("Slack hook")).toBeVisible();
    await expect(page.getByText("https://hooks.example.com/sw")).toBeVisible();
  });

  test("edit then delete a channel", async ({ page }) => {
    const world = defaultWorld();
    world.channels = [
      { id: 1, name: "Old name", type: "email", config: { to: ["a@b.com"], from: "x@b.com" }, enabled: true },
    ];
    await mockApi(page, world);
    await page.goto("/notifications");

    await page.getByRole("button", { name: "Edit" }).first().click();
    await page.getByRole("heading", { name: /Edit ·/ }).waitFor();
    await page.getByLabel("Name", { exact: true }).fill("Renamed channel");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByTestId("channel-list").getByText("Renamed channel")).toBeVisible();

    await page.getByRole("button", { name: "Delete" }).first().click();
    await page.getByRole("button", { name: "Delete channel" }).click();
    await expect(page.getByText("Renamed channel")).toHaveCount(0);
    await expect(page.getByTestId("no-delivery")).toBeVisible(); // back to "not delivering"
  });

  test("set severity routing (fail → channel) and save (PUTs it)", async ({ page }) => {
    const world = defaultWorld();
    world.channels = [
      { id: 1, name: "On-call", type: "email", config: { to: ["a@b.com"], from: "x@b.com" }, enabled: true },
    ];
    await mockApi(page, world);
    await page.goto("/notifications");

    const chip = page.getByRole("checkbox", { name: "route fail to On-call" });
    await chip.click();
    await expect(chip).toHaveAttribute("aria-checked", "true");

    const put = page.waitForRequest((r) => r.url().endsWith("/api/routing") && r.method() === "PUT");
    await page.getByRole("button", { name: "Save routing" }).click();
    const body = (await put).postDataJSON();
    expect(body.defaults.fail.channelIds).toEqual([1]);
  });

  test("per-check override routes a check to a channel", async ({ page }) => {
    const world = defaultWorld();
    world.channels = [
      { id: 1, name: "On-call", type: "email", config: { to: ["a@b.com"], from: "x@b.com" }, enabled: true },
    ];
    await mockApi(page, world);
    await page.goto("/notifications");

    // check 1 = "API health" (from defaultChecks)
    await page.getByLabel("add per-check override").selectOption({ label: "API health" });
    await page.getByRole("checkbox", { name: "override 1 to On-call" }).click();

    const put = page.waitForRequest((r) => r.url().endsWith("/api/routing") && r.method() === "PUT");
    await page.getByRole("button", { name: "Save routing" }).click();
    const body = (await put).postDataJSON();
    expect(body.overrides["1"].channelIds).toEqual([1]);
  });

  test("validation: an email channel with no recipient is blocked", async ({ page }) => {
    await mockApi(page);
    await page.goto("/notifications");
    await page.getByRole("button", { name: "+ New channel" }).first().click();
    await page.getByLabel("Name", { exact: true }).fill("Bad email");
    // leave recipients + from blank
    await page.getByRole("button", { name: "Create channel" }).click();

    await expect(page.getByText("Add at least one recipient email address.")).toBeVisible();
    // not created — still "no channels"
    await expect(page.getByText("Bad email")).toHaveCount(0);
  });

  test("★ no sender/credential field — only the ACS transport note", async ({ page }) => {
    await mockApi(page);
    await page.goto("/notifications");
    await page.getByRole("button", { name: "+ New channel" }).first().click();
    const dialog = page.getByRole("dialog");
    // honest note that the sender + creds live in infra, not here
    await expect(dialog.getByText(/configured ACS sender/)).toBeVisible();
    // no sender field and no password/secret input anywhere in the form
    await expect(dialog.getByLabel("from address")).toHaveCount(0);
    await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
    await expect(dialog.getByText(/connection string|api key|secret/i)).toHaveCount(0);
  });

  test("graceful pre-API: endpoints 404 → 'setup pending', no crash", async ({ page }) => {
    const world = defaultWorld();
    world.channels = undefined; // GET /api/channels → 404
    world.routing = undefined;
    await mockApi(page, world);
    await page.goto("/notifications");

    await expect(page.getByTestId("setup-pending")).toBeVisible();
    await expect(page.getByRole("button", { name: "+ New channel" })).toHaveCount(0);
  });
});
