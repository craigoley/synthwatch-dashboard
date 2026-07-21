# API contract checks

Guards against a **systemic bug class** that hit 5× (incidents envelope-vs-array, reports
`groupBy=none`, reports source endpoint, incidents-sort `incidentCount` vs `incidentsOpened`, …):

> The e2e mock serves the shape the **client** expects, so mock + client agree and tests pass — but the
> client's expected shape differs from what the API actually **serves**, so it breaks in production.
> Mock and client are two copies of an *assumption*; nothing checked either against reality.

## The mechanism (anchor to the real API, not a hand-written copy)

`seams.contract.ts` runs the **real `api-client` mapper functions** against **captured real API responses**
(`real/*.json`) and asserts the mapped domain object matches the capture's **actual field names**. So if
the client reads a field the API doesn't serve, or assumes a bare array where the API sends an envelope,
the mapped output diverges from the real data and the test **fails**.

There is deliberately **no hand-declared "shared type"** imported by both mock and client — that only keeps
the two copies in sync with *each other* (the trap), not with the API. The anchor is the captured response.

## Why captured fixtures (not OpenAPI codegen)

The C# API exposes **no OpenAPI/Swagger spec** (hand-written DTOs), so generated TS types would mean
building + maintaining a whole spec pipeline in the API first — a large cross-repo lift for a small tool.
Captured-real-response fixtures + contract tests give most of the safety at a fraction of the cost.

## Run

```bash
pnpm contract            # run the checks against the committed captures (deterministic, per-PR)
pnpm capture:contracts   # refresh real/*.json from the live API (run after changing a seam)
```

## Gated seams (ai-insights)

Most seams are open GETs, captured anonymously. `POST /runs/{id}/ai-insights` is **gated (editor/admin)**, so
capturing its real response needs an **authed POST**. `capture.mjs` does this only when a token is provided —
**never hardcoded/committed**:

```bash
SYNTHWATCH_API_TOKEN=<a real admin bearer> SYNTHWATCH_AI_RUN_ID=844515 pnpm capture:contracts
```

Without the token the seam is **skipped** and the committed fixtures stand. The two ai-insights fixtures were
captured **Option B** (no admin token was available in the build environment): derived from the **authoritative
server DTO** (`synthwatch-api Dtos/AiInsightsDto.cs`) — the API's own contract, NOT the dashboard client's
assumption (which is the whole point — anchoring to the wrong side is what caused the bug). Specifically:
- `ai_insights_not_configured.json` — the **exact serialization** of `AiInsightsDto.NotConfigured`.
- `ai_insights_ok.json` — the `AiInsightsDto`/`AiInsightDto` field shape with representative content; replace
  it with a live authed capture (command above) whenever a token is available.

## Known-uncapturable seams (preview / Tests scratchpad)

Not every seam can be anchored by this harness. The **preview** seam (`POST /api/preview`,
`GET /api/preview/{token}`) is **structurally uncapturable** — not merely uncaptured. It is recorded here
because "it has no fixture" reads like a coverage gap, and the obvious response ("just capture it") is
wrong for three independent reasons. Establishing that cost a full investigation cycle; this section exists
so the next one doesn't.

**1. The field in question is not an API field.** The api serves:

```csharp
PreviewStatusDto(Token, Status, string? Trace)   // trace is an OPAQUE STRING
```

`git grep hasScreenshot` across `synthwatch-api` returns **nothing**. `hasScreenshot` (and the rest of the
result body — `tests`, `steps`, `traceSignals`, `stdout`, …) is produced by the **runner**
(`synthwatch runner/sandbox/sandboxMain.ts`) and passed through as JSON-inside-a-string, which the client
`JSON.parse`s. A live capture of this seam would faithfully record `trace: "…"` as a blob and constrain the
fields inside it **not at all** — the anchor would exist and assert nothing, which is worse than no anchor.

**2. Capturing it would mean executing code in production.** `POST /api/preview` is editor/admin-gated, and
it *spawns an ACA sandbox job, writes a `sandbox_preview` audit row, and uploads blobs*. Covering both arms
of the real rule (a **failing** preview keeps its screenshot; a **passing** one has none) needs **two real
prod previews**. `capture.mjs` has only ever done anonymous GETs (the `SEAMS` loop, `:88`–`:90`), one authed
GET (`:122`), and two **read-shaped** POSTs — `/runs/{id}/ai-insights` (`:139`) and `/runs/{id}/baseline-diff`
(`:163`) — which compute over an existing run and write nothing durable. Side-effecting capture is a
category this harness has never had, and preview is the one seam where "capture it live" means running
uploaded code against prod.

**3. ★ Option B does not rescue it.** The escape hatch above — derive the fixture from the authoritative
server DTO — anchors to *the API's own contract*, and that contract says `Trace` is a `string`. A
DTO-derived preview fixture would encode "opaque string" perfectly and still say nothing about
`hasScreenshot`. The authoritative producer here is the **runner**, a different repo this harness has no
concept of. Option B works for ai-insights precisely because the api owns that DTO; it does not own this one.

### What the coverage actually is

Unanchored, **not incorrect**. `e2e/mock.ts` serves `hasScreenshot: (world.previewScreenshot ?? "uploaded") === "uploaded"`,
and `e2e/preview-credentials.spec.ts:65` sets it `false` to model *a failing run that produced no
screenshot* — a legitimate state. `contract/seams.contract.ts` has **no preview entry**, and `contract/real/`
holds **36** captured fixtures, none of them preview. So the preview seam is currently verified by
mock-vs-client agreement only — the exact shape this document opens by warning about. That risk is real and
is being accepted knowingly, not overlooked.

### Where the anchor belongs (PROPOSED — not built)

At the **runner**, next to the producer: a golden fixture of `sandboxMain`'s emitted result, plus a shape
check in this repo against it. That follows the existing cross-repo golden-parity pattern —
`synthwatch runner/test-fixtures/trace-signals-golden/` consumed by
`synthwatch-api tests/SynthWatch.Api.Tests/TraceSignalsGoldenParityTests.cs` — which solves the same problem
(two implementations of one shape, in different repos, drifting). **Nothing of this exists yet.** Until it
does, treat the preview seam as knowingly unanchored, and do not "fix" it by hand-authoring a fixture: a
hand-written fixture is a mock wearing a fixture's name, and reintroduces the bug class this whole directory
exists to prevent.

## Staleness

The captures are point-in-time. A per-PR `pnpm contract` catches **client-side** drift against the
last-known-real shape. To catch **API-side** drift, run `pnpm capture:contracts` on a schedule (or before a
release) and re-run `pnpm contract`: a fresh capture whose shape the client mis-reads fails the tests.
The committed captures double as documentation of the real response shapes.
