import { test, expect } from "@playwright/test";

import { GET } from "@/app/api/probe-echo/route";

/**
 * probe-echo — the public echo the SynthWatch probe hits to confirm our injected bypass header arrived and
 * we're on an expected egress IP. Pins the SECURITY contract: the raw bypass token is NEVER returned — only a
 * boolean "present?" + a 12-hex-char SHA-256 fingerprint prefix; `received_header_names` is KEYS only. Pure-Node:
 * invokes the real Edge GET handler with a stubbed Request (no browser, no webServer — same harness as the other
 * *.contract.ts route tests).
 */
const ENDPOINT = "https://synthwatch-dashboard.vercel.app/api/probe-echo";
const BYPASS = "x-vercel-protection-bypass";
const req = (headers: Record<string, string> = {}) => new Request(ENDPOINT, { headers });

test.describe("probe-echo — reflects the caller's request, never the raw bypass token", () => {
  test("no bypass header → present:false, fingerprint:null", async () => {
    const body = await (await GET(req())).json();
    expect(body.bypass_header_present).toBe(false);
    expect(body.bypass_fingerprint).toBeNull();
  });

  test("with the bypass header → present:true, fingerprint is a 12-char hex prefix (NOT the raw token)", async () => {
    const token = "super-secret-bypass-token-value";
    const body = await (await GET(req({ [BYPASS]: token }))).json();
    expect(body.bypass_header_present).toBe(true);
    expect(body.bypass_fingerprint).toMatch(/^[0-9a-f]{12}$/); // 12 hex chars…
    // ★ the raw secret NEVER appears anywhere in the response body
    expect(JSON.stringify(body)).not.toContain(token);
  });

  test("fingerprint IS SHA-256(value) sliced to 12 hex — stable + correct", async () => {
    // sha256("abc123") = 6ca13d52ca70c883e0f0bb101e425a89e8624de51db2d2392593af6a84118090
    const body = await (await GET(req({ [BYPASS]: "abc123" }))).json();
    expect(body.bypass_fingerprint).toBe("6ca13d52ca70");
  });

  test("client_ip reflects the FIRST x-forwarded-for hop (trimmed); header NAMES only, never values", async () => {
    const token = "tok-value";
    const body = await (
      await GET(
        req({
          "x-forwarded-for": "203.0.113.7, 70.0.0.1, 10.0.0.1",
          [BYPASS]: token,
          "x-vercel-id": "iad1::abc",
        }),
      )
    ).json();
    expect(body.client_ip).toBe("203.0.113.7"); // first hop, whitespace-trimmed
    expect(body.x_vercel_id).toBe("iad1::abc");
    // received_header_names carries the KEY (lowercased) but NEVER the token value
    expect(body.received_header_names).toContain(BYPASS);
    expect(body.received_header_names).not.toContain(token);
  });

  test("no x-forwarded-for → client_ip null (honest absence, not a fabricated 0.0.0.0)", async () => {
    const body = await (await GET(req())).json();
    expect(body.client_ip).toBeNull();
  });
});
