import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld, API_BASE } from "./mock";

// ★ api read-gate sweep companion (forward-compatible — merges BEFORE the api gates its GETs).
// The api is putting GET /reconcile/drift, /reconcile/plan, and /channels behind a session floor.
// These pin the dashboard's side of that contract:
//   1. the session bearer already rides those GETs (the api's gate can rely on it),
//   2. an ANONYMOUS 401 renders a calm "sign in to view" state — no red error, and NEVER a
//      surprise login modal on a read-only page (there was no session to expire),
//   3. a signed-in session passes the gate and the surfaces render exactly as before.

function gatedWorld() {
  const w = defaultWorld();
  w.readGate401 = true;
  w.reconcileDrift = { items: [] }; // reconcile ran, in sync — renders the positive state when authed
  w.channels = [
    { id: 1, name: "Ops email", type: "email", enabled: true, config: { to: ["ops@test"] } },
  ];
  return w;
}

test.describe("read-gated GETs — bearer forwarding", () => {
  test("★ the session bearer rides GET /reconcile/drift and GET /channels (the api gate's precondition)", async ({ page }) => {
    const seen = new Map<string, string | undefined>();
    page.on("request", (req) => {
      const u = req.url();
      if (u.startsWith(API_BASE) && (u.includes("/reconcile/drift") || u.endsWith("/channels"))) {
        seen.set(new URL(u).pathname, req.headers()["authorization"]);
      }
    });
    await mockApi(page, gatedWorld()); // seeds the editor session by default
    await page.goto("/monitors");
    await expect(page.getByTestId("drift-insync")).toBeVisible(); // authed → gate passed → normal render
    await page.goto("/notifications");
    await expect(page.getByText("Ops email").first()).toBeVisible();

    expect(seen.get("/api/reconcile/drift")).toBe("Bearer swt_e2e-editor@test");
    expect(seen.get("/api/channels")).toBe("Bearer swt_e2e-editor@test");
  });
});

test.describe("read-gated GETs — anonymous 401 is a sign-in state, not noise", () => {
  test("★ /monitors: gated drift → SignInToView, no login modal, no red error", async ({ page }) => {
    await mockApi(page, gatedWorld(), { seedSession: false });
    await page.goto("/monitors");

    await expect(page.getByTestId("drift-signin")).toBeVisible();
    await expect(page.getByTestId("drift-signin")).toContainText(/sign in to view/i);
    // never a surprise modal on a read-only page (there was no session to expire) …
    await expect(page.getByTestId("login-modal")).toHaveCount(0);
    // … and never a red ErrorState (the data is fine; the viewer just isn't signed in)
    await expect(page.getByTestId("drift-error")).toHaveCount(0);
  });

  test("★ /notifications: gated channels → SignInToView, no modal, not 'setup pending'", async ({ page }) => {
    await mockApi(page, gatedWorld(), { seedSession: false });
    await page.goto("/notifications");

    await expect(page.getByTestId("channels-signin")).toBeVisible();
    await expect(page.getByTestId("login-modal")).toHaveCount(0);
    // a 401 must NOT read as "the notifications service isn't deployed" (that's the 404 state)
    await expect(page.getByTestId("setup-pending")).toHaveCount(0);
    await expect(page.getByTestId("channels-error")).toHaveCount(0);
  });

  test("the sign-in affordance opens the login modal on demand", async ({ page }) => {
    await mockApi(page, gatedWorld(), { seedSession: false });
    await page.goto("/monitors");
    await page.getByTestId("drift-signin").getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByTestId("login-modal")).toBeVisible();
  });
});

test.describe("read-gated GETs — real failures stay LOUD (#175)", () => {
  test("a 500 on the drift read renders the ErrorState, never a silent hide", async ({ page }) => {
    const w = gatedWorld();
    w.readGate401 = false;
    await mockApi(page, w);
    // Override just the drift GET with a 500 (a route added after mockApi takes precedence).
    await page.route(`${API_BASE}/reconcile/drift`, (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }),
    );
    await page.goto("/monitors");
    await expect(page.getByTestId("drift-error")).toBeVisible();
    await expect(page.getByTestId("drift-signin")).toHaveCount(0);
  });
});
