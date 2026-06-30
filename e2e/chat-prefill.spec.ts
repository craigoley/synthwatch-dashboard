import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

// ★ #150: the chat-to-prefill surface is the SAME shared trio (useCreateMonitor + CreateMonitorModal +
// MonitorChatInput) on BOTH the Monitors page and the Status/fleet home — so it must behave IDENTICALLY. These
// run the same assertions against both routes; if they ever diverge, it's no longer one shared component.
const ENTRYPOINTS = [
  { name: "monitors page", path: "/monitors" },
  { name: "status / fleet home", path: "/" },
];

for (const ep of ENTRYPOINTS) {
  test.describe(`chat-to-prefill — ${ep.name}`, () => {
    test("“ping meals2go.com” → seeds kind=ping (reachability) + target, editable, human Creates", async ({ page }) => {
      await mockApi(page, defaultWorld());
      await page.goto(ep.path);

      await page.getByLabel("Describe a monitor to prefill").fill("ping meals2go.com");
      await page.getByRole("button", { name: "Prefill" }).click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId("prefill-banner")).toBeVisible(); // "review before creating" banner
      await expect(dialog.locator("input").first()).toHaveValue("ping meals2go.com"); // name seeded
      // ping → "Target host" label (kind seeded to ping), seeded with the parsed host.
      await expect(dialog.getByLabel("Target host")).toHaveValue("meals2go.com");
      // ★ PREFILL-not-CREATE: nothing was created; the human still clicks Create.
      await expect(dialog.getByRole("button", { name: "Create monitor" })).toBeVisible();
    });

    test("a browser ask → “authored as code” redirect, no prefill modal", async ({ page }) => {
      await mockApi(page, defaultWorld());
      await page.goto(ep.path);

      await page.getByLabel("Describe a monitor to prefill").fill("monitor the checkout flow in a browser");
      await page.getByRole("button", { name: "Prefill" }).click();

      await expect(page.getByText(/authored as code/i)).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0); // redirect, never a fabricated browser check
    });

    test("a parsed-but-invalid suggestion → modal opens with the inline field error (validate-don't-trust)", async ({ page }) => {
      await mockApi(page, defaultWorld());
      await page.goto(ep.path);

      await page.getByLabel("Describe a monitor to prefill").fill("invalid nonsense monitor");
      await page.getByRole("button", { name: "Prefill" }).click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("requires a port"); // the validator's field error renders inline, not a 500
    });
  });
}

test.describe("chat-to-prefill — editor gate", () => {
  test("a non-editor viewer does NOT see the describe input on either page", async ({ page }) => {
    await mockApi(page, defaultWorld(), { seedSession: false });

    await page.goto("/");
    await expect(page.getByLabel("Describe a monitor to prefill")).toHaveCount(0);

    await page.goto("/monitors");
    await expect(page.getByLabel("Describe a monitor to prefill")).toHaveCount(0);
  });
});
