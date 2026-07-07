# Recon — mock-vs-prod divergence sweep of unanchored read seams (2026-07-07)

Analysis-only. Branch `analysis/recon-mock-divergence-sweep` from `origin/main` @ `acec32d`. Quantifies the
blast radius; does **not** fix (anchor+fix is a separate gated PR per seam).

**The bug class.** This session, every rich report seam anchored caught a live prod bug with the same root:
the **mapper reads a field at a name/granularity the API doesn't send**, and the **e2e mock serves it at the
mapper's assumed shape**, so e2e is green while prod renders blank/zero/wrong. Two CONFIRMED this session:
`getRegionHealth` (mapper read `r.region`; API sends `location` — a **rename**) and `getEgressReport` (mapper
read region-level `firstSeen`/`runCount`; API sends them **per-IP** — a **granularity** mismatch).

**Method (three-way falsifier).** For each unanchored read seam: (1) what the **MAPPER** reads (field names +
granularity, from `api-client.ts`); (2) what the **API** actually sends (live curl of the endpoint, or a
sibling's captured fixture when auth-gated); (3) what the **MOCK** serves. A divergence between mapper-
assumption and API-truth that the mock hides = a live prod bug. **OBSERVED** = curled/read this pass;
**INFERRED** = reasoned from a sibling/convention.

## Enumeration

40 read seams total; **25 anchored**, **15 unanchored** (`grep` of `contract/*.contract.ts` invocations vs
the exported `get*`/`list*` read fns in `api-client.ts`). The 25 anchored include all the rich report
rollups (`getStatus`, `getSloReport`, `getTrustReport`/`Detail`, `getMttrReport`, `getRegionHealth`,
`getEgressReport`, `getAvailabilityReport`, `getPerformanceReport`, `getDeploys`, `getIncidentBreakdown`,
`getNarrative`) plus the core check/incident/run seams.

### The 15 unanchored read seams

| Seam | Endpoint | Surface | Prod-facing |
|------|----------|---------|-------------|
| `getRouting` | `/routing` | Notifications (routing rules) | ✔ |
| `listChannels` | `/channels` | Notifications (alert channels) | ✔ |
| `getDeliveryReadiness` | `/notifications/health` | Notifications (readiness note) | ✔ |
| `getChannelTestStatus` | `/channels/{id}/test/status` | Notifications (test-send poll) | ✔ (transient) |
| `getReconcilePlan` | `/reconcile/plan` | Reconcile page (dry-run plan) | partial (editor) |
| `getSteps` | `/runs/{id}/steps` | Check detail (multistep chain) | ✔ (dormant) |
| `getLocations` | `/locations` | Monitor editor (location picker) | ✔ |
| `getCheckLocations` | `/checks/{id}/locations` | Monitor editor (assignment) | ✔ |
| `getCheckTags` | `/checks/{id}/tags` | Monitor editor (tags) | ✔ |
| `getTags` | `/tags` | Tag filter (fleet-wide) | ✔ |
| `getSuggestedKeys` | `/tags/suggested` | Tag editor (autocomplete) | ✔ |
| `listIncidents` | (composes `getIncidents`) | Incidents (legacy list) | ✔ (dedup) |
| `authMe` | `/auth/me` | Session identity | internal |
| `listEditors` | `/editors` | Users admin | internal |
| `listAccessRequests` | `/access-requests` | Users admin | internal |

## Findings (three-way, prod-facing first)

### CONFIRMED (new silent-prod bug in the divergence class): **NONE**

No unanchored seam was demonstrated to read a field the live API doesn't send at that shape. The two
CONFIRMED bugs of the class (`getRegionHealth`, `getEgressReport`) are already fixed + anchored (#208/#209).

### CLEAN (mapper field-reads confirmed == live API this pass — OBSERVED)

- **`getDeliveryReadiness` → `/notifications/health`** — live `{channelsConfigured, routingConfigured,
  transportConfigured:null, detail}`; mapper reads exactly those 4. `transportConfigured` null preserved
  (never coerced to false). Match.
- **`getRouting` → `/routing`** — live `{severity:{critical:{channelIds:[1]}, warning:{channelIds:[1]}},
  perCheck:null, tagRules:null}`; mapper reads `severity`/`perCheck`/`tagRules`, and `RoutingRule` is
  `{channelIds:number[]}` — the nested `channelIds` matches. `perCheck:null → {}`, `tagRules:null → []`
  (null-safe). Match (top-level + the one populated nested rule).
- **`getLocations` → `/locations`** — live `{locations:[{name, enabled}]}`; mapper reads `name`/`enabled`. Match.
- **`getCheckLocations` → `/checks/343/locations`** — live `{locations:["centralus","eastus2","westus2"]}`;
  mapper reads `raw.locations ?? []`. Match.
- **`getTags` → `/tags`** — live `{tags:[{key, value, count}]}`; mapper handles the `{tags}` envelope + reads
  key/value/count. Match.
- **`getCheckTags` → `/checks/343/tags`** — live `{tags:[{key, value}]}`; mapper (`asTags`) handles the
  envelope. Match.
- **`getSuggestedKeys` → `/tags/suggested`** — live bare array `["env","service","team","criticality"]`;
  mapper reads `raw ?? []`. Match.
- **`listIncidents`** — composes the **anchored** `getIncidents` (via `mapIncident`); no independent mapping.
  Covered by the incidents anchor.

### SUSPECTED (shapes plausibly match but couldn't confirm live — INFERRED; low blast radius)

- **`listChannels` → `/channels`** — HTTP **401** (auth-gated), couldn't curl. ★ **Structurally the highest-
  risk unanchored seam: it has NO mapper** — `return raw ?? []` casts the raw JSON straight to `Channel[]`.
  But `Channel` is `{id, name, type, config, enabled}` — every top-level field is a **single word**, which
  renders identically in camelCase and snake_case, so it can't casing-diverge. The only unknown is the nested
  `config` (`ChannelConfig`). *Recommend confirming with a tokened capture* (the mechanism `ai-insights` /
  `baseline-diff` already use: `SYNTHWATCH_API_TOKEN`). Prod symptom IF the nested config keys diverge: a
  channel row/edit form with blank recipient/URL fields. INFERRED-low: the CRUD write path round-trips the
  same `config`, so read/write are likely symmetric.
- **`getReconcilePlan` → `/reconcile/plan`** — HTTP **401**. Mapper reads `sourceKey`/`driftType`/`status`/
  `plan`/`computedAt`. The **sibling `/reconcile/drift` (anchored) fixture uses `sourceKey`/`driftType`/
  `detectedAt`** — same C# serializer, same camelCase convention — so the plan reads almost certainly match.
  Lean-CLEAN; confirm via a tokened capture. Reconcile is an editor-gated internal surface.
- **`getSteps` → `/runs/{id}/steps`** — live returns a **bare array** (mapper expects a bare array ✔), but
  **`[]` for every run — there are zero multistep checks in prod right now**, so the step-chain surface is
  **dormant** and the per-step field names (`stepIndex`/`durationMs`/`errorMessage`/`startedAt`, all camelCase
  in `RawStep`) can't be checked against a non-empty real response. Consistent with the API's camelCase
  convention. Re-audit when a multistep monitor exists.
- **`getChannelTestStatus` → `/channels/{id}/test/status`** — needs a live `requestId` from an enqueued
  test-send; not exercised here. Flat `{status, detail, requestedAt, completedAt}`; transient (only during a
  test send). Low.
- **`authMe` / `listEditors` / `listAccessRequests`** — auth-gated **internal admin** surfaces (users page).
  De-prioritized per the task (internal, not prod-facing); flat/single-word shapes, low divergence surface.

## Verdict — blast radius

**Zero new CONFIRMED silent-prod bugs in the unanchored read seams.** The divergence class was concentrated
in the **rich report rollups** — exactly the seams whose multi-word field names (`lastRunAt`, `firstSeen`,
`pctOfTotal`) and per-region/per-IP granularity gave the mapper room to assume the wrong shape. Those are now
all anchored. The unanchored remainder is dominated by **flat config/tag/location seams whose single-word
fields (`id`, `name`, `type`, `status`, `key`, `value`, `count`, `enabled`) cannot casing-diverge**, and
every reachable one was curl-confirmed to match the mapper.

**Structural risk that remains (SUSPECTED, needs a token to close):**
1. `listChannels` — the only seam with **no mapper at all** (raw → `Channel[]`); confirm the nested `config`
   shape via a tokened capture. **Top candidate for the next anchor.**
2. `getReconcilePlan` — auth-gated; lean-CLEAN by the drift sibling's convention, confirm with a token.
3. `getSteps` — dormant (no multistep checks); re-audit when one exists.

**Recommended next action (not done here):** one tokened `capture:contracts` run (`SYNTHWATCH_API_TOKEN`) to
capture `/channels`, `/reconcile/plan`, and a multistep `/runs/{id}/steps`, then anchor those three — closing
the last of the SUSPECTED set. The flat CLEAN seams are low value to anchor (single-word, curl-confirmed) but
harmless to add if a completeness pass is wanted.

## Appendix — commands run (API truth)

Live curls (`BASE=https://synthwatch-api.azurewebsites.net/api`):
- `/notifications/health` → 200 `{channelsConfigured, routingConfigured, transportConfigured:null, detail}`
- `/routing` → 200 `{severity:{critical:{channelIds:[1]},warning:{channelIds:[1]}}, perCheck:null, tagRules:null}`
- `/locations` → 200 `{locations:[{name,enabled}×3]}`
- `/tags` → 200 `{tags:[{key,value,count}×3]}`
- `/tags/suggested` → 200 `["env","service","team","criticality"]`
- `/checks/343/locations` → 200 `{locations:["centralus","eastus2","westus2"]}`
- `/checks/343/tags` → 200 `{tags:[{key:"area",value:"wegmans.com"}]}`
- `/runs/904533/steps` → 200 `[]` (no multistep runs)
- `/reconcile/plan` → **401** · `/channels` → **401** (auth-gated; need `SYNTHWATCH_API_TOKEN`)
- proxy for plan: `contract/real/reconcile_drift.json` item keys `sourceKey/driftType/detail/detectedAt`
