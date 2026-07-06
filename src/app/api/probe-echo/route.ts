// Public echo endpoint the SynthWatch probe hits to confirm (a) our injected `x-vercel-protection-bypass`
// header actually arrived and (b) we're egressing from an expected IP — isolating our injection + egress IP
// from the Akamai B2C block InfoSec is investigating.
//
// Deliberately PUBLIC — no auth, no gating. It only ever reflects the CALLER'S OWN request back to them
// (their IP, their header names, a fingerprint of a token they themselves sent), so it discloses nothing
// about us to a random visitor. Gating it would just get in the probe's way for zero security gain.
//
// SECURITY: the bypass token is a genuine secret (a Vercel secretRef; never persisted or logged, per the
// redaction policy). This route NEVER returns its raw value — only a boolean "was it present?" and the first
// 12 hex chars of SHA-256(value). `received_header_names` is header KEYS only (values would leak the token
// and any other secret header); the fingerprint hash is the SOLE value this route ever emits.
//
// Edge runtime: this is a zero-dependency reflector and Web Crypto (`crypto.subtle`) is native to Edge — no
// need for the Node runtime the proxy routes use.
export const runtime = "edge";
export const dynamic = "force-dynamic";

const BYPASS_HEADER = "x-vercel-protection-bypass";

export async function GET(request: Request) {
  const bypass = request.headers.get(BYPASS_HEADER);

  // Fingerprint (not the value): SHA-256 → first 12 hex chars. Enough to correlate which token the probe
  // presented across runs; not reversible to the secret. Null when the header is absent (honest absence).
  let bypassFingerprint: string | null = null;
  if (bypass !== null) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bypass));
    bypassFingerprint = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 12);
  }

  return Response.json({
    bypass_header_present: bypass !== null,
    bypass_fingerprint: bypassFingerprint,
    // First x-forwarded-for hop = the real client edge IP (Vercel appends its own downstream). Null (not a
    // fabricated 0.0.0.0) when the header is missing.
    client_ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    x_vercel_id: request.headers.get("x-vercel-id"),
    // NAMES only — never values. Header keys are already lowercased by the Fetch API.
    received_header_names: [...request.headers.keys()],
  });
}
