import "server-only";

import { NextResponse } from "next/server";
import { ZodError } from "zod";

/**
 * Shared helpers for route handlers: consistent JSON envelopes and error
 * handling that NEVER leaks raw DB errors to the client.
 */

export function json<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

export function badRequest(message: string, details?: unknown): NextResponse {
  return NextResponse.json({ error: message, details }, { status: 400 });
}

export function notFound(message = "Not found"): NextResponse {
  return NextResponse.json({ error: message }, { status: 404 });
}

export function serverError(): NextResponse {
  // Generic message only — details are logged server-side, never returned.
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

/** Parse and validate a positive integer route param (e.g. /[id]). */
export function parseId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Wrap a route body so Zod validation errors become 400s and any other error
 * (including DB errors) becomes a logged, opaque 500. This is the single place
 * that decides what reaches the client.
 */
export async function handleRoute(
  fn: () => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ZodError) {
      return badRequest("Validation failed", err.flatten());
    }
    // Log full detail for operators; return nothing sensitive.
    console.error("[api] unhandled route error", err);
    return serverError();
  }
}
