import { test, expect } from "@playwright/test";
import { NextRequest } from "next/server";

import { GET as runTraceGET } from "@/app/trace-proxy/[id]/route";
import { GET as successTraceGET } from "@/app/trace-proxy/check/[id]/route";

/**
 * trace-proxy session forwarding (paired with synthwatch-api #154, which gates the artifact endpoints behind a
 * bearer). Pins: the proxy forwards the caller's session bearer (from the same-origin sw_proxy_session cookie)
 * as `Authorization: Bearer` on the server→API fetch; with no cookie it forwards nothing and passes the API's
 * 401 THROUGH as a 401 (so the UI shows "sign in", not a broken/500 viewer). Pure-Node: invokes the real route
 * GET handlers with a stubbed global fetch. (API base comes from playwright.contract.config.ts.)
 */
const BASE = "https://api.example.test/api";

async function withUpstream(status: number, fn: (cap: () => { url: string; auth: string | null }) => Promise<void>) {
  const orig = globalThis.fetch;
  let url = "";
  let auth: string | null = null;
  globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
    url = String(u);
    auth = new Headers(init?.headers as HeadersInit | undefined).get("authorization");
    return new Response(status === 200 ? new Uint8Array([1, 2, 3]) : "nope", { status });
  }) as typeof fetch;
  try {
    await fn(() => ({ url, auth }));
  } finally {
    globalThis.fetch = orig;
  }
}

const req = (cookie?: string) =>
  new NextRequest("https://dash.example.test/trace-proxy/123", cookie ? { headers: { cookie } } : undefined);
const ctx = { params: Promise.resolve({ id: "123" }) };

for (const [label, GET, path] of [
  ["run trace", runTraceGET, "/runs/123/trace"],
  ["success trace", successTraceGET, "/checks/123/success-trace"],
] as const) {
  test.describe(`trace-proxy (${label}) — session forwarding`, () => {
    test("★ forwards the caller's session bearer as Authorization when the cookie is present", async () => {
      await withUpstream(200, async (cap) => {
        const res = await GET(req("sw_proxy_session=tok-abc123"), ctx);
        expect(res.status).toBe(200);
        expect(cap().url).toBe(`${BASE}${path}`);
        expect(cap().auth).toBe("Bearer tok-abc123"); // ★ the exact header shape #154's FromBearerAsync expects
      });
    });

    test("★ no session cookie → forwards NO Authorization, and passes the API 401 THROUGH as 401 (not 500)", async () => {
      await withUpstream(401, async (cap) => {
        const res = await GET(req(), ctx);
        expect(cap().auth).toBeNull(); // never fabricate a token
        expect(res.status).toBe(401); // passthrough → UI shows "sign in", not a broken viewer
      });
    });

    test("403 also passes through (not 500)", async () => {
      await withUpstream(403, async () => {
        expect((await GET(req("sw_proxy_session=tok"), ctx)).status).toBe(403);
      });
    });

    test("404 upstream still maps to 404 (unchanged)", async () => {
      await withUpstream(404, async () => {
        expect((await GET(req("sw_proxy_session=tok"), ctx)).status).toBe(404);
      });
    });
  });
}
