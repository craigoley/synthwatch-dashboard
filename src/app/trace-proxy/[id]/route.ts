import type { NextRequest } from "next/server";

import { PROXY_COOKIE } from "@/lib/auth";

// SAME-ORIGIN trace proxy. The Playwright trace viewer (self-hosted at
// /trace-viewer) must fetch() the trace.zip — and fetch() is CORS-gated. The trace
// lives behind the C# API's managed-identity proxy on a DIFFERENT origin
// (NEXT_PUBLIC_API_BASE_URL), so a browser fetch of it is cross-origin: the
// documented-broken combination (Playwright #38622 — external/embedded viewer +
// blob-backed trace fails on cross-origin + auth). This route streams the trace
// through the dashboard's OWN origin, so the viewer fetches it same-origin — no CORS,
// works on prod / preview / localhost alike. (A narrow streaming proxy — no DB, not a
// revival of the old backend.) Falls back are the API's MI proxy + download link.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^\d+$/.test(id) || !API_BASE) {
    return new Response("not found", { status: 404 });
  }

  // Forward the caller's session bearer (mirrored into a same-origin cookie by lib/auth) so the API's
  // artifact-auth gate (synthwatch-api #154) sees an authenticated request. No session → forward nothing and
  // let the API 401 (the viewer requiring login is the correct new behavior — never fabricate a token).
  const token = req.cookies.get(PROXY_COOKIE)?.value;
  const headers: Record<string, string> = { accept: "application/zip" };
  if (token) headers.authorization = `Bearer ${token}`;

  let upstream: Response;
  try {
    // Server→server (no CORS); the C# API streams the blob via its managed identity.
    upstream = await fetch(`${API_BASE}/runs/${id}/trace`, { headers });
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
