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

## Staleness

The captures are point-in-time. A per-PR `pnpm contract` catches **client-side** drift against the
last-known-real shape. To catch **API-side** drift, run `pnpm capture:contracts` on a schedule (or before a
release) and re-run `pnpm contract`: a fresh capture whose shape the client mis-reads fails the tests.
The committed captures double as documentation of the real response shapes.
