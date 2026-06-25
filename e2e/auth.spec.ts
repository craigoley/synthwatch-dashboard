import { test, expect, type Page } from "@playwright/test";

import { mockApi, defaultWorld, type World } from "./mock";

// Phase 12 slice 3 — dashboard auth UX end-to-end against the mocked gate (slice 2's shapes):
// read-only-by-default, OTP login + token injection, role adaptation, the 401/403 interceptor, and
// admin user management. The mock simulates the gate so token injection + interception are real.

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

test.describe("auth — read-only by default", () => {
  test("signed out: reads work, write affordances hidden, sign-in prompt shown", async ({ page }) => {
    await mockApi(page, defaultWorld(), { seedSession: false }); // no accounts → no one can sign in; viewer is read-only
    await page.goto("/monitors");

    await expect(page.getByRole("heading", { name: "Monitors" })).toBeVisible(); // reads render
    await expect(page.getByTestId("sign-in")).toBeVisible();
    await expect(page.getByTestId("sign-in-to-edit")).toBeVisible();
    await expect(page.getByRole("button", { name: "+ New monitor" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0);
  });
});

test.describe("auth — OTP login + role adaptation", () => {
  test("login modal shows the enumeration-safe message + spam caveat", async ({ page }) => {
    await mockApi(page, world({ accounts: { "ed@test": "editor" } }), { seedSession: false });
    await page.goto("/monitors");
    await page.getByTestId("sign-in").click();
    await page.getByTestId("login-email").fill("ed@test");
    await page.getByTestId("login-send").click();
    await expect(page.getByTestId("login-notice")).toContainText("If your email is registered");
    await expect(page.getByTestId("login-notice")).toContainText("spam folder");
  });

  test("editor: write affordances appear, no admin Users nav; sign out returns to read-only", async ({ page }) => {
    await mockApi(page, world({ accounts: { "ed@test": "editor" } }), { seedSession: false });
    await page.goto("/monitors");
    await signIn(page, "ed@test");

    await expect(page.getByTestId("account-role")).toHaveText("editor");
    await expect(page.getByRole("button", { name: "+ New monitor" })).toBeVisible();
    await expect(page.getByTestId("sign-in-to-edit")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0); // admin-only nav hidden

    await page.getByTestId("sign-out").click();
    await expect(page.getByTestId("sign-in")).toBeVisible();
    await expect(page.getByRole("button", { name: "+ New monitor" })).toHaveCount(0);
  });

  test("admin: Users nav appears", async ({ page }) => {
    await mockApi(page, world({ accounts: { "boss@test": "admin" } }), { seedSession: false });
    await page.goto("/monitors");
    await signIn(page, "boss@test");
    await expect(page.getByTestId("account-role")).toHaveText("admin");
    await expect(page.getByRole("link", { name: "Users" })).toBeVisible();
  });
});

test.describe("auth — admin user management", () => {
  test("admin lists, adds, removes editors and grants access requests", async ({ page }) => {
    await mockApi(
      page,
      world({
        accounts: { "boss@test": "admin" },
        editors: [{ email: "ed@test", addedBy: "boss@test", addedAt: "2026-06-01T00:00:00Z" }],
        accessRequests: [{ email: "want@test", requestedAt: "2026-06-20T00:00:00Z", count: 2 }],
      }),
      { seedSession: false },
    );
    await page.goto("/monitors");
    await signIn(page, "boss@test");
    await page.getByRole("link", { name: "Users" }).click();

    await expect(page.getByTestId("editor-ed@test")).toBeVisible();

    // add by email
    await page.getByTestId("add-editor-email").fill("new@test");
    await page.getByTestId("add-editor-submit").click();
    await expect(page.getByTestId("editor-new@test")).toBeVisible();

    // grant a pending request → becomes an editor + drops off the pending list
    await expect(page.getByTestId("request-want@test")).toBeVisible();
    await page.getByTestId("grant-want@test").click();
    await expect(page.getByTestId("editor-want@test")).toBeVisible();
    await expect(page.getByTestId("request-want@test")).toHaveCount(0);

    // remove
    await page.getByTestId("remove-ed@test").click();
    await expect(page.getByTestId("editor-ed@test")).toHaveCount(0);
  });
});

test.describe("auth — gate end-to-end (enforcement ON)", () => {
  test("editor write succeeds with the bearer token injected", async ({ page }) => {
    await mockApi(page, world({ accounts: { "ed@test": "editor" }, enforceAuth: true }), { seedSession: false });
    await page.goto("/monitors");
    await signIn(page, "ed@test");

    await page.getByRole("button", { name: "+ New monitor" }).click();
    await page.getByPlaceholder("Checkout flow — production").fill("Auth check");
    await page.getByPlaceholder("https://example.com/health").fill("https://x.test/health");

    const reqP = page.waitForRequest((r) => r.url().endsWith("/api/checks") && r.method() === "POST");
    await page.getByRole("button", { name: "Create monitor" }).click();
    const sent = await reqP;
    expect(sent.headers()["authorization"]).toBe("Bearer swt_ed@test"); // token attached on the write
    await expect(page.getByTestId("login-modal")).toHaveCount(0); // no 401 → no re-login
  });

  test("a 401 mid-action (revoked session) clears the session + prompts re-login", async ({ page }) => {
    const w = world({ accounts: { "ed@test": "editor" }, enforceAuth: true });
    await mockApi(page, w, { seedSession: false });
    await page.goto("/monitors");
    await signIn(page, "ed@test");

    w.revokedEmails!.add("ed@test"); // server-side revoke (mutate the shared world)

    await page.getByRole("button", { name: "+ New monitor" }).click();
    await page.getByPlaceholder("Checkout flow — production").fill("Will 401");
    await page.getByPlaceholder("https://example.com/health").fill("https://x.test/health");
    await page.getByRole("button", { name: "Create monitor" }).click();

    await expect(page.getByTestId("login-modal")).toBeVisible(); // 401 → re-login prompt
    await expect(page.getByTestId("sign-in")).toBeVisible(); // session cleared
  });

  test("a 403 (wrong role) shows a permission toast, not a re-login", async ({ page }) => {
    const w = world({
      accounts: { "boss@test": "admin" },
      editors: [{ email: "ed@test", addedBy: "boss@test", addedAt: "2026-06-01T00:00:00Z" }],
    });
    await mockApi(page, w, { seedSession: false });
    await page.goto("/monitors");
    await signIn(page, "boss@test");
    await page.getByRole("link", { name: "Users" }).click();
    await expect(page.getByTestId("editor-ed@test")).toBeVisible();

    w.accounts!["boss@test"] = "editor"; // demoted mid-session → admin action now 403s

    await page.getByTestId("remove-ed@test").click();
    await expect(page.getByTestId("forbidden-toast")).toBeVisible();
    await expect(page.getByTestId("login-modal")).toHaveCount(0); // 403 is NOT a re-login
  });
});

// The user-facing request-access trigger (the reported gap): a denied/unregistered user has a path to
// REQUEST access from the login flow — including from the dead-end code step (waiting for a code that never
// comes). Enumeration-safe: the confirmation is identical regardless of the email.
test.describe("auth — request access (login flow)", () => {
  async function openLogin(page: Page, over: Partial<World> = {}) {
    await mockApi(page, world(over), { seedSession: false });
    await page.goto("/monitors");
    await page.getByTestId("sign-in").click();
    await expect(page.getByTestId("login-modal")).toBeVisible();
  }

  test("request access from the email step → uniform confirmation", async ({ page }) => {
    await openLogin(page);
    await page.getByTestId("login-email").fill("nobody@example.com");
    await page.getByTestId("request-access").click();
    const confirm = page.getByTestId("request-confirmation");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("an admin will review");
  });

  test("★ the dead-end code step offers a request-access path", async ({ page }) => {
    await openLogin(page);
    await page.getByTestId("login-email").fill("nobody@example.com");
    await page.getByTestId("login-send").click(); // advance to the code step — the code never arrives
    await expect(page.getByTestId("login-code")).toBeVisible();
    await page.getByTestId("request-access-from-code").click(); // the fix: request access from the dead end
    await expect(page.getByTestId("request-confirmation")).toContainText("an admin will review");
  });

  test("★ enumeration-safe: identical confirmation for a known vs unknown email", async ({ page }) => {
    await openLogin(page, { accounts: { "boss@test": "admin" } });

    await page.getByTestId("login-email").fill("boss@test"); // a real admin
    await page.getByTestId("request-access").click();
    const known = (await page.getByTestId("request-confirmation").innerText()).trim();

    await page.getByRole("button", { name: "Back to sign in" }).click();
    await page.getByTestId("login-email").fill("stranger@example.com"); // unknown
    await page.getByTestId("request-access").click();
    const unknown = (await page.getByTestId("request-confirmation").innerText()).trim();

    expect(unknown).toBe(known); // no leak — the response can't be used as an existence oracle
  });
});
