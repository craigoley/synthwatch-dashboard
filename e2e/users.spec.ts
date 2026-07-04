import { test, expect, type Page } from "@playwright/test";

import { mockApi, defaultWorld, type World } from "./mock";

// /users end-to-end — the first surface a new team exercises at handoff, previously ZERO-covered.
// Admin CRUD (list/add/remove editors, grant/dismiss access requests) + the non-admin lockout
// (client UX only — the API's admin gate is the boundary; the mock enforces it on every verb).

async function signIn(page: Page, email: string) {
  await page.getByTestId("sign-in").click();
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-send").click();
  await page.getByTestId("login-code").fill("123456");
  await page.getByTestId("login-verify").click();
  await expect(page.getByTestId("account")).toBeVisible();
}

function world(over: Partial<World>): World {
  return { ...defaultWorld(), revokedEmails: new Set(), ...over };
}

test.describe("users — non-admin lockout", () => {
  test("anonymous: lockout shell with a sign-in affordance, no data fetched", async ({ page }) => {
    const editorReads: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/editors") || r.url().includes("/api/access-requests")) editorReads.push(r.url());
    });
    await mockApi(page, world({ editors: [{ email: "ed@test" }] }), { seedSession: false });
    await page.goto("/users");

    await expect(page.getByText("Sign in as an admin to manage users.")).toBeVisible();
    await expect(page.getByTestId("editor-list")).toHaveCount(0);
    // the queries are enabled-gated on isAdmin — a non-admin page visit must not even ASK the API
    expect(editorReads).toEqual([]);
  });

  test("signed-in editor (not admin): honest 'Admins only.' — no editor data, no crash", async ({ page }) => {
    await mockApi(page, world({ accounts: { "ed@test": "editor" }, editors: [{ email: "ed@test" }] }), {
      seedSession: false,
    });
    await page.goto("/users");
    await signIn(page, "ed@test");

    await expect(page.getByText("Admins only.")).toBeVisible();
    await expect(page.getByText("doesn't have the admin role")).toBeVisible();
    await expect(page.getByTestId("editor-list")).toHaveCount(0);
  });
});

test.describe("users — admin management", () => {
  const adminWorld = () =>
    world({
      accounts: { "boss@test": "admin", "ed@test": "editor" },
      editors: [{ email: "ed@test", addedBy: "boss@test", addedAt: "2026-06-20T00:00:00Z" }],
      accessRequests: [{ email: "newbie@test", requestedAt: "2026-07-01T00:00:00Z" }],
    });

  test("★ lists editors; add + remove round-trip through the API", async ({ page }) => {
    await mockApi(page, adminWorld(), { seedSession: false });
    await page.goto("/users");
    await signIn(page, "boss@test");

    // list renders the seeded editor
    await expect(page.getByTestId("editor-ed@test")).toBeVisible();

    // add a teammate → row appears (stateful mock: POST then re-GET)
    await page.getByTestId("add-editor-email").fill("teammate@test");
    await page.getByTestId("add-editor-submit").click();
    await expect(page.getByTestId("editor-teammate@test")).toBeVisible();

    // remove → row disappears
    await page.getByTestId("remove-teammate@test").click();
    await expect(page.getByTestId("editor-teammate@test")).toHaveCount(0);
    await expect(page.getByTestId("editor-ed@test")).toBeVisible(); // others untouched
  });

  test("★ pending access request: grant adds the editor and clears the request; dismiss clears it", async ({ page }) => {
    await mockApi(page, adminWorld(), { seedSession: false });
    await page.goto("/users");
    await signIn(page, "boss@test");

    await expect(page.getByTestId("request-newbie@test")).toBeVisible();
    await page.getByTestId("grant-newbie@test").click();
    // granted → becomes an editor and leaves the pending list
    await expect(page.getByTestId("editor-newbie@test")).toBeVisible();
    await expect(page.getByTestId("request-newbie@test")).toHaveCount(0);
  });

  test("dismissing a request removes it without adding an editor", async ({ page }) => {
    await mockApi(page, adminWorld(), { seedSession: false });
    await page.goto("/users");
    await signIn(page, "boss@test");

    await page.getByTestId("dismiss-newbie@test").click();
    await expect(page.getByTestId("request-newbie@test")).toHaveCount(0);
    await expect(page.getByTestId("editor-newbie@test")).toHaveCount(0);
  });
});
