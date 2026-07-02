import type { NextRequest } from "next/server";

import { PROXY_COOKIE } from "@/lib/auth";

// SAME-ORIGIN proxy for a MONITOR's last-known-good SUCCESS trace — the per-check mirror of
// trace-proxy/[id] (which serves per-RUN failure traces). The self-hosted trace viewer fetch()es
// the .zip, and fetching it cross-origin (from the C# API origin) is the documented-broken CORS
// trap (Playwright #38622); streaming it through the dashboard's own origin dodges that. The C#
// API streams the blob via its managed identity (GET /checks/{id}/success-trace). 404 until the
// monitor has a baseline.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^\d+$/.test(id) || !API_BASE) {
    return new Response("not found", { status: 404 });
  }

  // Forward the caller's session bearer (same-origin cookie from lib/auth) to satisfy the API's artifact-auth
  // gate (#154). No session → forward nothing → the API 401s (viewer shows "sign in"), never a fabricated token.
  const token = req.cookies.get(PROXY_COOKIE)?.value;
  const headers: Record<string, string> = { accept: "application/zip" };
  if (token) headers.authorization = `Bearer ${token}`;

  let upstream: Response;
  try {
    // Server→server (no CORS); the C# API streams the blob via its managed identity.
    upstream = await fetch(`${API_BASE}/checks/${id}/success-trace`, { headers });
  } catch {
    return new Response("trace upstream unreachable", { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    // ★ Pass auth failures THROUGH as-is (not 500/502) so the UI can show "sign in to view traces".
    if (upstream.status === 401 || upstream.status === 403) {
      return new Response("sign in to view traces", { status: upstream.status });
    }
    return new Response("trace unavailable", { status: upstream.status === 404 ? 404 : 502 });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "cache-control": "private, max-age=300",
    },
  });
}
