import type { NextRequest } from "next/server";

import { PROXY_COOKIE } from "@/lib/auth";

// SAME-ORIGIN screenshot proxy — the sibling of /trace-proxy/[id]. synthwatch-api #154
// gates the artifact endpoints (screenshot included) behind a bearer, and a bare
// <img src> / <a href> to the cross-origin API can carry neither the bearer header nor
// the proxy cookie — so raw links 401 for EVERYONE, logged-in or not. This route streams
// the screenshot through the dashboard's OWN origin, forwarding the caller's session
// bearer exactly like the trace proxy does. (A narrow streaming proxy — no DB.)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");

export async function GET(req: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  if (!/^\d+$/.test(runId) || !API_BASE) {
    return new Response("not found", { status: 404 });
  }

  // Forward the caller's session bearer (mirrored into a same-origin cookie by lib/auth) so the API's
  // artifact-auth gate (synthwatch-api #154) sees an authenticated request. No session → forward nothing and
  // let the API 401 (the image requiring login is the correct new behavior — never fabricate a token).
  const token = req.cookies.get(PROXY_COOKIE)?.value;
  const headers: Record<string, string> = { accept: "image/png" };
  if (token) headers.authorization = `Bearer ${token}`;

  let upstream: Response;
  try {
    // Server→server (no CORS); the C# API streams the blob via its managed identity.
    upstream = await fetch(`${API_BASE}/runs/${runId}/screenshot`, { headers });
  } catch {
    return new Response("screenshot upstream unreachable", { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    // ★ Pass auth failures THROUGH as-is (not 500/502) so the UI can show "sign in to view screenshots".
    if (upstream.status === 401 || upstream.status === 403) {
      return new Response("sign in to view screenshots", { status: upstream.status });
    }
    return new Response("screenshot unavailable", { status: upstream.status === 404 ? 404 : 502 });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "image/png",
      "cache-control": "private, max-age=300",
    },
  });
}
