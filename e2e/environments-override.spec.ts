import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";
import type { RawObj } from "./fixtures";

// ★ Issue 4: a manual environment override could be SET but never CLEARED from the Environments page — the
// override list only linked out. This adds a "Clear override" action that reverts to the DERIVED env, previewing
// what the monitor becomes ("→ staging (derived)") before committing. The API already accepts null to clear
// (ChecksFunctions.cs:332), so this is dashboard-only. Proves the full round-trip: set → appears → clear → gone.
test.describe("environments — clear a manual override (round-trip)", () => {
  test("★ clear reverts to the derived env and empties the override list", async ({ page }) => {
    const w = defaultWorld();
    // Start clean: no other overrides, then give one check a manual override distinct from its derived env.
    (w.checks ?? []).forEach((c) => delete (c as RawObj).environmentOverride);
    const c = (w.checks ?? [])[0] as RawObj;
    c.environmentOverride = "prod"; // the manual override in force
    c.environment = "staging"; // the derived env it will revert to
    await mockApi(page, w);
    await page.goto("/settings/environments");

    // The override list shows the check, the effective env, and the derived-env preview.
    const row = page.getByTestId(`override-row-${c.id}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText("derived staging");
    // ★ the clear button PREVIEWS what the monitor becomes, before you commit.
    const clearBtn = page.getByTestId(`override-clear-${c.id}`);
    await expect(clearBtn).toContainText("Clear → staging (derived)");

    // Clear → the override is removed (PUT null), useChecks revalidates, the row vanishes.
    await clearBtn.click();
    await expect(page.getByTestId(`override-row-${c.id}`)).toHaveCount(0);
    // it was the only override → the whole section self-hides.
    await expect(page.getByText(/Monitors with a manual override/i)).toHaveCount(0);
  });

  test("a viewer (not editor) sees the override list but no clear control", async ({ page }) => {
    const w = defaultWorld();
    (w.checks ?? []).forEach((c) => delete (c as RawObj).environmentOverride);
    const c = (w.checks ?? [])[0] as RawObj;
    c.environmentOverride = "prod";
    c.environment = "staging";
    await mockApi(page, w, { seedSession: false }); // anonymous → read-only
    await page.goto("/settings/environments");

    await expect(page.getByTestId(`override-row-${c.id}`)).toBeVisible();
    await expect(page.getByTestId(`override-clear-${c.id}`)).toHaveCount(0); // no write control for a viewer
  });
});
