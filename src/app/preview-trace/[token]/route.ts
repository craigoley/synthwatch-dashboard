import type { NextRequest } from "next/server";

import { PROXY_COOKIE } from "@/lib/auth";

// SAME-ORIGIN proxy for a preview's Playwright trace.zip — mirrors the screenshot proxy. The API's
// GET /preview/{token}/trace is editor-gated and STREAMS the private sandbox blob via its managed identity
// (no SAS — minting one would widen the API MI). The self-hosted trace viewer (/trace-viewer) fetches the zip
// from a URL; a same-origin proxy path lets it read the private blob without a SAS or a cross-origin bearer.
// A preview trace is bounded (≤ the sandbox size cap) so streaming it through this origin is fine.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!/^[0-9a-f]{32}$/.test(token) || !API_BASE) {
    return new Response("not found", { status: 404 });
  }

  const bearer = req.cookies.get(PROXY_COOKIE)?.value;
  const headers: Record<string, string> = { accept: "application/zip" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;

  let upstream: Response;
  try {
    upstream = await fetch(`${API_BASE}/preview/${token}/trace`, { headers });
  } catch {
    return new Response("preview trace upstream unreachable", { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    if (upstream.status === 401 || upstream.status === 403) {
      return new Response("sign in to view previews", { status: upstream.status });
    }
    return new Response("preview trace unavailable", { status: upstream.status === 404 ? 404 : 502 });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: { "content-type": "application/zip", "cache-control": "no-store" },
  });
}
