/**
 * Hermetic API mock. The app is built with NEXT_PUBLIC_API_BASE_URL pointing at
 * API_BASE below, so EVERY api-client fetch (and every artifact <img>/download,
 * which apiUrl() resolves against the same origin) is a request to API_ORIGIN.
 * page.route intercepts the whole host and serves fixtures — no real network,
 * fully deterministic, per-PR.
 */
import type { Page, Route } from "@playwright/test";
import {
  defaultChecks,
  defaultDetails,
  defaultIncidents,
  defaultSteps,
  emptySla,
  type RawObj,
} from "./fixtures";

// MUST match playwright.config's webServer NEXT_PUBLIC_API_BASE_URL.
export const API_ORIGIN = "https://mock.synthwatch.test";
export const API_BASE = `${API_ORIGIN}/api`;

// 1×1 transparent PNG — a real, decodable image so <img> fires `load`, not `error`.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

export interface World {
  checks: RawObj[];
  details: Record<number, RawObj>;
  steps: Record<number, RawObj[]>;
  sla: RawObj;
  incidents: RawObj[];
  flows: RawObj[];
  /** Make the screenshot proxy return 404 (blob expired/retention). */
  screenshot404?: boolean;
  /** Override the POST /checks response (e.g. a validation 400). */
  createResponse?: { status: number; body: unknown };
  /** Make every GET fail (API-down → error-state test). */
  failAllReads?: boolean;
}

export function defaultWorld(): World {
  return {
    checks: defaultChecks(),
    details: defaultDetails(),
    steps: defaultSteps(),
    sla: emptySla(),
    incidents: defaultIncidents(),
    flows: [],
  };
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** Install the mock on a page. Pass a tweaked World for per-test variants. */
export async function mockApi(page: Page, world: World = defaultWorld()): Promise<void> {
  await page.route(`${API_ORIGIN}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    let m: RegExpMatchArray | null;

    if (method === "OPTIONS") return route.fulfill({ status: 204 });

    // Writes first (don't get caught by failAllReads).
    if (path === "/api/checks" && method === "POST") {
      if (world.createResponse) return json(route, world.createResponse.body, world.createResponse.status);
      const body = JSON.parse(req.postData() || "{}");
      return json(route, { ...body, id: 999 });
    }
    if (/^\/api\/checks\/\d+$/.test(path) && method === "PATCH") {
      return json(route, { id: Number(path.split("/").pop()) });
    }
    if (/^\/api\/checks\/\d+$/.test(path) && method === "DELETE") {
      return route.fulfill({ status: 204 });
    }

    if (world.failAllReads) return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"down"}' });

    if (path === "/api/checks" && method === "GET") return json(route, world.checks);
    if ((m = path.match(/^\/api\/checks\/(\d+)$/))) {
      const d = world.details[Number(m[1])];
      return d ? json(route, d) : json(route, { error: "not_found" }, 404);
    }
    if ((m = path.match(/^\/api\/checks\/(\d+)\/runs$/))) {
      const d = world.details[Number(m[1])];
      const runs = (d?.recentRuns as RawObj[]) ?? [];
      return json(route, { items: runs, total: runs.length, page: 1, pageSize: 50 });
    }
    if (/^\/api\/checks\/\d+\/metrics$/.test(path)) return json(route, { items: [] });
    if ((m = path.match(/^\/api\/runs\/(\d+)\/steps$/))) return json(route, world.steps[Number(m[1])] ?? []);
    if (/^\/api\/runs\/\d+\/screenshot$/.test(path)) {
      if (world.screenshot404) return route.fulfill({ status: 404 });
      return route.fulfill({ status: 200, contentType: "image/png", body: PNG_1X1 });
    }
    if (/^\/api\/runs\/\d+\/trace$/.test(path)) {
      return route.fulfill({
        status: 200,
        contentType: "application/zip",
        headers: { "content-disposition": 'attachment; filename="trace.zip"' },
        body: Buffer.from("PK\x05\x06" + "\x00".repeat(18)),
      });
    }
    if (path === "/api/sla") return json(route, { ...world.sla, window: url.searchParams.get("window") ?? "24h" });
    if (path === "/api/incidents") return json(route, world.incidents);
    if (path === "/api/flows") return json(route, world.flows);

    return json(route, []);
  });
}
