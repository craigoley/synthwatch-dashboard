# Operations runbook — accounts, sign-in, and access

How to onboard/offboard a team member and what they'll experience signing in.

> _Verified 2026-07-14 — prose with **no automated check**. If the code disagrees, the code is authoritative._

Everything below is grounded in this repo's source, **cited by SYMBOL** (function /
export name) rather than by line — a symbol survives a refactor; a line number drifts
(these api-client anchors had drifted ~600 lines before this). Steps that
live in the **synthwatch-api** repo (the C# API on Azure) and can't be confirmed
from here are labeled **needs-verification** — confirm them against that repo
before relying on the specifics.

## The model in one paragraph

Reading the dashboard **never requires sign-in** — it's a status page first
(`src/components/auth-provider.tsx` login copy: "Reading the dashboard never
requires sign-in"). Writes (create/edit/pause monitors, channels, routing,
reconcile actions) require an **editor** or **admin** session; user management
requires **admin**. The dashboard only *hides* affordances — the C# API is the
sole security boundary and 401/403s anything unauthorized regardless of what the
UI shows (`src/components/write-gate.tsx:7-8`, `src/app/users/page.tsx:5-7`).
Roles are `admin | editor | anonymous` (`src/lib/auth.ts:19`).

## 1. Adding / removing people

### Editors (day-to-day write access) — self-serve via the UI

An **admin** does this entirely in the dashboard at **`/users`** (the nav link
is admin-only, but the URL works directly):

- **Add:** enter the email under "Add an editor" → `POST /api/editors {email}`
  (`api-client.ts` `addEditor`). The address can then sign in with write
  access immediately — no deploy, no restart.
- **Remove:** "Remove" next to the editor → `DELETE /api/editors/{email}`
  (`api-client.ts` `removeEditor`). Their existing session's *role* comes
  from the server on every re-validation, so removal takes effect without
  waiting for the 30-day expiry (see §2).
- **Grant from a request:** people who ask for access via the login modal land
  in the "Pending access requests" queue on the same page — "Add as editor"
  grants (and clears the request); "Dismiss" clears it without granting.

All these endpoints are **admin-gated server-side** — a non-admin gets a 403
(`api-client.ts`, the `addEditor`/`removeEditor` editor-management block — admin-only); the page hiding itself from non-admins is UX
only (`src/app/users/page.tsx:65-72`).

### Admins — env-configured on the API, not manageable in the UI

There is deliberately **no UI path to mint an admin**: `addEditor` takes only an
email, no role parameter (`api-client.ts` `addEditor`), and nothing in
this repo's source mutates a role. Admin identity comes from an allowlist
environment variable read by the **C# API**. The only reference in this repo is
the `/users` empty-state hint: *"Admins (from ADMIN_EMAILS) always have access;
add editors to grant write access to others."* (`src/app/users/page.tsx:118`).

> **needs-verification (synthwatch-api repo):**
> - The exact variable name (`ADMIN_EMAILS` per the UI hint — confirm spelling
>   and value format, e.g. comma-separated, in the API's config code).
> - Where it's set: expected to be an Azure Functions **application setting** on
>   the synthwatch-api Function App (like `Cors__AllowedOrigin`, which this
>   repo's README documents as an API-side setting).
> - Whether changing it takes effect immediately or needs an app
>   restart/redeploy (Azure app-setting changes typically restart the app —
>   confirm).
> - Whether an admin email must ALSO complete the same OTP sign-in (expected:
>   yes — the allowlist grants the *role*, not a session).

This is also the **first-admin bootstrap** path: before any admin exists in the
env list, nobody can reach `/users` to add editors.

## 2. What a new user experiences — OTP sign-in

1. **"Sign in to edit"** in the header opens the login modal (any page).
2. **Email step** → `POST /api/auth/request-code`
   (`api-client.ts` `authRequestCode`). The response message is deliberately
   **enumeration-safe** — the same "check your email" copy whether or not the
   address has access, so an outsider can't probe who's on the list. If no code
   arrives, that usually means the address isn't an editor/admin yet.
3. **Code step** — a 6-digit OTP from the email → `POST /api/auth/verify`
   (`api-client.ts` `authVerify`), which mints the session
   `{token, email, role, expiresAt}`. A bad/expired code is a 400 shown inline.
4. **No access?** "Request it" in the modal → `POST /api/auth/request-access`
   (`api-client.ts` `authRequestAccess`, also enumeration-safe) → lands in the
   admin's `/users` queue (§1).

**Session mechanics** (all verified in `src/lib/auth.ts`):

- The token is an **opaque, DB-backed, server-revocable 30-day session**
  (`auth.ts:14`), stored in `localStorage` (`synthwatch.session`) and mirrored
  into the same-origin `sw_proxy_session` cookie so the server-side artifact
  proxies (`/trace-proxy/*`, `/screenshot-proxy/*`) can forward it as a bearer
  (`auth.ts:40-47`).
- On every page load the stored session is re-validated via `GET /api/auth/me`
  (`src/components/auth-provider.tsx` mount effect) — a revoked/expired token
  drops to anonymous, and a changed role takes effect here.
- **There is no renewal** — at 30 days the session hard-expires; the next authed
  action gets a 401, the session is cleared, and the login modal reopens for a
  fresh OTP (`src/lib/api-client.ts` 401 interceptor). Sign-out revokes
  server-side (`POST /api/auth/logout`, `api-client.ts` `authLogout`).
- The email itself (OTP delivery) is sent by the API/runner side —
  **needs-verification:** which channel/provider sends it and its
  sender address live in the synthwatch-api repo.

## 3. The auth-enforcement flag

The dashboard code refers throughout to "slice 2's gate" on the API as the real
enforcement (`auth-provider.tsx:11`, `write-gate.tsx:7`): with the gate ON, the
API requires an editor/admin bearer on mutating endpoints (401 for no/invalid
token, 403 for a valid-but-unauthorized one) and — as of the api read-gate sweep
— a session floor on selected read endpoints (`/reconcile/*`, `/channels`).
The dashboard's e2e mock models it as a boolean world flag, "when true, mutating
non-allowlisted writes require an editor/admin token (gate ON)"
(`e2e/mock.ts:165-173`).

What the dashboard does under it is fully verified here:

- **401** (no/expired session): session cleared + re-login modal — but only if a
  bearer was actually sent; an anonymous 401 on a read-gated endpoint renders a
  calm "Sign in to view" panel instead of popping the modal
  (`src/lib/api-client.ts` interceptor, PR #185).
- **403** (signed in, wrong role): a persistent permission toast; the session is
  kept (`src/components/auth-provider.tsx`).

> **needs-verification (synthwatch-api repo):** the flag's real name, where it's
> set (expected: an app setting on the Function App), and its current value in
> prod. This repo's #174 commit history records artifact-endpoint enforcement as
> "ON in prod" since 2026-07-02, but the flag itself is not visible from here.

## Related

- Dashboard env (`NEXT_PUBLIC_API_BASE_URL`) and CORS: see the
  [README's Environment section](../README.md#environment).
- House rules for working in this repo: [CLAUDE.md](../CLAUDE.md).
