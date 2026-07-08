#!/usr/bin/env node
/**
 * Refresh the captured real API responses the contract checks verify the client against
 * (contract/real/*.json, consumed by contract/seams.contract.ts).
 *
 * These captures are the GROUND TRUTH — the contract tests run the real api-client mappers against them,
 * so the client can't silently assume a shape the API doesn't serve. Re-run after changing any captured
 * seam (or on a schedule, to catch API-side drift):
 *
 *   pnpm capture:contracts                       # default prod API
 *   SYNTHWATCH_API_BASE=<url> pnpm capture:contracts
 *
 * Then run `pnpm contract`. If a capture's shape changed in a way the client mis-reads, the contract
 * tests fail — surfacing the divergence before it ships.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.SYNTHWATCH_API_BASE ?? "https://synthwatch-api.azurewebsites.net/api";

// The highest-traffic seams — where the shape-mismatch bugs clustered (checks, incidents, sla, reports).
const SEAMS = {
  checks: "/checks",
  incidents_open: "/incidents?status=open",
  incidents_resolved: "/incidents?status=resolved",
  sla_7d: "/sla?window=7d",
  reports_availability_7d: "/reports/availability?window=7d&groupBy=none",
  reports_performance_7d: "/reports/performance?window=7d&groupBy=none",
  // ★ deploy-markers v1 + SLO v1: both were as-built HAND-MOCKS ("companion API PR"), never in this capture,
  // so capture:contracts never validated them against the live API (the frozen-snapshot-vs-real drift class).
  // Both are open GETs (no token). deploys is captured for a host WITH a real row (wegmans sentry-release SHA);
  // window=90d so the marker is in-range. SLO is fleet-wide (may be empty-but-live — the real shape is the point).
  reports_deploys_wegmans: "/reports/deploys?host=www.wegmans.com&window=90d",
  // etag-only host: the honest "deploy detected, no commit id" branch (sha=null, isSha=false) — real data.
  reports_deploys_meals2go: "/reports/deploys?host=www.meals2go.com&window=90d",
  reports_slo_30d: "/reports/slo?window=30d",
  // Rich report seams anchored by mttr/trust/egress .contract.ts (recon Q3 — the remaining high-drift-risk
  // unanchored rollups). Open GETs. trust_detail uses a real check id with monitor data (adjust on re-capture).
  reports_mttr: "/reports/mttr?window=30d",
  reports_trust: "/reports/trust?window=30d",
  reports_trust_detail: "/reports/trust/343?window=30d",
  reports_egress: "/reports/egress?window=all",
  // Region health (api #168, the F-4 pair) — open GET; the region-health panel's seam. Anchored by
  // region-health.contract.ts (the fail-safe-loud off-taxonomy→stale coercion + per-region rollup).
  reports_region_health: "/reports/region-health",
  // Stakeholder /status board — the flagship nested seam (StatusProperty[] + StatusIncident[]); the prior
  // false-green class. Anchored by status.contract.ts. Open GET.
  status: "/status",
  specs: "/specs",
  reconcile_drift: "/reconcile/drift",
  // ★ Previously ORPHANED: flows.json is consumed by high-risk-seams.contract.ts (pins /flows is a BARE ARRAY)
  // but was missing here, so capture:contracts never refreshed it — the frozen-snapshot risk. Open GET, wired in.
  flows: "/flows",
  // Rich/nested seams anchored later (priority by prior-bug + complexity). Use IDs with full data so the
  // fixture exercises the whole shape: narrative factPack (#82), the runs cursor envelope, an SSL check
  // detail (cert + recentRuns with certDaysRemaining). Adjust the IDs to live data when re-capturing.
  narrative_fleet_7d: "/reports/narrative?scope=fleet&window=7d",
  runs_check4: "/checks/4/runs?pageSize=10",
  check_detail_10: "/checks/10",
  // ★ Previously orphaned: these fixtures are consumed by high-risk-seams.contract.ts but were missing here,
  // so capture:contracts never refreshed them — the drift-detection net silently didn't run for the seams
  // with FABRICATED/derived fields (getMetrics derives started_at + hardcodes status; getAvailabilitySeries;
  // getIncident). Wired in so a re-capture covers them. Match the IDs/window the contract tests use.
  metrics_check80: "/checks/80/metrics",
  availability_series_check80: "/checks/80/availability-series?window=7d",
  incident_detail_34: "/incidents/34",
};

const dir = join(dirname(fileURLToPath(import.meta.url)), "real");
mkdirSync(dir, { recursive: true });

let failed = 0;
for (const [name, path] of Object.entries(SEAMS)) {
  try {
    const res = await fetch(BASE + path, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(data, null, 2) + "\n");
    console.log(`captured ${name.padEnd(26)} ${path}`);
  } catch (e) {
    failed += 1;
    console.error(`FAILED   ${name.padEnd(26)} ${path}: ${e.message}`);
  }
}

// ─── gated GET seams: channels + reconcile/plan (session-floor auth — 401 unauthenticated) ───────────
// These read seams require an authed GET (the SEAMS loop above is unauthenticated → they'd 401). The bearer
// comes from SYNTHWATCH_API_TOKEN. Without it the seams are SKIPPED and the committed Option-B fixtures stand
// (channels.json / reconcile_plan.json — derived from the authoritative server DTOs, anchored by
// channels.contract.ts / reconcile-plan.contract.ts). A tokened run REPLACES them with the live shape.
// (getSteps is NOT here: there are zero multistep checks in prod, so /runs/{id}/steps returns [] — its
//  Option-B fixture runs_steps.json must be re-captured against a real multistep run once one exists.)
const AI_TOKEN = process.env.SYNTHWATCH_API_TOKEN;
if (AI_TOKEN) {
  for (const [name, path] of Object.entries({ channels: "/channels", reconcile_plan: "/reconcile/plan" })) {
    try {
      const res = await fetch(BASE + path, { headers: { accept: "application/json", authorization: `Bearer ${AI_TOKEN}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(join(dir, `${name}.json`), JSON.stringify(await res.json(), null, 2) + "\n");
      console.log(`captured ${name.padEnd(26)} ${path} (authed)`);
    } catch (e) {
      failed += 1;
      console.error(`FAILED   ${name.padEnd(26)} ${path}: ${e.message}`);
    }
  }
} else {
  console.log("skipped  channels + reconcile/plan (set SYNTHWATCH_API_TOKEN to replace the Option-B fixtures)");
}

const AI_RUN_ID = process.env.SYNTHWATCH_AI_RUN_ID ?? "844515";
if (AI_TOKEN) {
  try {
    const res = await fetch(`${BASE}/runs/${AI_RUN_ID}/ai-insights`, {
      method: "POST",
      headers: { accept: "application/json", authorization: `Bearer ${AI_TOKEN}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const name = data && data.configured === false ? "ai_insights_not_configured" : "ai_insights_ok";
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(data, null, 2) + "\n");
    console.log(`captured ${name.padEnd(26)} POST /runs/${AI_RUN_ID}/ai-insights`);
  } catch (e) {
    failed += 1;
    console.error(`FAILED   ai-insights POST /runs/${AI_RUN_ID}: ${e.message}`);
  }
} else {
  console.log("skipped  ai-insights            (set SYNTHWATCH_API_TOKEN [+ SYNTHWATCH_AI_RUN_ID] to capture the gated POST)");
}

// ─── gated seam: baseline-diff (editor/admin only) ──────────────────────────────────────────────────
// Like ai-insights, POST /runs/{id}/baseline-diff is authed. Previously the baseline_diff_* fixtures were
// hand-derived from the server DTO (a latent F-01 risk). With a token this captures the live shape; the body
// saves as baseline_diff_ok.json (or baseline_diff_not_configured.json if the API reports configured:false).
const BASELINE_RUN_ID = process.env.SYNTHWATCH_BASELINE_RUN_ID ?? "844834";
if (AI_TOKEN) {
  try {
    const res = await fetch(`${BASE}/runs/${BASELINE_RUN_ID}/baseline-diff`, {
      method: "POST",
      headers: { accept: "application/json", authorization: `Bearer ${AI_TOKEN}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const name = data && data.configured === false ? "baseline_diff_not_configured" : "baseline_diff_ok";
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(data, null, 2) + "\n");
    console.log(`captured ${name.padEnd(26)} POST /runs/${BASELINE_RUN_ID}/baseline-diff`);
  } catch (e) {
    failed += 1;
    console.error(`FAILED   baseline-diff POST /runs/${BASELINE_RUN_ID}: ${e.message}`);
  }
} else {
  console.log("skipped  baseline-diff          (set SYNTHWATCH_API_TOKEN [+ SYNTHWATCH_BASELINE_RUN_ID] to capture the gated POST)");
}

process.exit(failed ? 1 : 0);
