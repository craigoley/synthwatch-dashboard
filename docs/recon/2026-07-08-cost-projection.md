# Recon — per-monitor projected monthly cost (2026-07-08)

Analysis-only. Branch `analysis/recon-cost-projection` from `origin/main`. Confirms the cost model against
recon **#229** (`synthwatch/docs/recon/2026-07-08-cost-optimization.md`), establishes data availability, and
scopes the build so Craig sees the model before anything renders a dollar figure. **Every number the UI will
show traces to a REAL input** — measured duration, configured interval, region count, a named rate — **no
guessed complexity score**. **OBSERVED** = read from #229 / the schema / infra this pass; **INFERRED** =
reasoned.

## 1. The model — CONFIRMED against #229 + the schema

**#229's proven billing model (OBSERVED, cited):** the 3 runner jobs (one per region) each run
`parallelism: 1, cpu: 1.0, memory: 2Gi` (`synthwatch/infra/main.bicep:475,528,529`; all 3 jobs mirror at
:673-731, :857+). Each tick drains its region's due checks **serially** (`runner/index.ts:198` — `for … await`
per check), so the replica's billed wall-clock per tick ≈ the **sum of the durations** of the checks it ran →
**billed vCPU-seconds ≈ `sum(duration_ms)` across all runs** (#229 "Cost model" section). **Region is a literal
3× multiplier** — a 3-region check runs its full spec in all three jobs. #229 validates the $ against the live
bill (~$65–75/mo compute; the model reproduces it within the quoted range).

**→ Projected monthly cost per monitor (the formula, every input REAL):**

```
projected_monthly_cost
  = avg_duration_s                 (MEASURED — runs.duration_ms over a recent window; complexity IS duration)
  × runs_per_month                 (CONFIGURED — 2_592_000 / interval_seconds ; 30d×86400)
  × region_count                   (CONFIG — assigned check_locations count; the literal 3× multiplier)
  × aca_rate_per_vcpu_s            (NAMED CONSTANT — see §2)
```

`aca_rate_per_vcpu_s` here is the per-second cost of the job's shape = `cpu_rate × cpu(1.0) + mem_rate ×
mem_gib(2)`. With #229's ACA-Consumption US rates (`cpu_rate ≈ $0.000024/vCPU-s`, `mem_rate ≈
$0.000003/GiB-s`): **rate = $0.000024 + 2×$0.000003 = $0.00003 per run-second.** (Sanity: #229's Jul-7 ~74,700
vCPU-s/day → ~2.24M/mo → ~$54 cpu + ~$13 mem ≈ **$67/mo**, inside #229's $65–75.)

**Complexity is MEASURED, never scored:** the only per-monitor variable is `avg_duration_s` from the runs
history. A browser flow costs more because it *measurably runs longer* (#229: browser avg 14,966 ms = 94.6% of
compute), not because of any assigned "complexity" number.

## 2. The rate — a NAMED, LABELED constant (do not silently hardcode a drifting rate)

**Proposal:** a single named constant `ACA_COST` with provenance in one place, surfaced in the UI label:
```
aca:  cpu_per_vcpu_s = 0.000024   // ACA Consumption, US, 2026-07 (Azure bill is ground truth)
      mem_per_gib_s  = 0.000003
      cpu_vcpu       = 1.0         // infra/main.bicep:528
      mem_gib        = 2.0         // infra/main.bicep:529
      => per_run_second = 0.00003
```
- **cpu/mem per job (1.0 vCPU / 2 GiB) is infra-anchored** (`main.bicep:528-529`), so the shape multiplier is
  exact — only the $/unit rates are external and can drift.
- The two $/unit rates are the ONLY estimated inputs; every UI figure must carry the label *"estimate from
  the ACA Consumption rate; the Azure bill is ground truth"* (§HONESTY). Keep the rate a documented constant
  (ideally an env/config the API reads) so ops can update it without a code hunt when Azure repricing lands —
  **not** a magic number buried in a component.

## 3. Estimate (projected) vs Actual (measured) — show BOTH; the divergence is the signal

Because `sum(duration_ms)` history exists, we can show two grounded numbers per monitor:
- **PROJECTED** (forward, from config): the §1 formula — *what it will cost at its configured cadence.*
- **MEASURED** (backward, from history): `sum(duration_ms over last 7d, all regions) × rate × (30/7)` —
  *what it actually cost recently* (already includes real frequency, real region fan-out, retries, and
  failing-run duration).

**Divergence = a real signal (INFERRED from #229):** measured ≫ projected means the monitor is running *more*
or *longer* than its steady-state config implies — retry amplification on a flapping check, or a failing
browser flow burning full `replicaTimeout`. #229 proved retries are ~0.13% of runs today, so a big divergence
flags a *specific* misbehaving monitor. **Recommend showing both, and flagging monitors where measured/projected
diverges > ~1.5×.**

## 4. WHERE the computation lives — API (recommended); the data is there, the dashboard's isn't enough

**Prefer the API** (single source of truth, testable, owns the rate) — and the inputs it needs live in the
**runs table**, which is API-side:

| Input | Source | On the current read DTO? |
|-------|--------|--------------------------|
| `avg_duration_ms` (for projected) | `runs.duration_ms` avg over a window | **NO** — the check DTO exposes `p50Ms`/`p95Ms`, not avg (`CheckDtos.cs:46-48`). p50 is a biased proxy (browser durations are right-skewed → avg > p50), so a p50-based projection under-estimates. |
| `sum(duration_ms)` last 7d (for measured) | `runs.duration_ms` sum | **NO** — not projected anywhere. |
| `interval_seconds` (runs/month) | `checks.interval_seconds` | YES (check DTO). |
| `region_count` | assigned `check_locations` count (config truth; `LocationsFunctions.cs:37`) — the DTO's `locations` rollup is a close proxy (one entry per region that has *run*). | Proxy on DTO; authoritative via `check_locations`. |
| `rate` | named constant (§2) | n/a |

There is **no existing cost field or endpoint** in the API (grep: only incidental "cost" in comments).

**Dashboard-only alternative (rejected as the primary):** the dashboard *could* compute a rough projection
from the existing DTO — `p50Ms × (2.592M/interval_seconds) × locations.length × rate` — with **zero API
change**. But (a) `p50 ≠ avg` biases it low for exactly the expensive browser checks, and (b) there's **no
measured-actual** without the runs sum, so the divergence signal (§3) is impossible. Acceptable only as an
interim "rough" figure, clearly labeled as p50-based.

**→ Recommended contract (API owns it):**
- **Per check:** add `projected_monthly_cost` + `measured_monthly_cost` (nullable — null until enough runs) to
  the check read DTO, **or** a dedicated `GET /reports/cost` that returns per-check `{ check_id, name, kind,
  avg_duration_ms, runs_per_month, region_count, projected_monthly_cost, measured_monthly_cost }` + a fleet
  aggregate `{ total_projected, total_measured, top_drivers: [...] }`. A dedicated report endpoint is cleaner
  (keeps the hot check-list DTO lean; mirrors `/reports/mttr`, `/reports/slo`) and is directly testable
  against the runs table.
- **Rate** as a named constant/config the endpoint reads, echoed in the response (so the UI can show
  provenance) — e.g. `rate: { per_run_second, cpu_vcpu, mem_gib, source }`.

## Build scope (once Craig confirms the model + rate — do NOT build before)

- **API:** `GET /reports/cost?window=7d` → per-check projected + measured + region_count + avg_duration + the
  echoed rate; a fleet aggregate with **top-N drivers** and a `divergence` flag per check. Computed from the
  runs table; contract-anchored. (This is the "single source of truth, testable" piece.)
- **Monitor-detail:** a cost element — the **projected monthly $** + an **inspectable breakdown**
  (`avg_duration × runs/mo × regions × rate`, each a real number) + the **measured** figure beside it.
  Labeled an **ESTIMATE** with the model in a tooltip: *"projected from avg duration × freq × regions at
  $0.00003/run-s; the Azure bill is ground truth."* Recomputes as the monitor's real duration history / config
  changes (it reads live).
- **Overview:** **total projected monthly $** + **top-N cost drivers** (the #229 insight: the value is knowing
  *which* monitors dominate — browser flows — not the bare total). A monitor whose **measured ≫ projected**
  (retry amplification / failing flow) flagged.
- **★ HONESTY:** never render the figure as the invoice. It is a grounded projection; the label says so, and
  the breakdown makes every input inspectable. No "complexity score" anywhere — the only per-monitor variable
  is measured duration.

## Verdict
The #229 model holds and is fully grounded — `cost ≈ Σ(duration_ms) × rate`, region a literal 3×, complexity =
measured duration. Every UI input traces to a real source. **The accurate build (avg + measured-actual +
top-N) requires the API to project the cost from the runs table** — the runs data is there, the current read
DTO isn't. Recommended: land `GET /reports/cost` with the named rate constant (Craig confirms the rate),
then the dashboard renders detail + overview per the scope above. Ready to build on confirmation.

## Appendix — evidence
- Model + $ validation: `synthwatch/docs/recon/2026-07-08-cost-optimization.md` (#229), "Cost model" + query E.
- Job shape: `synthwatch/infra/main.bicep:475` (parallelism 1), `:528` (cpu 1.0), `:529` (memory 2Gi), `:474` (cron */5).
- Serial drain: `synthwatch/runner/index.ts:198`.
- API latency fields (p50/p95, no avg): `synthwatch-api/Dtos/CheckDtos.cs:46-48,128-130`.
- Region assignment (check_locations): `synthwatch-api/Functions/LocationsFunctions.cs:37,107`.
- `interval_seconds`: `synthwatch-dashboard/src/lib/types.ts` `interface Check` (`interval_seconds`).
- No existing cost field/endpoint: grep of `synthwatch-api/**/*.cs` for cost/vCPU/projected → none.
