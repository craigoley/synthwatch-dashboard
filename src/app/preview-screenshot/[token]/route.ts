import type { NextRequest } from "next/server";

import { PROXY_COOKIE } from "@/lib/auth";

// SAME-ORIGIN proxy for a preview's failure screenshot — mirrors screenshot-proxy. The API's
// GET /preview/{token}/screenshot is editor-gated and STREAMS the private sandbox blob via its managed
// identity; a bare <img src> to the cross-origin API can carry neither the bearer header nor the proxy
// cookie, so it would 401 for everyone. This streams the screenshot through the dashboard's own origin,
// forwarding the caller's session bearer (mirrored into a same-origin cookie by lib/auth). A narrow proxy — no DB.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  // The preview token is 32-char lowercase hex (RandomNumberGenerator.GetBytes(16)) — reject anything else.
  if (!/^[0-9a-f]{32}$/.test(token) || !API_BASE) {
    return new Response("not found", { status: 404 });
  }

  const bearer = req.cookies.get(PROXY_COOKIE)?.value;
  const headers: Record<string, string> = { accept: "image/png" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;

  let upstream: Response;
  try {
    upstream = await fetch(`${API_BASE}/preview/${token}/screenshot`, { headers });
  } catch {
    return new Response("preview screenshot upstream unreachable", { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    // Pass auth failures THROUGH so the UI can say "sign in", not a generic 500.
    if (upstream.status === 401 || upstream.status === 403) {
      return new Response("sign in to view previews", { status: upstream.status });
    }
    return new Response("preview screenshot unavailable", { status: upstream.status === 404 ? 404 : 502 });
  }

  // no-store: a preview screenshot is uploaded-spec output (the #218 forensic-read convention).
  return new Response(upstream.body, {
    status: 200,
    headers: { "content-type": "image/png", "cache-control": "no-store" },
  });
}
