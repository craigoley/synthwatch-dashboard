import type { NextRequest } from "next/server";

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

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^\d+$/.test(id) || !API_BASE) {
    return new Response("not found", { status: 404 });
  }

  let upstream: Response;
  try {
    // Server→server (no CORS); the C# API streams the blob via its managed identity.
    upstream = await fetch(`${API_BASE}/runs/${id}/trace`, { headers: { accept: "application/zip" } });
  } catch {
    return new Response("trace upstream unreachable", { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
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
