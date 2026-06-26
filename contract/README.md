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

## Staleness

The captures are point-in-time. A per-PR `pnpm contract` catches **client-side** drift against the
last-known-real shape. To catch **API-side** drift, run `pnpm capture:contracts` on a schedule (or before a
release) and re-run `pnpm contract`: a fresh capture whose shape the client mis-reads fails the tests.
The committed captures double as documentation of the real response shapes.
