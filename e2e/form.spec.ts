import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

async function openNewMonitor(page: import("@playwright/test").Page) {
  await page.goto("/monitors");
  await page.getByRole("button", { name: "+ New monitor" }).first().click();
  await page.getByRole("heading", { name: "New monitor" }).waitFor();
}

test.describe("monitor form", () => {
  // ★ The field is labelled "Type" to the user but still binds to `kind` underneath.
  // At phone width the 7 type options must stay within the modal (wrap, not clip).
  test("modal: 'Type' label + type options stay within bounds at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockApi(page);
    await openNewMonitor(page);

    // scope to the modal: the monitors table behind it has its own (unrelated) "Kind" column
    const modal = page.getByRole("dialog");
    await expect(modal.getByText("Type", { exact: true })).toBeVisible();
    await expect(modal.getByText("Kind", { exact: true })).toHaveCount(0);

    const within = await page.evaluate(() => {
      const panel = document.querySelector(".sw-panel.sw-rise");
      const seg = document.querySelector(".inline-flex.flex-wrap"); // the Type segmented
      if (!panel || !seg) return null;
      return seg.getBoundingClientRect().right <= panel.getBoundingClientRect().right + 1;
    });
    expect(within).toBe(true);
  });

  test("each kind shows its own fields and hides the others", async ({ page }) => {
    await mockApi(page);
    await openNewMonitor(page);

    // http (default)
    await expect(page.getByText("Target URL")).toBeVisible();
    await expect(page.getByText("Record type")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "+ Add step" })).toHaveCount(0);

    await page.getByRole("button", { name: "Browser", exact: true }).click();
    await expect(page.getByText("Flow", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "SSL", exact: true }).click();
    await expect(page.getByText(/Cert expiry warn/)).toBeVisible();

    await page.getByRole("button", { name: "DNS", exact: true }).click();
    await expect(page.getByText("Record type")).toBeVisible();
    await expect(page.getByText("Target host")).toBeVisible();

    await page.getByRole("button", { name: "TCP", exact: true }).click();
    await expect(page.getByText("Port", { exact: true })).toBeVisible();

    // multistep: chain builder, and target_url is GONE
    await page.getByRole("button", { name: "Multistep", exact: true }).click();
    await expect(page.getByRole("button", { name: "+ Add step" })).toBeVisible();
    await expect(page.getByText("Target URL")).toHaveCount(0);
    await expect(page.getByText("Target host")).toHaveCount(0);
  });

  // ★ Security property: auth is a secret REFERENCE (env-var names only). There
  // must be NO field that accepts a raw credential, anywhere, ever.
  test("no raw-credential field exists in any auth section", async ({ page }) => {
    await mockApi(page);
    await openNewMonitor(page);

    // http advanced auth — all types
    await page.getByRole("button", { name: /Advanced — request headers/ }).click();
    for (const t of ["bearer", "basic", "api_key"]) {
      await page.locator('select[aria-label="auth type"]').selectOption(t);
      expect(await page.locator('input[type="password"]').count()).toBe(0);
    }

    // multistep step auth
    await page.getByRole("button", { name: "Multistep", exact: true }).click();
    await page.getByRole("button", { name: "+ Add step" }).click();
    await page.getByRole("button", { name: /Advanced — request headers/ }).click();
    await page.locator('select[aria-label="auth type"]').selectOption("bearer");
    expect(await page.locator('input[type="password"]').count()).toBe(0);
    // it collects an env-var NAME, not a secret
    await expect(page.locator('input[aria-label="bearer token env var name"]')).toBeVisible();
  });

  test("multistep builder builds the correct API payload (round-trip)", async ({ page }) => {
    await mockApi(page);
    await openNewMonitor(page);
    await page.locator("input").first().fill("Chain test");
    await page.getByRole("button", { name: "Multistep", exact: true }).click();

    // step 1 — POST login, bearer secret-ref, extract token
    await page.getByRole("button", { name: "+ Add step" }).click();
    await page.locator('input[aria-label="step name"]').fill("login");
    await page.locator('select[aria-label="step method"]').selectOption("POST");
    await page.locator('input[aria-label="step url"]').fill("https://api.example.com/login");
    await page.getByRole("button", { name: /Advanced — request headers/ }).click();
    await page.locator('select[aria-label="auth type"]').selectOption("bearer");
    await page.locator('input[aria-label="bearer token env var name"]').fill("API_TOKEN_ENV");
    await page.getByRole("button", { name: "+ Add extract rule" }).click();
    await page.locator('input[aria-label="extract variable name"]').fill("token");
    await page.locator('input[aria-label="extract json path"]').fill("$.access_token");

    // step 2 — GET with {{token}} injected
    await page.getByRole("button", { name: "+ Add step" }).click();
    await page.locator('input[aria-label="step name"]').fill("verify");
    await page.locator('input[aria-label="step url"]').fill("https://api.example.com/me?t={{token}}");
    await page.getByRole("button", { name: /Advanced — request headers/ }).click();
    await page.getByRole("button", { name: "+ Add header" }).click();
    await page.locator('input[aria-label="header name"]').fill("Authorization");
    await page.locator('input[aria-label="header value"]').fill("Bearer {{token}}");

    const reqPromise = page.waitForRequest((r) => r.url().endsWith("/api/checks") && r.method() === "POST");
    await page.getByRole("button", { name: /Create monitor/ }).click();
    const body = (await reqPromise).postDataJSON();

    expect(body.kind).toBe("multistep");
    expect(body.steps).toHaveLength(2);
    expect(body.steps[0].auth).toEqual({ type: "bearer", token_env: "API_TOKEN_ENV" });
    expect(body.steps[0].extract).toEqual([{ var: "token", jsonPath: "$.access_token" }]);
    expect(body.steps[1].url).toContain("{{token}}");
    expect(body.steps[1].headers.Authorization).toBe("Bearer {{token}}");
  });

  // ★ Per-step error routing: the API returns nested keys like steps[1].template;
  // the dangling-{{var}} error must surface on the referencing step (not a generic
  // banner only). The detail text only comes from the per-step routing.
  test("a per-step API 400 routes to the referencing step", async ({ page }) => {
    const world = defaultWorld();
    world.createResponse = {
      status: 400,
      body: {
        error: "validation_error",
        details: { "steps[1].template": "References {{nope}} which no earlier step extracts." },
      },
    };
    await mockApi(page, world);
    await openNewMonitor(page);
    await page.locator("input").first().fill("Bad chain");
    await page.getByRole("button", { name: "Multistep", exact: true }).click();

    await page.getByRole("button", { name: "+ Add step" }).click();
    await page.locator('input[aria-label="step name"]').fill("login");
    await page.locator('input[aria-label="step url"]').fill("https://api.example.com/login");

    await page.getByRole("button", { name: "+ Add step" }).click();
    await page.locator('input[aria-label="step name"]').fill("verify");
    await page.locator('input[aria-label="step url"]').fill("https://api.example.com/me?t={{nope}}");

    await page.getByRole("button", { name: /Create monitor/ }).click();

    // step 2 is the open/referencing step; the routed error renders in its body
    await expect(page.getByText(/References .*nope.* no earlier step extracts/)).toBeVisible();
  });

  // ★ #40a — an extract row with a var but EMPTY jsonPath must NOT be sent
  // (it would go as {var, jsonPath:""} and the API 400s on it). buildStepsPayload
  // filters on BOTH fields, so only the complete row survives in the payload.
  test("an extract row with a var but no jsonPath is dropped from the payload", async ({ page }) => {
    await mockApi(page);
    await openNewMonitor(page);
    await page.locator("input").first().fill("Extract filter");
    await page.getByRole("button", { name: "Multistep", exact: true }).click();

    await page.getByRole("button", { name: "+ Add step" }).click();
    await page.locator('input[aria-label="step name"]').fill("login");
    await page.locator('input[aria-label="step url"]').fill("https://api.example.com/login");

    // row 1 — complete (var + jsonPath)
    await page.getByRole("button", { name: "+ Add extract rule" }).click();
    await page.locator('input[aria-label="extract variable name"]').first().fill("token");
    await page.locator('input[aria-label="extract json path"]').first().fill("$.access_token");
    // row 2 — var set but jsonPath left BLANK → must be filtered out
    await page.getByRole("button", { name: "+ Add extract rule" }).click();
    await page.locator('input[aria-label="extract variable name"]').nth(1).fill("orphan");

    const reqPromise = page.waitForRequest((r) => r.url().endsWith("/api/checks") && r.method() === "POST");
    await page.getByRole("button", { name: /Create monitor/ }).click();
    const body = (await reqPromise).postDataJSON();

    // only the complete row survives — no {var:"orphan", jsonPath:""}
    expect(body.steps[0].extract).toEqual([{ var: "token", jsonPath: "$.access_token" }]);
  });

  // ★ #40b — a step-level error (e.g. the dangling-{{var}} template error) must stay
  // visible when the step card is COLLAPSED; the red border alone doesn't say what's wrong.
  test("a step-level error stays visible when the step card is collapsed", async ({ page }) => {
    const world = defaultWorld();
    world.createResponse = {
      status: 400,
      body: {
        error: "validation_error",
        details: { "steps[0].template": "References {{nope}} which no earlier step extracts." },
      },
    };
    await mockApi(page, world);
    await openNewMonitor(page);
    await page.locator("input").first().fill("Collapsed error");
    await page.getByRole("button", { name: "Multistep", exact: true }).click();

    await page.getByRole("button", { name: "+ Add step" }).click();
    await page.locator('input[aria-label="step name"]').fill("login");
    await page.locator('input[aria-label="step url"]').fill("https://api.example.com/x?t={{nope}}");
    await page.getByRole("button", { name: /Create monitor/ }).click();

    const err = page.getByText(/References .*nope.* no earlier step extracts/);
    await expect(err).toBeVisible(); // visible while the step is expanded

    // collapse the step card via its header toggle
    await page.getByRole("button", { name: /login/ }).click();
    await expect(page.locator('input[aria-label="step url"]')).toHaveCount(0); // confirm collapsed
    await expect(err).toBeVisible(); // ★ error still visible when collapsed
  });
});
