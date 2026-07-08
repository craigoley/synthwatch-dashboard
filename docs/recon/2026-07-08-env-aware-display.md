# Recon — env-aware display (staging check) (2026-07-08)

Analysis-only. Branch `analysis/recon-env-aware-display` from `origin/main` @ `07c228e`. Grounds how a
`environment='staging'` check (S3, about to be seeded) renders on the dashboard today, and scopes the
env-aware display so a pre-prod check isn't silently mixed into prod-assuming views. **OBSERVED** = read
from code/fixtures on this commit (dashboard) or the local `synthwatch-api` checkout; **INFERRED** =
reasoned from those + #188.

### Verdicts at a glance

| # | Question | Answer |
|---|----------|--------|
| 1 | Read path carries environment? | **NO — api-side read-path gap.** `checks.environment` exists as a COLUMN (drives #188's aggregation exclude) but is **not** on the read DTO. `CheckSummaryDto`/`CheckDetailDto` omit it; the captured `checks.json` has no `environment` key; the dashboard `Check` type + `mapCheck` never see it. The dashboard **cannot display what the API doesn't serialize.** |
| 2 | Where does staging render, is it wrong? | **WRONG in 3 places.** (a) Grid + reports monitor list: shows as an indistinguishable prod check (no env badge). (b) `deriveSystemStatus` fleet banner: counts staging → a staging failure can turn the prod "All Systems Operational" banner red (client-side pollution the API's exclude can't stop). (c) SLO/MTTR/trust panels: API *correctly* excludes staging (#188) → the check is **silently absent**, reading as missing data for a check the grid shows. The env-axis getRegionHealth-class: absence/pollution with no on-screen "why". |
| 3 | Scope + is it blocked? | Minimal env-aware display = env badge + filter on the grid + non-prod excluded from `deriveSystemStatus` + a "N non-prod excluded" note on SLO/trust. **BLOCKED on an API read-path change** (project `checks.environment` onto the read DTO). Riding the `env:` tag is a **trap** — it's a separate, user-mutable signal from the column #188 excludes on, so a tag-keyed badge would diverge from the API's actual exclusion. |

---

## Q1 — Does the read path carry environment? (OBSERVED — it does NOT)

**Dashboard side — environment is nowhere on the read path:**
- The base `Check` interface (`src/lib/types.ts`, `interface Check`) has **no `environment` field**. The
  only `env` hits in `types.ts` are unrelated: auth `*_env` var names (`:96`), the `environment_regional`
  incident-RCA bucket (`:749`), and `group_by` allowing `"env"` as a **tag key** (`:839`).
- `mapCheck` (`src/lib/api-client.ts`) **never reads `raw.environment`** (grep: the `environment` hits are
  the `environmentRegional` incident field `:1873` and prose — none map a check env).
- The captured real list DTO confirms it on the wire — `contract/real/checks.json` check keys include
  `tags`, `sourceKey`, `severity`, … but **no `environment`** (and no env-ish key at all).

**API side — the column exists but is deliberately not projected on reads:**
- #188 (`synthwatch-api` `68c43bc`, *"default-EXCLUDE non-prod checks from slo/mttr/trust — pre-prod-arc
  S1c"*) added `checks.environment` (text NOT NULL + a `checks_environment_vocab` CHECK) and the predicate
  `AND coalesce(c.environment,'prod')='prod'` to **exactly three aggregation queries** — `GetSloReport`,
  `GetMttrReport`, `TrustFleetSql` (commit body + the `Functions/ReportsFunctions.cs` diff).
- The **read** DTO does **not** carry it: `Dtos/CheckDtos.cs` `CheckSummaryDto` has no `Environment` member
  (read in full — Id…RedactionHealth, no env), and no read projection selects `c.environment` (grep of the
  api `*.cs` for `environment` → only `environment-regional` + env-var config, never a check-env projection).
- The column + `migration 0059` + the S3 seed are **in-flight** (the #188 body: *"★ ORDERING: gated on
  synthwatch PR #213 (checks.environment migration 0059) … until a check is set non-prod (S3)"*). So env is
  authoritative on the **write/aggregation** side and **invisible on the read side**.

**→ INFERRED:** the dashboard is structurally blind to a check's environment. This is the api-side gap to
flag: the read path (`CheckSummaryDto` + `CheckDetailDto` + their SQL) must surface `environment` before the
dashboard can render it authoritatively.

## Q2 — Where does a staging check render today, and is it WRONG?

The S3 staging check **is returned by `GET /checks`** — #188 touched only the three aggregations, not the
list query (its diff is `ReportsFunctions.cs` only). So it flows into every dashboard surface that reads the
checks list, with no env signal. Three concrete wrongs:

**(a) Grid + reports monitor list — silently mixed into prod (OBSERVED).**
- Home grid renders a `CheckCard` per check (`src/app/page.tsx:222` over `useChecks()`); the reports Monitors
  tab builds `ReportRow[]` from the **same `useChecks()`** (`src/app/reports/page.tsx:65,88` `checks.map`).
- Neither has any env awareness (grep `environment|staging` over `src/app`+`src/components` → only the
  unrelated `environment_regional` bucket). The staging check renders as an ordinary, unlabeled prod card —
  a director eyeballing the grid can't tell it's pre-prod.

**(b) `deriveSystemStatus` fleet banner — client-side pollution the API's exclude can't stop (OBSERVED).**
`src/lib/status.ts` `deriveSystemStatus(checks)` iterates **all enabled checks** with no env filter:
```
if (openCritical || (down && c.severity === "critical")) return SYSTEM_META.major;
if (openWarning || down || degraded) partial = true;
```
Used by the home page (`page.tsx:70`) and the `/status` banner. So a **staging check going down flips the
prod "All Systems Operational" banner to major/partial** — the display-side version of exactly the pollution
#188 prevents server-side, and one the API cannot fix (it's a dashboard-side rollup over the raw list).

**(c) SLO / MTTR / trust panels — silent absence reads as missing data (INFERRED from #188 + render).**
- `getSloReport`/`getMttrReport`/`getTrustReport` hit the three #188-excluded endpoints → the staging check
  is **not in the returned rows**. The dashboard renders only returned rows, so the check simply **isn't
  there** — no blank cell, no "excluded (non-prod)" note.
- But it **is** in the grid and the reports monitor list (both from `useChecks`). So the same check is
  present in one panel and absent in the next, with no explanation — the env-axis getRegionHealth-class
  ambiguity (is it missing data, or correctly excluded?). A "12 monitors in the grid, 11 in the trust
  scorecard" mismatch is unexplained on-screen.

**Net:** staging is **absent** as a concept (no env field), **wrong-inclusive** where the dashboard rolls up
raw checks (grid card, fleet banner), and **silently exclusive** where it reads the #188 endpoints.

## Q3 — Scope the env-aware display (do NOT build) + is it blocked?

**Minimal env-aware display:**
1. **Env badge on the card/grid** — a small chip (e.g. `staging`) when `environment !== 'prod'`, so a
   pre-prod check is visually distinct. (Reuse the tag-chip styling; `env` already has a first-class hue in
   `tag-chips.tsx`.)
2. **Env filter on the grid** — reuse the existing `TagFilter`/`useTagFilter` machinery so staging is
   filterable (default could hide non-prod, or show-with-badge).
3. **Exclude non-prod from `deriveSystemStatus`** — so a staging failure never turns the prod banner red
   (fixes symptom (b), which is dashboard-only and NOT covered by #188).
4. **Segregate on SLO/trust/MTTR** — the panels already exclude staging (API); add a small honest
   *"N non-prod monitors excluded"* caption so the absence reads as intentional, not missing data (fixes the
   symptom (c) ambiguity). Optionally a non-prod sub-section.

**Is it blocked on an API read-path change? — YES for the authoritative version.**
- Every item above needs the dashboard to KNOW each check's environment. The **authoritative** source is the
  `checks.environment` column (what #188 excludes on). It is **not on the read DTO** → the API must add
  `Environment` to `CheckSummaryDto` (+ `CheckDetailDto`) and select `c.environment` in the read SQL. Until
  then the dashboard is blind. **This is the blocking dependency — the dashboard leg cannot start the badge
  keyed on real environment until the read path exposes it.**

**★ The "env is nearly free via tags" claim is a TRAP (INFERRED).** Environment *could* ride an `env:staging`
**tag** (tags ARE on the read DTO and mapped; `env` is a blessed tag key) — but that is a **separate,
user-mutable signal from the `environment` column the API excludes on**. Keying a badge/filter on the tag
would reproduce the getRegionHealth-class divergence on the env axis: a check with `environment='staging'`
(excluded from prod SLO/trust by the API) but no `env:staging` tag would show a **prod-looking badge on the
dashboard while the API treats it as non-prod** — the display disagreeing with the authority. So tags are the
wrong source of truth here even though they're cheap. (Whether the S3 seed *also* applies an `env:staging`
tag is unknown — the seed isn't in the tree yet; and relying on it would still be the wrong axis.)

**Recommendation:** the env-aware display is **build-ready only after** one small API read-path change —
project `checks.environment` onto `CheckSummaryDto`/`CheckDetailDto` + the read SQL (mirror how `tags`/
`locations` are joined). Then the dashboard work is small and mostly free (badge via existing chip styling;
filter via existing `TagFilter`; a one-line `deriveSystemStatus` env-guard; a caption on SLO/trust). If an
interim tag-based badge is wanted before the read-path lands, it must be labeled as a heuristic and
reconciled to the column once available — with the tag-vs-column divergence called out.

**Blocking dependency (single line for the arc):** dashboard env-aware display ⟸ API surfaces
`checks.environment` on the read DTO (`CheckSummaryDto` + `CheckDetailDto` + read projection). Everything else
is small and dashboard-only.

---

## Appendix — evidence

- Dashboard `Check` type: `src/lib/types.ts interface Check` — no `environment` (fields id…redaction_health).
- `mapCheck`: `src/lib/api-client.ts` — no `raw.environment` read.
- Read DTO on the wire: `contract/real/checks.json` check[0] keys — no `environment`.
- API read DTO: `synthwatch-api Dtos/CheckDtos.cs CheckSummaryDto` — no `Environment` member.
- #188: `synthwatch-api 68c43bc` — added `checks.environment` + `coalesce(c.environment,'prod')='prod'` to
  `GetSloReport`/`GetMttrReport`/`TrustFleetSql` only (diff: `Functions/ReportsFunctions.cs`). Explicitly
  did NOT exclude egress/region-health/narrative/trust-detail. Ordering: gated on runner PR #213 (migration
  0059) + S3 seed.
- Fleet rollup: `src/lib/status.ts deriveSystemStatus` — iterates all enabled checks, no env filter; used at
  `src/app/page.tsx:70`.
- Grid/reports read `useChecks()`: `src/app/page.tsx:222`, `src/app/reports/page.tsx:65,88`.
- No env handling in `src/`: grep `environment|staging|non-prod` over `src/app`+`src/components` → only the
  `environment_regional` incident bucket (`trust.tsx:169`, `rca-panel.tsx:11`).
