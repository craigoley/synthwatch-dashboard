import { test, expect } from "@playwright/test";

import { mockApi } from "./mock";

test.describe("check detail", () => {
  test("multistep: shows the step chain + flags the failed step", async ({ page }) => {
    await mockApi(page);
    await page.goto("/checks/7");

    await expect(page.getByRole("heading", { name: "Step chain" })).toBeVisible();
    await expect(page.getByText("login", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("verify", { exact: false }).first()).toBeVisible();
    // the latest run failed at "verify" — the chain flags it
    await expect(page.getByText("✕ failed here")).toBeVisible();
  });

  test("browser failure: screenshot renders via the proxy + trace link", async ({ page }) => {
    await mockApi(page);
    await page.goto("/checks/2");

    const img = page.locator('img[alt="Failure screenshot for run 200"]');
    await expect(img).toBeVisible();
    // the proxy served a real PNG and apiUrl() resolved the path → it decoded
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBeGreaterThan(0);
    await expect(page.getByRole("link", { name: /Download trace/ })).toBeVisible();
    await expect(page.getByText(/playwright show-trace/)).toBeVisible();
  });

  test("ssl: shows the TLS certificate panel", async ({ page }) => {
    await mockApi(page);
    await page.goto("/checks/3");
    await expect(page.getByRole("heading", { name: "TLS certificate" })).toBeVisible();
  });

  test("dns: shows the network result", async ({ page }) => {
    await mockApi(page);
    await page.goto("/checks/4");
    await expect(page.getByRole("heading", { name: "DNS resolution" })).toBeVisible();
    await expect(page.getByText("A example.com: 93.184.216.34").first()).toBeVisible();
  });

  test("no runs yet: degrades gracefully (no crash)", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await mockApi(page);
    await page.goto("/checks/9");

    await expect(page.getByText(/No runs recorded yet/i)).toBeVisible();
    expect(errors).toEqual([]);
  });
});
