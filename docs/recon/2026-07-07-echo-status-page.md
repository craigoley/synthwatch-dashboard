# Recon — probe-echo status page (2026-07-07)

Analysis-only. Branch `analysis/recon-echo-status-page` from `origin/main` @ `dca6882`. No new page — this
grounds the contract so a page (if greenlit) builds on the real #198 shape, not an assumed one.

**Evidence contract.** Every finding cites `file:line` or command output. **OBSERVED** = read directly from
code on this commit. **INFERRED** = reasoned from observed facts.

### Verdicts at a glance

| # | Question | Answer |
|---|----------|--------|
| 1 | What does the echo return? | 5 fields: `bypass_header_present`, `bypass_fingerprint` (12-hex SHA-256 prefix or null), `client_ip`, `x_vercel_id`, `received_header_names` (keys only). Raw token **never** returned (`route.ts:35-44`; pinned by the contract test). |
| 2 | JSON-only, or a human page? | **JSON-only.** The endpoint has **zero UI consumers** — only the contract test imports it. No page/component/fetch renders it. Craig's "status page" does not exist yet. |
| 3 | Does it answer "bypass present + IP allowlisted"? | **Partly.** It answers "is my bypass header present" (`bypass_header_present`) and "what IP am I on" (`client_ip`), but it reports `client_ip` **raw** — it does **not** validate it against the 3 allowlisted /32s. No allowlist constant exists in the repo. |
| 4 | New page warranted? | The endpoint **already suffices for the programmatic probe** (the primary use). A minimal human page adds only at-a-glance green/red for the *same self-check* — warranted **only if** InfoSec wants the visual. Scoped below, no open questions. |

---

## Q1 — What the echo endpoint returns (OBSERVED)

`src/app/api/probe-echo/route.ts:35-44` — an Edge `GET` returning `Response.json({...})` with exactly:

```
bypass_header_present : boolean            // route.ts:36 — `x-vercel-protection-bypass` present?
bypass_fingerprint    : string | null      // :37 — first 12 hex of SHA-256(token), else null (:26-33)
client_ip             : string | null      // :40 — first x-forwarded-for hop, trimmed; null if absent
x_vercel_id           : string | null      // :41 — the `x-vercel-id` header
received_header_names  : string[]           // :43 — request header KEYS only (lowercased), never values
```

**The raw token is NEVER in the response** (OBSERVED, belt-and-suspenders):
- Only a boolean + a truncated SHA-256 fingerprint are emitted for the token (`route.ts:26-33,36-37`); the
  full value is never placed in any field.
- `received_header_names` is `[...request.headers.keys()]` — **keys only** (`route.ts:43`), so a header
  *value* (incl. the token) can't leak through it.
- The #198 contract test pins this: `received_header_names` contains the header *key* but
  `.not.toContain(token)` (`contract/probe-echo.contract.ts:52-53`), and the fingerprint is a 12-hex prefix,
  not the token (`:23-36`).

The route is `runtime = "edge"`, `dynamic = "force-dynamic"` (`route.ts:16-17`), deliberately public and
un-gated because it reflects only the caller's own request (`route.ts:5-7`).

---

## Q2 — JSON-only, or is there human-visible rendering today? (OBSERVED)

**JSON-only. There is no page.** Falsifier (run): `grep -rn "probe-echo" src/ e2e/ contract/` → the **only**
reference is `contract/probe-echo.contract.ts:3` (`import { GET } from "@/app/api/probe-echo/route"`). No
`src/app/**/page.tsx`, no component, and no client `fetch("/api/probe-echo")` exists. The app's page routes
(`find src/app -name page.tsx`) are: home, checks/[id], incidents(/[id]), monitors, notifications, reports,
specs, status, throw-test, trust, users — **none** for probe-echo.

So of the two shapes in the ask:
- **(a) a human-readable page** that calls the echo and renders green/red for InfoSec to eyeball — **does not
  exist**.
- **(b) the JSON endpoint a probe hits programmatically** — **this is what exists** (#198).

---

## Q3 — Does it already answer "bypass present + allowlisted IP"? (OBSERVED + INFERRED)

**It answers the header question and reports the IP, but does NOT validate the IP against the allowlist.**

- "Is my bypass header present?" → **yes**, directly: `bypass_header_present` (`route.ts:36`), plus the
  `bypass_fingerprint` to correlate *which* token (`route.ts:37`).
- "Am I coming from an allowlisted IP?" → **only the raw IP is returned** (`client_ip`, `route.ts:40`). The
  route does **no** comparison to the 3 known ACA /32s. The reader must eyeball `client_ip ∈ {…}` themselves.

**There is no allowlist constant in the codebase** (OBSERVED). Falsifier (run):
`grep -rniE "allowlist|/32|\bACA\b" src/` → "allowlist" appears only as **prose** in the egress-stability
component (`src/components/egress-stability.tsx:13-16,136-137` — "the current public egress IP per region —
allowlist these") and the `/status` page comment that hosts it (`src/app/status/page.tsx:154`). No hardcoded
list of the 3 /32s exists anywhere in `src/`.

**INFERRED — the "3 known ACA /32s" ARE the real egress IPs, already surfaced elsewhere.** The three IPs in
the ask (`20.85.72.149` / `172.169.169.109` / `20.80.135.196`) appear in-repo only as the real per-region
egress IPs in the egress e2e fixtures (`e2e/mock.ts:224-226`, `e2e/egress.spec.ts:18-20`). Those are exactly
the `current_ips` the egress-stability panel renders as "the allowlist artifact… handed to Wegmans"
(`egress-stability.tsx:44,73,136`), sourced live from `getEgressReport` → `/reports/egress` `currentIps`. So
the allowlist's ground truth is the **egress report**, not a static list — and the egress panel already warns
loudly when the SNAT pool rotates and the allowlist goes stale (`egress-stability.tsx:16,89,136-137`). A
hardcoded 3-/32 list would silently drift out of date exactly when that rotation warning fires.

---

## Q4 — Recommendation (scope only; do NOT build)

**The endpoint already suffices for the primary, stated use** — a probe hitting `/api/probe-echo`
programmatically gets `bypass_header_present` and `client_ip` and can compare the IP to the allowlist itself.
For that path, **no page is needed**; a one-line note ("check `bypass_header_present === true` and
`client_ip ∈ allowlist`") closes it.

**A minimal human page is warranted ONLY IF** InfoSec wants at-a-glance green/red instead of reading JSON. It
adds no new capability — it re-renders the same self-check. If Craig greenlights, here is the minimal,
no-open-questions scope:

### Minimal page scope (if greenlit)
- **Route:** a new client page `src/app/probe-status/page.tsx` (a dedicated route; do **not** fold into
  `/status`, which is the stakeholder fleet board). Public/un-gated, matching the endpoint's design
  (`route.ts:5-7`).
- **Behavior:** on load, `fetch("/api/probe-echo")` (same-origin) and render **two rows**:
  1. **Bypass header** — green when `bypass_header_present`, red when not; show `bypass_fingerprint` as a
     small correlation caption.
  2. **Egress IP** — show `client_ip`; green when it's in the allowlist, red otherwise; show `x_vercel_id`
     as a caption (region/debug id).
  Reuse the existing status tokens (`TONE_VAR`, `StatusDot` in `src/components/status-badge.tsx`) — same
  green/amber/red language as the rest of the app.
- **Allowlist source (the one real decision):**
  - **Preferred (drift-proof):** derive the allowlist from `getEgressReport()` → `/reports/egress`
    `current_ips` (the same live source the egress panel uses). No hardcoded IPs; auto-tracks SNAT rotation.
  - **Fallback (simplest):** a `const ALLOWLIST = ["20.85.72.149","172.169.169.109","20.80.135.196"]`. ⚠️
    This drifts the moment the SNAT pool rotates — the exact failure the egress panel exists to catch — so if
    used, it must be a documented, reviewed constant, not silently trusted.
- **Test:** an e2e that stubs `/api/probe-echo` (via the mock harness) with (present bypass + allowlisted IP)
  → both green; (no bypass + off-allowlist IP) → both red. Mirror the rendered-value assertion style.

### ★ Critical scoping caveat (must be stated in the build ticket) — INFERRED
A **client-side** page reflects **the browser that loads it**, not the probe. So:
- If the honest probe (or a `curl` with the bypass header from an allowlisted host) loads it → it confirms
  *that* caller's headers/IP. Correct and useful.
- If an InfoSec engineer opens it in a **normal browser**, it will (correctly) show **red** — their browser
  isn't the allowlisted probe and sends no bypass header. That is the *true* answer for their request, but it
  does **not** prove the probe's path. The page confirms "is THIS request arriving correctly," identical
  reflector semantics to the endpoint — it is **not** a view of the probe's last run.
- If InfoSec needs to see the *probe's* result specifically, the page must be loaded **by the probe** (or by
  a request carrying the bypass header from an allowlisted egress), not from a desk browser. This should be
  explicit in the ticket to avoid a "why is it red?" false alarm.

**Bottom line:** endpoint is sufficient for the programmatic probe; a page is a thin at-a-glance convenience
for the same self-check. Recommend shipping the page **only** if InfoSec explicitly wants the visual, and if
so, derive the allowlist from `/reports/egress` (not a hardcoded list) and document the "reflects the loader,
not the probe" caveat.

---

## Appendix — commands run

- `grep -rn "probe-echo" src/ e2e/ contract/` → 1 hit (the contract test import).
- `grep -rn "<each of the 3 IPs>" src/ e2e/ contract/` → only `e2e/mock.ts` + `e2e/egress.spec.ts` (egress
  fixtures); none in `src/`.
- `grep -rniE "allowlist|/32|\bACA\b" src/` → prose only (egress-stability + /status comment); no constant.
- `find src/app -name page.tsx` → no probe-echo/probe-status page exists.
