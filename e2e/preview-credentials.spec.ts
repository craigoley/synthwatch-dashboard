import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

/**
 * The Tests scratchpad's OPTIONAL credentials. Three properties carry the UI half of this feature:
 *   1. Credentials reach the API in the POST BODY ONLY — never a URL/query param (which would land in
 *      browser history, referrer headers, and every proxy log in between).
 *   2. A credentialed run's OUTPUT is redacted, and the copy never claims the screenshot is withheld —
 *      previewPersistPlan keeps it for credentialed previews too.
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

  test("★ a credentialed run says its OUTPUT is redacted — and never claims the screenshot is suppressed", async ({ page }) => {
    const w = defaultWorld();
    // ★ STUB UNCHANGED (deliberately — swapping it for a real captured fixture is its own concern). What it
    //   now represents is a failing run that simply produced NO screenshot, which is a legitimate state.
    //   It no longer represents "suppressed because sensitive": previewPersistPlan keeps the screenshot for
    //   a credentialed preview, so that explanation would be a false statement about sensitive-data handling.
    w.previewHasScreenshot = false;
    await mockApi(page, w);
    await page.goto("/tests");

    await page.getByTestId("preview-password").fill(SENTINEL_PW);
    // The warning appears BEFORE the run — the user knows what they're trading away as they type.
    const notice = page.getByTestId("preview-sensitive-notice");
    await expect(notice).toContainText("its output is redacted");
    // ★ The regression this test now guards: the notice must NOT claim the screenshot is withheld.
    await expect(notice).not.toContainText("no screenshot is kept");

    await page.locator("textarea").first().fill(SPEC);
    await page.getByRole("button", { name: "Run preview" }).click();

    // ★ The suppression explanation must be GONE — there is no policy reason to attribute it to any more.
    await expect(page.getByTestId("preview-screenshot-suppressed")).toHaveCount(0);
    // A credentialed run with no screenshot now reads the SAME as an uncredentialed one, because the
    // retention rule is the same for both.
    await expect(page.getByText("none was captured for this run")).toBeVisible();

    // And the done-footer states the true rule rather than the old "no screenshot was kept".
    const footer = page.getByTestId("preview-done-footer");
    await expect(footer).toContainText("screenshot is kept");
    await expect(footer).not.toContainText("no screenshot");
    await expect(page.getByTestId("view-preview-trace")).toBeVisible();
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

    // ★ The screenshot survives and the suppression explanation never appears (that test-id no longer
    //   exists anywhere in the app — this keeps the assertion honest if it were ever reintroduced).
    await expect(page.getByTestId("preview-screenshot-suppressed")).toHaveCount(0);
    const shot = page.getByAltText("Preview failure screenshot");
    await expect(shot).toBeVisible();
    // ★ And it actually LOADED. `toBeVisible` alone passes on an <img> whose fetch is still in flight — the
    //   component swaps in an "unavailable" block on error, so a visible-but-unloaded img is exactly the race
    //   that made this test pass for the wrong reason. naturalWidth is only non-zero once decoded.
    await expect
      .poll(() => shot.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
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
