import { test, expect } from "@playwright/test";

import { mockApi, defaultWorld } from "./mock";

test.describe("status grid", () => {
  test("renders a card for every kind", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await mockApi(page);
    await page.goto("/");

    for (const name of [
      "API health",
      "Homepage flow",
      "TLS cert",
      "DNS A record",
      "TCP port",
      "Ping host",
      "Login chain",
      "Paused check",
    ]) {
      await expect(page.getByText(name, { exact: false }).first()).toBeVisible();
    }
    // kind labels (lowercase in the DOM; uppercased via CSS)
    for (const kind of ["http", "browser", "ssl", "dns", "tcp", "ping", "multistep"]) {
      await expect(page.getByText(kind, { exact: true }).first()).toBeVisible();
    }
    expect(errors).toEqual([]);
  });

  // ★ Regression lock: the API reports currentStatus "paused" for a disabled
  // check — outside the run-status taxonomy. This once returned undefined from
  // runStatusMeta and crashed the whole grid. It must never regress.
  test("a DISABLED (paused) check does NOT crash the grid", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await mockApi(page);
    await page.goto("/");

    const paused = page.locator('a[href="/checks/8"]');
    await expect(paused).toBeVisible();
    await expect(paused).toContainText(/paused/i);
    // the rest of the grid still rendered (the paused card didn't blow it up)
    await expect(page.locator('a[href="/checks/1"]')).toBeVisible();
    await expect(page.locator('a[href="/checks/7"]')).toBeVisible();
    expect(errors).toEqual([]);
  });

  // ★ Regional: some-but-not-all locations failing reads distinctly from a full
  // outage; a single-location check shows no regional indicator (no regression).
  test("a multi-location check shows the 'regional' indicator; single-location does not", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await expect(page.locator('a[href="/checks/11"]')).toContainText(/regional 1\/2/i);
    await expect(page.locator('a[href="/checks/1"]')).not.toContainText(/regional/i);
  });

  // ★ #47 — a warn location (no fail/error) surfaces as "degraded" on the card,
  // distinct from "regional" and NOT silently green/healthy.
  test("a warn location shows the 'degraded' indicator (not 'regional')", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await expect(page.locator('a[href="/checks/14"]')).toContainText(/degraded 1\/2/i);
    await expect(page.locator('a[href="/checks/14"]')).not.toContainText(/regional/i);
  });

  test("kind-specific card labels (multistep step count, ssl cert, dns record)", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");

    await expect(page.locator('a[href="/checks/7"]')).toContainText(/2 steps/);
    await expect(page.locator('a[href="/checks/3"]')).toContainText(/12d/);
    await expect(page.locator('a[href="/checks/4"]')).toContainText(/A example\.com/);
  });
});

// ★ Tag filtering on the fleet/home page (/) — rows carry {key,value} Tag[], so it reuses the shared
// TagFilter component; multi-select AND, URL-synced, with a "showing N of M" indicator so the subset is obvious.
test.describe("status grid — tag filter", () => {
  function taggedWorld() {
    const w = defaultWorld();
    // check 1 = "API health" → env:prod ; check 2 = "Homepage flow" → env:prod + team:web
    w.checks = w.checks.map((c) =>
      c.id === 1
        ? { ...c, tags: [{ key: "env", value: "prod" }] }
        : c.id === 2
          ? { ...c, tags: [{ key: "env", value: "prod" }, { key: "team", value: "web" }] }
          : { ...c, tags: [] },
    );
    w.tags = [
      { key: "env", value: "prod", count: 2 },
      { key: "team", value: "web", count: 1 },
    ];
    return w;
  }

  test("filters the fleet by tag (AND), shows a count, and URL-syncs", async ({ page }) => {
    await mockApi(page, taggedWorld());
    await page.goto("/");
    await expect(page.getByTestId("tag-filter")).toBeVisible();

    const total = await page.locator('a[href^="/checks/"]').count();
    expect(total).toBeGreaterThan(2);

    await page.getByRole("checkbox", { name: "filter env:prod" }).click();
    await expect(page.locator('a[href="/checks/1"]')).toBeVisible();
    await expect(page.locator('a[href="/checks/2"]')).toBeVisible();
    await expect(page.getByTestId("filter-count")).toContainText("Showing 2 of");
    await expect(page).toHaveURL(/tags=env/);

    await page.getByRole("checkbox", { name: "filter team:web" }).click();
    await expect(page.locator('a[href="/checks/2"]')).toBeVisible();
    await expect(page.locator('a[href="/checks/1"]')).toHaveCount(0);
    await expect(page.getByTestId("filter-count")).toContainText("Showing 1 of");
  });

  test("a shared ?tags= URL restores the filtered fleet", async ({ page }) => {
    await mockApi(page, taggedWorld());
    await page.goto("/?tags=team:web");

    await expect(page.locator('a[href="/checks/2"]')).toBeVisible();
    await expect(page.locator('a[href="/checks/1"]')).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "filter team:web" })).toHaveAttribute("aria-checked", "true");
  });

  test("clearing the tag filter restores the whole fleet (no count badge)", async ({ page }) => {
    await mockApi(page, taggedWorld());
    await page.goto("/?tags=env:prod");
    await expect(page.getByTestId("filter-count")).toBeVisible();

    await page.getByTestId("clear-tag-filter").click();
    await expect(page.getByTestId("filter-count")).toHaveCount(0); // full fleet → no subset indicator
    await expect(page.locator('a[href="/checks/1"]')).toBeVisible();
  });
});

// ★ Settled-vs-running split: the rail + health pill read the last SETTLED outcome (from spark), NOT
// current_status — so a generally-passing monitor stays GREEN while a run is in flight. The live run
// shows via a separate pulsing indicator, and the incident/regional overrides still win over it.
test.describe("status grid — settled outcome vs running", () => {
  // check 1 (single-location "API health"): currently running, last settled run PASSED.
  function runningButPassing() {
    const w = defaultWorld();
    w.checks = w.checks.map((c) =>
      c.id === 1
        ? {
            ...c,
            currentStatus: "running",
            openIncidentCount: 0,
            spark: [
              { t: "2026-07-01T10:00:00Z", d: 210, s: "pass" }, // last settled outcome
              { t: "2026-07-01T10:05:00Z", d: null, s: "running" }, // the in-flight run (newest)
            ],
          }
        : c,
    );
    return w;
  }

  test("a running monitor keeps its GREEN rail + PASS pill, with a separate running indicator", async ({ page }) => {
    await mockApi(page, runningButPassing());
    await page.goto("/");

    const card = page.locator('a[href="/checks/1"]');
    await expect(card).toBeVisible();

    // ★ rail stays green (settled pass), NOT running-blue. (Must-go-red: pre-fix the rail reads
    //   current_status="running" → var(--color-running), so both assertions fail.)
    const style = await card.getAttribute("style");
    expect(style).toContain("var(--color-pass)");
    expect(style).not.toContain("var(--color-running)");

    // pill reads the settled PASS, never RUNNING
    await expect(card.getByText("Pass", { exact: true })).toBeVisible();
    await expect(card.getByText("Running", { exact: true })).toHaveCount(0);

    // the live run shows via a SEPARATE affordance (does not recolor rail/pill)
    await expect(card.getByTestId("card-running-indicator")).toBeVisible();

    // ★ AND a blue cell-bg highlight is present too — all four signals coexist (green rail + PASS pill +
    //   dot + blue wash). Assert the ACTUAL rendered background contains the running blue (#5aa6f2).
    await expect(card).toHaveAttribute("data-running", "true");
    const bg = await card.evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(bg, "blue running wash present").toContain("0.352941 0.65098 0.94902");
  });

  test("a running monitor WITH an open incident still shows RED (override preserved)", async ({ page }) => {
    const w = runningButPassing();
    w.checks = w.checks.map((c) =>
      c.id === 1 ? { ...c, openIncidentCount: 1, maxOpenSeverity: "critical" } : c,
    );
    await mockApi(page, w);
    await page.goto("/");

    const card = page.locator('a[href="/checks/1"]');
    const style = await card.getAttribute("style");
    expect(style).toContain("var(--color-fail)"); // incident override wins over settled + running
    expect(style).not.toContain("var(--color-running)");
    await expect(card.getByTestId("card-running-indicator")).toBeVisible(); // still flagged as in-flight

    // ★ precedence: the RED incident rail stays (above), AND the blue running wash still shows — the rail is
    //   a left-edge pseudo-element painted over the background, so both are visible; blue never hides red.
    await expect(card).toHaveAttribute("data-running", "true");
    const bg = await card.evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(bg, "running wash coexists with the incident rail").toContain("0.352941 0.65098 0.94902");
  });

  test("a running monitor with NO settled run in the window falls back to idle (not a fake pass)", async ({ page }) => {
    const w = defaultWorld();
    w.checks = w.checks.map((c) =>
      c.id === 1
        ? { ...c, currentStatus: "running", openIncidentCount: 0, spark: [{ t: "2026-07-01T10:05:00Z", d: null, s: "running" }] }
        : c,
    );
    await mockApi(page, w);
    await page.goto("/");

    const card = page.locator('a[href="/checks/1"]');
    const style = await card.getAttribute("style");
    expect(style).toContain("var(--color-idle)"); // no settled outcome yet → idle, never a fabricated green
    expect(style).not.toContain("var(--color-running)");
    await expect(card.getByTestId("card-running-indicator")).toBeVisible();
  });

  test("a NON-running settled check is unchanged: green rail + PASS pill even with empty spark (no regression)", async ({ page }) => {
    // check 1 default is current_status "pass" with an empty spark window — must still read current_status,
    // not fall back to idle. This locks the no-regression fast-path.
    await mockApi(page, defaultWorld());
    await page.goto("/");
    const card = page.locator('a[href="/checks/1"]');
    const style = await card.getAttribute("style");
    expect(style).toContain("var(--color-pass)");
    await expect(card.getByText("Pass", { exact: true })).toBeVisible();
    await expect(card.getByTestId("card-running-indicator")).toHaveCount(0); // not running → no indicator

    // ★ must-go-red: NO blue highlight when not running. A bug that always-highlights (or keys off the wrong
    //   field) fails here — the rendered background must NOT contain the running blue.
    await expect(card).not.toHaveAttribute("data-running", "true");
    const bg = await card.evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(bg, "no running wash on a settled card").not.toContain("0.352941 0.65098 0.94902");
  });
});
