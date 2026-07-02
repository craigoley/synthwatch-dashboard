# synthwatch-dashboard — Claude rules

Rules Claude should follow when working in this repo.

## Lessons from 2026-07-02

- **Honest-render is the product's contract — three states, never two.** Every monitoring panel must distinguish *present* / *honestly-absent* (404 → hide) / *broken* (500/network → loud `ErrorState` or caption). Never render an error or absence as a healthy `0` / empty / green. *(from #175/#177/#179 — `deriveSystemStatus([])` returned "operational" on a swallowed error, a fake-green)*
- **Read-seam mappers use the 404-hide / else-throw shape**, never a bare `catch { return null }`: `catch (err) { if (err instanceof ApiRequestError && err.status === 404) return null; throw err; }`. 404 = feature not deployed → the consumer hides; every other error surfaces via `ErrorState`. *(from #175)*
- **Null is `—`, not `0`; never-green is "never verified", not an error.** A null retry rate renders `—`, a check with no runs renders "never verified" (a first-class state), and distinct incident buckets (perf/unclassified) are never folded into "real outage". Don't fabricate a zero to fill a gap. *(from #166/#170)*
- **A visible debug affordance must not ride the sticky global `SYNTHWATCH_DEBUG` console flag.** Give visible UI its own channel gate (e.g. `isDebugPanelOn`), separate from `isDebugOn` — otherwise the panel leaks on for anyone who ever enabled console debug. *(from #159 leak → #162 fix)*
- **A new runner-owned enum a consumer reads gets one line in `enum-coverage.json`** (table.column → the consuming union). Don't hand-hardcode a parallel union that silently drifts from the runner schema (the `RowStatus` dup). *(from #164/#167)*
- **Use the house `<Combobox>` (sw-panel listbox: keyboard nav, click-away, prefix filter, free-text), never a native `<datalist>`** — datalist renders as an unstyled detached tooltip and can't be styled. Mirror `FlowCombobox`. *(from #182)*
- **Report aggregates are fetch-once, not polled.** No `refreshInterval` on expensive rollups — instead add a "fetched HH:MM" staleness stamp (`useFetchedAt`/`StalenessStamp`) + manual refresh via SWR `mutate` + `revalidateOnFocus`. Don't quietly add a poll to an aggregate. *(from #178)*
- **The session token lives only in localStorage; server routes cannot read it.** For server-side proxying (trace-proxy), the token is mirrored into the same-origin `sw_proxy_session` cookie (`PROXY_COOKIE` in `src/lib/auth.ts`, SameSite=Lax, not httpOnly). Don't fabricate a token server-side — forward the caller's. *(from #174)*
- **Contract tests import route handlers STATICALLY and rely on `NEXT_PUBLIC_API_BASE_URL` set in `playwright.contract.config`.** The `@/` alias resolves in the static import graph; a dynamic `import()` falls back to CJS `require` and fails to resolve the alias. *(from #174)*
- **Never ship a client-side filter over cursor-paginated data** — it filters only the current page and shows false counts. Add the server-side query param (e.g. `?outcome=`) and reset the cursor when the filter changes. *(from #173 finding → #176 fix)*
- **To e2e-test "one seam fails but the page still renders", add a TARGETED per-endpoint failure flag to `e2e/mock.ts`** (`reports500` / `deploys500` / `tagsListError`), not `failAllReads` — a global fail breaks the very render you're asserting stays up. *(from #175/#179/#182)*
