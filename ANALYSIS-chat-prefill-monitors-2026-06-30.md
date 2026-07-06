# Chat-to-prefill for non-browser monitors — recon + design (2026-06-30)

**Recon + design only. Build nothing yet.** User types *"set up a ping monitor for meals2go.com"* → an LLM parses intent into the check's structured fields → **prefills the existing create-monitor modal** → the **human reviews + submits**. The LLM never calls `POST /checks` directly.

Recon spanned all three repos (dashboard UI/LLM, runner kinds, API contract/auth), heads: `synthwatch-dashboard@acbc64f`, `synthwatch@4b79913`, `synthwatch-api@9ad4f9f`. Every claim is `file:line`-cited, OBSERVED vs INFERRED.

---

## TL;DR — the two scope-deciding findings

1. **The create-monitor modal already exists and already supports blank-create for every non-browser kind.** So this feature is **prefill-only — no modal to build.** The form (`monitor-form.tsx`) already has a kind selector + per-kind fields + a clean "seed FormState → render" split with an existing prefill mechanism (`formFromActivation`). The chat feature reuses it.
2. **The dashboard makes zero LLM calls today, and the LLM (Azure OpenAI, *not* Anthropic) is authed by managed identity — there is no API key anywhere.** So the browser **cannot** call the model. A small **new backend proxy endpoint** (`POST /api/checks/parse-intent`) is required — and the API already has two endpoints doing exactly "call the LLM on request, return JSON" to mirror, plus the *same validation* `POST /checks` uses, which we can run the LLM output through.

Net: this is a **small, low-risk feature** — one new API proxy endpoint + a prefill seeder + a small input box. The hard parts (modal, LLM auth, field validation) are already solved.

---

## (a) Does a create-monitor modal exist? — YES (the scope decider)

**A blank create-monitor modal exists and supports all non-browser kinds from scratch.** It is *not* limited to the API or the reconcile/activation path.

- `monitors/page.tsx:152` "+ New monitor" → `:282-284` renders `<MonitorForm onDone onCancel />` with **no `initial`/`activation`** = blank create. (OBSERVED)
- `monitor-form.tsx:662-679` — a full **kind selector** (http, browser, ssl, dns, tcp, ping, multistep), shown when not in activation mode.
- `MonitorForm` has 3 modes (`:35-45`): blank create, `initial` (edit), `activation` (browser spec, kind-locked). The **prefill mechanism** is the seeder split: `activation ? formFromActivation(activation) : fromCheck(initial)` (`:364-366`); `fromCheck` (`:107-140`), `formFromActivation` (`:144-154`). http/steps sub-state is seeded separately (`httpConfigFromCheck`/`stepsFromCheck`, `:367-368`).

→ **Chat-prefill plugs into the existing seeder pattern** — a third seeder (a chat-derived partial `Check`) analogous to `formFromActivation`, leaving every field **editable** (unlike activation, which locks spec identity). No modal, no form, no create path to build.

Submit path already exists: `createCheck(input)` → `POST /checks` (`api-client.ts:1719-1726`), payload assembled at `monitor-form.tsx:523-584`. The human clicks "Create" — unchanged.

---

## (b) The REAL non-browser kinds the runner executes

Dispatch at `synthwatch/index.ts:449-454`. **All 7 schema kinds are really implemented** (none schema-only). Non-browser kinds the chat may offer:

| Kind | Executor | What it checks | Key fields |
|---|---|---|---|
| **http** | `runHttpCheck` (`httpCheck.ts:68`) | HTTP request + assertions | `target_url` (http(s) URL), `method`, `expected_status`, `body_must_contain`, `assertions`, `timeout_ms` |
| **ssl** | `runSslCheck` (`sslCheck.ts:48`) | TLS handshake → days-to-cert-expiry | `target_url` (host[:443]), `cert_expiry_warn_days` (default 30), `timeout_ms` |
| **dns** | `runDnsCheck` (`netChecks.ts:85`) | Resolve a record type | `target_url` (host), `net_config.recordType` (A/AAAA/CNAME/MX/TXT/NS, default A), `net_config.expectedValue?`, `timeout_ms` |
| **tcp** | `runTcpCheck` (`netChecks.ts:156`) | TCP connect → **port open** | `target_url` (host[:port]), `net_config.port` (**required**), `timeout_ms` |
| **ping** | `runPingCheck` (`netChecks.ts:177`) | **TCP-reachability (NOT ICMP)** → host responded | `target_url` (host), `net_config.port` (default **443**), `timeout_ms` |
| ~~multistep~~ | `executeMultistep` | Ordered HTTP chain | excluded from chat v1 (interactive `MultistepBuilder`; too complex to parse reliably) |

★ **"ping" needs no remap — it's a native kind.** But it's a **TCP-reachability probe, not ICMP** (`netChecks.ts:7-12`: ACA grants no `CAP_NET_RAW`, so real ICMP `EPERM`s). A connect-success *or* connection-refused → `pass` (host responded); timeout/unreachable → `fail`. Contrast `tcp`, where a refusal → `fail` (it wants the **port** open). **UI/LLM copy must say "reachability (TCP)", never "ICMP ping"** so the verdict semantics aren't misrepresented.

★ **Browser → redirect, never fabricate.** "set up a browser monitor for X" → the feature responds *"browser monitors are authored as code in the monitors repo (then set up from the Catalog)"* — it does not invent a browser check (browser needs a real `flow_name` bound to a Git spec; activation is the correct path).

---

## (c) The check-field schema the LLM must output (per kind)

Source of truth: `CreateCheckRequest` (`synthwatch-api/Dtos/CheckDtos.cs:223-255`) + `CheckValidation.TryBuildNew` (`Infrastructure/CheckValidation.cs:37-132`). Kind allowlist `CheckValidation.Kinds` (`:12`) enforced at `:44`.

**Always:** `name` (required, 1-200), `kind` (required, in allowlist), `target_url` (required; **http(s) URL** for http/ssl, **host/host:port** for dns/tcp/ping — `IsHttpUrl` `:422` vs `IsNetTarget` `:418`). Defaults applied server-side: `method=GET`, `expected_status=200`, `interval_seconds=300`, `timeout_ms=30000`, `failure_threshold=3`, `severity=critical`, `enabled=true`, `cert_expiry_warn_days=30` (`:108-120`).

**Per-kind (what the LLM should emit; everything else omit):**
- **http** — `target_url`; optional `method` (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS), `expected_status` (100-599), `body_must_contain`, `assertions[]`. (No `net_config`/`steps`.)
- **ssl** — `target_url`; optional `cert_expiry_warn_days` (>0).
- **dns** — `target_url` (host); `net_config: { recordType, expectedValue? }`. Must carry `net_config`; must NOT carry `steps`.
- **tcp** — `target_url` (host or host:port); `net_config: { port }` — **port required** (`:368-406`).
- **ping** — `target_url` (host); `net_config: { port? }` (default 443).

**Hard rules the validator enforces (so the LLM can't bypass them):** unknown kind → 400 (`:44`); non-network kind carrying `net_config` → 400 (`:372-375`); network kind with a bad target → 400; `auth` may never contain inline secrets (`*_env` refs only, `:274-286`). **Tags are not part of create** — set separately via `PUT /checks/{id}/tags` (so chat-parsed tags, if any, are a phase-2 nicety, not part of the create payload).

★ **`source_key`/`spec_path` must stay absent** for chat-made checks (they're for Git-authored specs) — the LLM must never emit them.

---

## (d) The LLM-call design

### Key safety — the decisive constraint
The dashboard has **no LLM SDK and no key** (whole-repo grep: zero `anthropic`/`openai`/`claude`; only `NEXT_PUBLIC_API_BASE_URL`). The model is **Azure OpenAI `gpt-5-mini`** (`AoaiClient.cs`), authed by the Function App's **managed identity** (`GetTokenAsync` scope `cognitiveservices...default`, `:58,105`; `Program.cs:30`) — **there is no `AZURE_OPENAI_API_KEY` at all** (`infra/main.bicep:233-252` sets only endpoint/deployment). So:

> ★ The browser **cannot** call the model — there's no key to expose, and the MI token is mintable only inside the Function App. **A backend proxy endpoint is mandatory.** (This is a *positive* finding: the auth is already solved server-side; we reuse it, and **don't introduce Anthropic or any new key/provider** — reuse the existing AOAI client.)

### The new endpoint: `POST /api/checks/parse-intent`
Mirror the two existing on-request LLM endpoints — `LocationDiffFunctions.GetBaselineDiff` (`:36-119`) and `AiInsightsFunctions.GetAiInsights` (`:32-91`). Reuse their conventions verbatim:
- **POST + editor-gated** — POST automatically requires an editor/admin session (`AuthGate` fail-closes on mutating verbs, `AuthGate.cs:67-79`) → only editors can spend tokens / prefill a create. ✓
- **Inert when unconfigured** — `if (!_aoai.IsConfigured) return NotConfigured` (never 500). The chat UI hides if not configured.
- **`IAoaiClient.ChatJsonAsync(system, user, ct)`** — already requests `response_format: json_object` (`AoaiClient.cs:116`); DI already wired (`Program.cs:52`).
- **Honest failure** — reuse `AiInsightsFunctions.MapFailure` (transient vs deterministic).

**System prompt (strict JSON extraction):**
- "Extract a SynthWatch monitor spec from the user's request as JSON ONLY, no prose."
- Enumerate **only the real non-browser kinds** (http/ssl/dns/tcp/ping) + the per-kind field schema from (c). Define ping as "TCP-reachability".
- Output shape: `{ kind, name, target_url, ...per-kind fields, intent_notes, redirect? }`.
- **Browser/multistep request → emit `{ "redirect": "browser" }`** (or `"unsupported"`) instead of a fabricated check.
- Ambiguity (e.g. no host) → emit the fields it *can* + leave the rest null; the human fills them in.

### ★ Validate-don't-trust — reuse the create validator server-side
The LLM output is a **suggestion**, never truth. Before returning, run the parsed object through **`CheckValidation.TryBuildNew`** — the *exact* validator `POST /checks` uses. The endpoint returns:
```
{ fields: <parsed, normalized>, valid: bool, fieldErrors: { <field>: <message> }, redirect?: "browser", notes?: string }
```
This means a hallucinated kind, a bad `target_url`, a `net_config` on an http check, or a nonsense interval are **caught at the same boundary a real create is**, with the field-keyed errors the form *already* surfaces (`monitor-form.tsx:604-606`). The dashboard prefills whatever parsed, shows the per-field errors inline, and **cannot submit until they're fixed** — by the existing form validation + the real `POST /checks` 400s on submit.

### ★ Prefill-not-create + the human gate
- The dashboard `POST /checks/parse-intent` → gets `fields` → opens the **existing create modal prefilled** (new seeder `formFromParse(fields)`, analogous to `formFromActivation`; extend `httpConfigFromCheck`/`stepsFromCheck` only if http assertions are parsed). All fields **editable**, with a "Parsed from your request — review before creating" banner.
- The **human reviews + clicks Create** → the *unchanged* `createCheck` → `POST /checks`. The LLM never persists anything. Same human-gate principle as reconcile-apply.

### Data-flow summary
```
[chat input] --prompt--> POST /api/checks/parse-intent (editor-gated)
                           → AOAI gpt-5-mini (MI auth) → strict JSON
                           → CheckValidation.TryBuildNew (validate-don't-trust)
                           → { fields, valid, fieldErrors, redirect? }
[dashboard] → prefill the EXISTING create modal (editable) → human reviews/edits
            → clicks Create → existing createCheck → POST /checks (validates again)
```

---

## (e) Phased plan

**Phase 0 — this doc (review).**

**Phase 1 — API proxy (`synthwatch-api`).** `POST /api/checks/parse-intent`: inject `IAoaiClient`, `IsConfigured` guard, `ChatJsonAsync` with the strict system prompt (real non-browser kinds only), parse → `CheckValidation.TryBuildNew` → return `{fields, valid, fieldErrors, redirect?}`. Editor-gated by verb. Reuse `MapFailure`. **Test:** Testcontainers/integration — a sample prompt yields a valid http/ssl/ping spec; a browser request → `redirect`; a bad parse → `fieldErrors`. (Mock/stub `IAoaiClient` for determinism, as the AOAI tests do.) *(Note: validated via API CI — no local dotnet.)*

**Phase 2 — dashboard prefill (`synthwatch-dashboard`).** (a) `getParseIntent(prompt)` client fn → the proxy. (b) `formFromParse` seeder + a `prefill` prop on `MonitorForm` (editable, banner). (c) a small **"Describe a monitor…"** input on the monitors page → calls parse-intent → opens the prefilled modal (or shows the browser/multistep redirect message). (d) honest states: not-configured → input hidden; parse error → inline message; `redirect` → the "authored as code" note. **e2e:** mock parse-intent → prefilled modal → human edits → create; browser request → redirect copy; invalid parse → field errors shown.

**Phase 3 — polish (optional).** Clarify-missing-fields (single follow-up question for a missing host), parsed-confidence display, chat-parsed tags (via the separate tags PUT after create), telemetry on accept/edit/discard rates.

---

## (f) Open questions for Craig

1. **Kind scope for v1** — all 5 non-browser (http/ssl/dns/tcp/ping), or start with the 3 highest-value (http "is it up", ssl "cert expiry", ping "reachable") and add dns/tcp later? (multistep excluded either way.)
2. **Where does the chat input live** — a small box on the Monitors page (recommended, next to "+ New monitor"), a dedicated panel, or global? 
3. **Confirm reuse of Azure OpenAI** (`gpt-5-mini`, MI-authed) rather than introducing Anthropic — reuse needs **no new key/provider/cost path** and keeps all LLM work server-side. (The task framing said "Anthropic"; the actual stack is AOAI. Recommend reuse.)
4. **Single-shot parse vs conversational** — recommend single-shot (prompt → prefill) for v1; a back-and-forth that asks for missing fields is Phase 3.
5. **ping copy** — OK to label it **"reachability (TCP)"** (since it's not ICMP)? This matters so operators read `pass`/`fail` correctly.
6. **Prompt logging** — parse-intent will receive free-text; confirm we log no more than the existing AOAI endpoints do (and never the parsed secrets — `auth` is `*_env`-ref-only anyway).

---

### Appendix — provenance
Three parallel read-only recon agents (dashboard create-flow + LLM, runner kind-dispatch, API contract + AOAI auth) on the heads above, 2026-06-30. Nothing built or committed; this is a design to review.
