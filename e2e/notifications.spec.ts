import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

const emailCh = (over = {}) => ({
  id: 1,
  name: "On-call",
  type: "email",
  config: { to: ["a@b.com"] },
  enabled: true,
  ...over,
});

// Dashboard-managed alerting — channels + routing. Routing uses the API's real
// vocabulary: { severity:{critical|warning}, perCheck } (NOT defaults/overrides
// or fail/error/warn/resolved — those silently 400'd). The mock implements the
// contract statefully, so CRUD, routing saves, and save FAILURES are verified.
test.describe("notifications settings", () => {
  test("create an email channel (recipients only) → appears in the list", async ({ page }) => {
    await mockApi(page);
    await page.goto("/notifications");
    await page.getByRole("button", { name: "+ New channel" }).first().click();
    await page.getByRole("heading", { name: "New channel" }).waitFor();
    await page.getByLabel("Name", { exact: true }).fill("On-call email");
    await page.getByLabel("recipients").fill("oncall@example.com, sre@example.com");
    await page.getByRole("button", { name: "Create channel" }).click();

    await expect(page.getByTestId("channel-list").getByText("On-call email")).toBeVisible();
    await expect(page.getByText("oncall@example.com, sre@example.com")).toBeVisible();
    await expect(page.getByTestId("toast-success")).toBeVisible(); // ★ create feedback
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

  test("edit then delete a channel (with success feedback)", async ({ page }) => {
    const world = defaultWorld();
    world.channels = [emailCh({ name: "Old name" })];
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
    await expect(page.getByTestId("toast-success").filter({ hasText: "Channel deleted" })).toBeVisible();
  });

  test("severity routing matrix (critical → channel) saves with success feedback", async ({ page }) => {
    const world = defaultWorld();
    world.channels = [emailCh()];
    await mockApi(page, world);
    await page.goto("/notifications");

    await expect(page.getByTestId("routing-matrix")).toBeVisible();
    const cell = page.getByRole("checkbox", { name: "route critical to On-call" });
    await cell.click();
    await expect(cell).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("unsaved-hint")).toBeVisible(); // dirty state obvious

    const put = page.waitForRequest((r) => r.url().endsWith("/api/routing") && r.method() === "PUT");
    await page.getByRole("button", { name: "Save routing" }).click();
    const body = (await put).postDataJSON();
    expect(body.severity.critical.channelIds).toEqual([1]); // ★ correct field names + vocab
    await expect(page.getByTestId("toast-success")).toContainText(/saved/i);
  });

  test("★ a FAILED routing save SHOWS an error with the reason (no silent failure)", async ({ page }) => {
    const world = defaultWorld();
    world.channels = [emailCh()];
    world.routingPutError = { status: 500, body: { message: "database is locked" } };
    await mockApi(page, world);
    await page.goto("/notifications");

    await page.getByRole("checkbox", { name: "route warning to On-call" }).click();
    await page.getByRole("button", { name: "Save routing" }).click();

    const toast = page.getByTestId("toast-error");
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("Couldn't save routing");
    await expect(toast).toContainText("database is locked"); // the API reason, surfaced
  });

  test("per-check override routes a check to a channel", async ({ page }) => {
    const world = defaultWorld();
    world.channels = [emailCh()];
    await mockApi(page, world);
    await page.goto("/notifications");

    await page.getByLabel("add per-check override").selectOption({ label: "API health" }); // check 1
    await page.getByRole("checkbox", { name: "override 1 to On-call" }).click();

    const put = page.waitForRequest((r) => r.url().endsWith("/api/routing") && r.method() === "PUT");
    await page.getByRole("button", { name: "Save routing" }).click();
    const body = (await put).postDataJSON();
    expect(body.perCheck["1"].channelIds).toEqual([1]);
  });

  // Async test-send (runs on the runner): POST → 202 { requestId }, then poll
  // GET .../test/status until delivered|failed. The button shows a pending state
  // while polling; the inline result + toast reflect the terminal outcome.
  test("send-test: pending → delivered (polls, then success result + toast)", async ({ page }) => {
    const world = defaultWorld();
    world.channels = [emailCh()];
    // first poll still sending, second poll delivered — exercises the transition.
    world.channelTest = {
      statusSequence: [
        { status: "sending" },
        { status: "delivered", detail: "sent via email" },
      ],
    };
    await mockApi(page, world);
    await page.goto("/notifications");

    await page.getByTestId("send-test-1").click();
    // PENDING UI: button shows the in-flight label and is disabled.
    const btn = page.getByTestId("send-test-1");
    await expect(btn).toContainText(/Sending test/);
    await expect(btn).toBeDisabled();
    // Eventually resolves to the delivered result + a success toast.
    await expect(page.getByTestId("test-result-1")).toContainText(/Test delivered/);
    await expect(page.getByTestId("test-result-1")).toContainText(/sent via email/);
    await expect(page.getByTestId("toast-success")).toBeVisible();
    await expect(btn).toBeEnabled(); // re-enabled after the terminal state
  });

  test("send-test: pending → failed (error result + toast with the reason)", async ({ page }) => {
    const world = defaultWorld();
    world.channels = [emailCh()];
    world.channelTest = {
      statusSequence: [
        { status: "pending" },
        { status: "failed", detail: "smtp 550 rejected" },
      ],
    };
    await mockApi(page, world);
    await page.goto("/notifications");

    await page.getByTestId("send-test-1").click();
    await expect(page.getByTestId("test-result-1")).toContainText(/Test failed/);
    await expect(page.getByTestId("test-result-1")).toContainText(/smtp 550 rejected/);
    await expect(page.getByTestId("toast-error")).toBeVisible();
  });

  test("send-test: network error on enqueue → failure surfaced (nothing hangs)", async ({ page }) => {
    const world = defaultWorld();
    world.channels = [emailCh()];
    world.channelTest = { enqueueError: { status: 500, body: { message: "runner unavailable" } } };
    await mockApi(page, world);
    await page.goto("/notifications");

    await page.getByTestId("send-test-1").click();
    await expect(page.getByTestId("test-result-1")).toContainText(/Test failed/);
    await expect(page.getByTestId("toast-error")).toContainText(/runner unavailable/);
    await expect(page.getByTestId("send-test-1")).toBeEnabled(); // button recovers
  });

  test("send-test: graceful when the endpoint isn't deployed (404)", async ({ page }) => {
    const world = defaultWorld();
    world.channels = [emailCh()]; // channelTest undefined → POST 404
    await mockApi(page, world);
    await page.goto("/notifications");

    await page.getByTestId("send-test-1").click();
    await expect(page.getByTestId("test-result-1")).toContainText(/isn.t available yet/);
    await expect(page.getByTestId("toast-error")).toBeVisible();
  });

  test("channel list shows deliverability + routed/orphaned badges", async ({ page }) => {
    const world = defaultWorld();
    world.channels = [
      { id: 1, name: "Routed", type: "email", config: { to: ["a@b.com"] }, enabled: true },
      { id: 2, name: "Orphan", type: "webhook", config: { url: "https://h" }, enabled: true },
      { id: 3, name: "Broken", type: "webhook", config: { url: null }, enabled: true },
    ];
    world.routing = { severity: { critical: { channelIds: [1] } }, perCheck: {} };
    await mockApi(page, world);
    await page.goto("/notifications");

    await expect(page.getByTestId("badge-routed-1")).toBeVisible();
    await expect(page.getByTestId("badge-orphaned-2")).toContainText(/not routed/i);
    await expect(page.getByTestId("badge-undeliverable-3")).toContainText(/won.t deliver/i);
    // a broken channel can't be test-sent
    await expect(page.getByTestId("send-test-3")).toBeDisabled();
  });

  test("delete is blocked (409) with a styled, actionable reason", async ({ page }) => {
    const world = defaultWorld();
    world.channels = [emailCh()];
    world.routing = { severity: { critical: { channelIds: [1] } }, perCheck: {} };
    await mockApi(page, world);
    await page.goto("/notifications");

    await page.getByRole("button", { name: "Delete" }).first().click();
    await page.getByRole("button", { name: "Delete channel" }).click();
    const err = page.getByTestId("delete-error");
    await expect(err).toBeVisible();
    await expect(err).toContainText(/remove it from routing/);
    await expect(page.getByTestId("channel-list").getByText("On-call")).toBeVisible(); // not deleted
  });

  test("delivery banner: neutral when readiness endpoint is absent (no false warning)", async ({ page }) => {
    const world = defaultWorld();
    world.channels = [emailCh()]; // notificationsHealth undefined → 404 → neutral
    await mockApi(page, world);
    await page.goto("/notifications");
    await expect(page.getByTestId("delivery-unknown")).toBeVisible();
    await expect(page.getByTestId("delivery-not-configured")).toHaveCount(0); // no false "won't deliver"
  });

  test("delivery banner: ACTIVE when channels + routing + transport are all configured", async ({ page }) => {
    const world = defaultWorld();
    world.channels = [emailCh()];
    world.notificationsHealth = { channelsConfigured: true, routingConfigured: true, transportConfigured: true };
    await mockApi(page, world);
    await page.goto("/notifications");
    await expect(page.getByTestId("delivery-active")).toBeVisible();
  });

  test("delivery banner: INCOMPLETE when config is missing (API can see this)", async ({ page }) => {
    const world = defaultWorld();
    world.channels = [emailCh()];
    world.notificationsHealth = { channelsConfigured: true, routingConfigured: false, transportConfigured: null };
    await mockApi(page, world);
    await page.goto("/notifications");
    await expect(page.getByTestId("delivery-incomplete")).toContainText(/won.t fire/i);
    await expect(page.getByTestId("delivery-active")).toHaveCount(0);
  });

  test("delivery banner: UNKNOWN transport → honest note, no false active/down", async ({ page }) => {
    const world = defaultWorld();
    world.channels = [emailCh()];
    // config complete, transport unverifiable (null) — the API can't see the runner's transport
    world.notificationsHealth = { channelsConfigured: true, routingConfigured: true, transportConfigured: null };
    await mockApi(page, world);
    await page.goto("/notifications");
    await expect(page.getByTestId("delivery-transport-unknown")).toBeVisible();
    await expect(page.getByTestId("delivery-active")).toHaveCount(0); // not falsely "active"
    await expect(page.getByTestId("delivery-not-configured")).toHaveCount(0); // not falsely "won't deliver"
  });

  test("validation: an email channel with no recipient is blocked", async ({ page }) => {
    await mockApi(page);
    await page.goto("/notifications");
    await page.getByRole("button", { name: "+ New channel" }).first().click();
    await page.getByLabel("Name", { exact: true }).fill("Bad email");
    await page.getByRole("button", { name: "Create channel" }).click();

    await expect(page.getByText("Add at least one recipient email address.")).toBeVisible();
    await expect(page.getByText("Bad email")).toHaveCount(0);
  });

  test("★ no sender/credential field — only the ACS transport note", async ({ page }) => {
    await mockApi(page);
    await page.goto("/notifications");
    await page.getByRole("button", { name: "+ New channel" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/configured ACS sender/)).toBeVisible();
    await expect(dialog.getByLabel("from address")).toHaveCount(0);
    await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
    await expect(dialog.getByText(/connection string|api key|secret/i)).toHaveCount(0);
  });

  test("graceful pre-API: endpoints 404 → 'setup pending', no crash", async ({ page }) => {
    const world = defaultWorld();
    world.channels = undefined;
    world.routing = undefined;
    await mockApi(page, world);
    await page.goto("/notifications");
    await expect(page.getByTestId("setup-pending")).toBeVisible();
    await expect(page.getByRole("button", { name: "+ New channel" })).toHaveCount(0);
  });
});
