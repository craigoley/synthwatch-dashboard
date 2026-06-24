import { test, expect, type Page } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

const ch = (id: number, name: string) => ({
  id,
  name,
  type: "email",
  config: { to: ["a@b.com"] },
  enabled: true,
});

// Tag the FIRST check (id 1, "API health") — the fan-out preview defaults to it.
function tagCheck1(w: ReturnType<typeof defaultWorld>, tags: { key: string; value: string }[]) {
  w.checks = w.checks.map((c) => (c.id === 1 ? { ...c, tags } : { ...c, tags: [] }));
}

test.describe("tag-routing — editor", () => {
  test("add a tag-rule and save PUTs the FULL {severity, perCheck, tagRules}", async ({ page }) => {
    const w = defaultWorld();
    w.channels = [ch(1, "Email")];
    tagCheck1(w, [{ key: "team", value: "web" }]);
    w.routing = { severity: { critical: { channelIds: [1] }, warning: { channelIds: [] } }, perCheck: {} };
    w.tags = [{ key: "team", value: "web", count: 1 }];
    await mockApi(page, w);
    await page.goto("/notifications");

    await page.getByLabel("tag rule key").fill("team");
    await page.getByLabel("tag rule value").fill("web");
    await page.getByRole("button", { name: "+ Add tag rule" }).click();
    await page.getByRole("checkbox", { name: "tag-rule team:web to Email" }).click();

    const put = page.waitForRequest((r) => r.url().endsWith("/api/routing") && r.method() === "PUT");
    await page.getByRole("button", { name: "Save routing" }).click();
    const body = (await put).postDataJSON();
    expect(body.tagRules).toEqual([{ tagKey: "team", tagValue: "web", channelId: 1 }]);
    // full object — severity preserved, not wiped
    expect(body.severity.critical.channelIds).toEqual([1]);
    expect(body).toHaveProperty("perCheck");
    await expect(page.getByTestId("toast-success")).toBeVisible();
  });

  test("remove a tag-rule group", async ({ page }) => {
    const w = defaultWorld();
    w.channels = [ch(1, "Email")];
    tagCheck1(w, [{ key: "team", value: "web" }]);
    w.routing = {
      severity: { critical: { channelIds: [1] }, warning: { channelIds: [] } },
      perCheck: {},
      tagRules: [{ tagKey: "team", tagValue: "web", channelId: 1 }],
    };
    await mockApi(page, w);
    await page.goto("/notifications");

    await expect(page.getByTestId("tag-rule-team-web")).toBeVisible();
    await page.getByTestId("tag-rule-team-web").getByRole("button", { name: "Remove" }).click();
    await expect(page.getByTestId("tag-rule-team-web")).toHaveCount(0);
  });
});

test.describe("tag-routing — fan-out preview (the guardrail)", () => {
  test("shows the deduped UNION (severity ∪ per-check ∪ matching tag-rule)", async ({ page }) => {
    const w = defaultWorld();
    w.channels = [ch(1, "Email"), ch(2, "SMS"), ch(3, "Slack")];
    tagCheck1(w, [{ key: "team", value: "web" }]);
    w.routing = {
      severity: { critical: { channelIds: [1] }, warning: { channelIds: [] } },
      perCheck: { "1": { channelIds: [2] } },
      tagRules: [{ tagKey: "team", tagValue: "web", channelId: 3 }],
    };
    await mockApi(page, w);
    await page.goto("/notifications");

    const preview = page.getByTestId("fanout-preview");
    await expect(preview).toBeVisible();
    // critical (default) on check 1 → severity(1) ∪ per-check(2) ∪ tag team:web(3) = 3 channels
    await expect(preview.getByTestId("fanout-list")).toContainText("Fires 3 channels");
    await expect(preview.getByTestId("fanout-channel-1")).toContainText("severity");
    await expect(preview.getByTestId("fanout-channel-2")).toContainText("per-check");
    await expect(preview.getByTestId("fanout-channel-3")).toContainText("team:web");
  });

  test("a channel matched by BOTH severity and a tag appears ONCE (dedupe)", async ({ page }) => {
    const w = defaultWorld();
    w.channels = [ch(1, "Email")];
    tagCheck1(w, [{ key: "team", value: "web" }]);
    w.routing = {
      severity: { critical: { channelIds: [1] }, warning: { channelIds: [] } },
      perCheck: {},
      tagRules: [{ tagKey: "team", tagValue: "web", channelId: 1 }], // SAME channel as severity
    };
    await mockApi(page, w);
    await page.goto("/notifications");

    const preview = page.getByTestId("fanout-preview");
    await expect(preview.getByTestId("fanout-channel-1")).toHaveCount(1); // once, not twice
    await expect(preview.getByTestId("fanout-channel-1")).toContainText("severity");
    await expect(preview.getByTestId("fanout-channel-1")).toContainText("team:web");
    await expect(preview.getByTestId("fanout-list")).toContainText("Fires 1 channel");
  });

  test("★ flags a tag escalating a WARNING onto a critical-only channel", async ({ page }) => {
    const w = defaultWorld();
    w.channels = [ch(1, "Urgent SMS")];
    tagCheck1(w, [{ key: "team", value: "web" }]);
    w.routing = {
      // channel 1 is CRITICAL-only by severity; a tag-rule pulls it onto team:web checks
      severity: { critical: { channelIds: [1] }, warning: { channelIds: [] } },
      perCheck: {},
      tagRules: [{ tagKey: "team", tagValue: "web", channelId: 1 }],
    };
    await mockApi(page, w);
    await page.goto("/notifications");

    const preview = page.getByTestId("fanout-preview");
    await preview.getByRole("button", { name: "Warning" }).click(); // preview a WARNING incident
    await expect(preview.getByTestId("fanout-channel-1")).toBeVisible();
    await expect(preview.getByTestId("fanout-escalation-1")).toBeVisible(); // ⚠ escalated by tag
  });

  test("shows 'alerts no one' when nothing routes", async ({ page }) => {
    const w = defaultWorld();
    w.channels = [ch(1, "Email")];
    tagCheck1(w, []); // no tags
    w.routing = { severity: { critical: { channelIds: [] }, warning: { channelIds: [] } }, perCheck: {}, tagRules: [] };
    await mockApi(page, w);
    await page.goto("/notifications");
    await expect(page.getByTestId("fanout-empty")).toContainText(/no one/i);
  });
});

async function gotoNoApi(page: Page) {
  const w = defaultWorld();
  w.channels = undefined; // /channels 404 → setup pending
  await mockApi(page, w);
  await page.goto("/notifications");
}

test("graceful pre-API: no editor/preview, setup-pending shown", async ({ page }) => {
  await gotoNoApi(page);
  await expect(page.getByTestId("setup-pending")).toBeVisible();
  await expect(page.getByTestId("fanout-preview")).toHaveCount(0);
  await expect(page.getByLabel("tag rule key")).toHaveCount(0);
});
