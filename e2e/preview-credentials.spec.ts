import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

/**
 * The Tests scratchpad's OPTIONAL credentials. Three properties carry the UI half of this feature:
 *   1. Credentials reach the API in the POST BODY ONLY — never a URL/query param (which would land in
 *      browser history, referrer headers, and every proxy log in between).
 *   2. A credentialed run's missing screenshot is EXPLAINED as policy, so it doesn't read as breakage.
 *   3. An uncredentialed run is completely unchanged — screenshot and all.
 * Plus the promise the copy makes: the fields are cleared once the run finishes.
 */

const SENTINEL_PW = "SENTINEL_PW_e2e_7f21";
const SENTINEL_USER = "sentinel.user@example.test";
const SENTINEL_BYPASS = "SENTINEL_BYPASS_e2e_44ab";

const SPEC = "import { test } from '../../lib/flow';\ntest('login', async () => {});";

test.describe("Tests scratchpad — optional per-run credentials", () => {
  test("★ credentials go in the POST BODY ONLY — never a URL/query param", async ({ page }) => {
    const w = defaultWorld();
    await mockApi(page, w); // default = a seeded editor session
    await page.goto("/tests");

    await page.getByTestId("preview-username").fill(SENTINEL_USER);
    await page.getByTestId("preview-password").fill(SENTINEL_PW);
    await page.getByTestId("preview-bypass-token").fill(SENTINEL_BYPASS);
    await page.locator("textarea").first().fill(SPEC);

    // Watch EVERY request the page makes for the whole run, not just the POST — a credential could leak via
    // the poll URL, the screenshot proxy, or the trace proxy just as easily as via the create call.
    const seenUrls: string[] = [];
    page.on("request", (r) => seenUrls.push(r.url()));

    await page.getByRole("button", { name: "Run preview" }).click();
    await expect(page.getByTestId("preview-done-footer")).toBeVisible();

    for (const url of seenUrls) {
      for (const secret of [SENTINEL_PW, SENTINEL_USER, SENTINEL_BYPASS]) {
        expect(url, `a credential leaked into a request URL: ${url}`).not.toContain(secret);
        expect(url).not.toContain(encodeURIComponent(secret));
      }
    }

    // ★ NON-VACUITY: they really did travel — in the body, under the API's field names. Without this the
    //   URL scan above would pass just as happily if the fields were never sent at all.
    const req = w.previewRequests?.[0];
    expect(req).toBeTruthy();
    expect(req!.url).toMatch(/\/api\/preview$/); // no query string whatsoever
    expect(req!.body.credentials).toEqual({
      username: SENTINEL_USER,
      password: SENTINEL_PW,
      vercelBypassToken: SENTINEL_BYPASS,
    });
  });

  test("★ a credentialed run explains the suppressed screenshot instead of looking broken", async ({ page }) => {
    const w = defaultWorld();
    w.previewHasScreenshot = false; // what the runner actually does for a sensitive run
    await mockApi(page, w);
    await page.goto("/tests");

    await page.getByTestId("preview-password").fill(SENTINEL_PW);
    // The warning appears BEFORE the run — the user knows what they're trading away as they type.
    await expect(page.getByTestId("preview-sensitive-notice")).toContainText("no screenshot is kept");

    await page.locator("textarea").first().fill(SPEC);
    await page.getByRole("button", { name: "Run preview" }).click();

    // ★ The missing screenshot is attributed to policy, and says what IS still available.
    const suppressed = page.getByTestId("preview-screenshot-suppressed");
    await expect(suppressed).toBeVisible();
    await expect(suppressed).toContainText("treated as sensitive");
    await expect(suppressed).toContainText("can't be redacted");
    await expect(suppressed).toContainText("Playwright trace below are unaffected");
    // The generic "none was captured" wording must NOT be what a credentialed user sees.
    await expect(suppressed).not.toContainText("none was captured for this run");

    // The trace itself is still offered — the claim "you still get the full trace" has to be true.
    await expect(page.getByTestId("view-preview-trace")).toBeVisible();
    await expect(page.getByTestId("preview-done-footer")).toContainText("no screenshot was kept");
  });

  test("★ the fields are CLEARED once the run finishes — 'used for this run only', enforced", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/tests");

    await page.getByTestId("preview-username").fill(SENTINEL_USER);
    await page.getByTestId("preview-password").fill(SENTINEL_PW);
    await page.getByTestId("preview-bypass-token").fill(SENTINEL_BYPASS);
    await page.locator("textarea").first().fill(SPEC);

    // Non-vacuity: they ARE populated before the run, so the empty assertion after means something.
    await expect(page.getByTestId("preview-password")).toHaveValue(SENTINEL_PW);

    await page.getByRole("button", { name: "Run preview" }).click();
    await expect(page.getByTestId("preview-done-footer")).toBeVisible();

    await expect(page.getByTestId("preview-username")).toHaveValue("");
    await expect(page.getByTestId("preview-password")).toHaveValue("");
    await expect(page.getByTestId("preview-bypass-token")).toHaveValue("");
    // And the credential never survives in the rendered DOM anywhere.
    expect(await page.content()).not.toContain(SENTINEL_PW);
  });

  test("★ an UNCREDENTIALED run is unchanged — screenshot kept, no sensitive notice", async ({ page }) => {
    const w = defaultWorld();
    await mockApi(page, w);
    await page.goto("/tests");

    // No credential warning until something is typed.
    await expect(page.getByTestId("preview-sensitive-notice")).toHaveCount(0);

    await page.locator("textarea").first().fill(SPEC);
    await page.getByRole("button", { name: "Run preview" }).click();
    await expect(page.getByTestId("preview-done-footer")).toBeVisible();

    // ★ The screenshot survives and the suppression explanation never appears.
    await expect(page.getByTestId("preview-screenshot-suppressed")).toHaveCount(0);
    await expect(page.getByAltText("Preview failure screenshot")).toBeVisible();
    await expect(page.getByTestId("preview-done-footer")).toContainText("unauthenticated");

    // ★ And the request carries NO credentials node at all — an untouched form must not send empty strings,
    //   which the API would otherwise have to normalize away.
    expect(w.previewRequests?.[0]?.body.credentials).toBeUndefined();
  });

  test("secrets are masked by default and revealable for proofreading", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/tests");

    // ★ Masked by default — nothing is readable over a shoulder or in a screen share by accident.
    for (const id of ["preview-username", "preview-password", "preview-bypass-token"]) {
      await expect(page.getByTestId(id)).toHaveAttribute("type", "password");
      await expect(page.getByTestId(id)).toHaveAttribute("autocomplete", "off");
    }
    // Revealing is explicit and reversible — a mistyped credential otherwise fails the login and reads as a
    // broken selector, which is the expensive misdiagnosis in a tool built for diagnosis.
    await page.getByTestId("preview-toggle-secrets").click();
    await expect(page.getByTestId("preview-password")).toHaveAttribute("type", "text");
    await page.getByTestId("preview-toggle-secrets").click();
    await expect(page.getByTestId("preview-password")).toHaveAttribute("type", "password");
  });

  test("the copy states the real contract, and the old 'no credentials' claim is gone", async ({ page }) => {
    await mockApi(page, defaultWorld());
    await page.goto("/tests");

    await expect(page.getByTestId("preview-cred-contract")).toContainText(
      "Used for this run only. Never stored, never logged.",
    );
    // ★ The pre-feature copy actively contradicted the feature — assert it cannot come back.
    await expect(page.locator("body")).not.toContainText("no credentials are ever entered here");
  });
});
