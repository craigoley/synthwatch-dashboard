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
  specs: "/specs",
  reconcile_drift: "/reconcile/drift",
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

// ─── gated seam: ai-insights (editor/admin only) ────────────────────────────────────────────────────
// Unlike the open GETs above, POST /runs/{id}/ai-insights requires an authed call. The bearer comes from
// SYNTHWATCH_API_TOKEN (a real admin token) — NEVER hardcoded/committed. Without it the seam is SKIPPED and
// the committed fixture stands. Use a run that HAS a trace + insights (SYNTHWATCH_AI_RUN_ID, default 844515);
// the body saves as ai_insights_ok.json (or ai_insights_not_configured.json if the API reports configured:false).
const AI_TOKEN = process.env.SYNTHWATCH_API_TOKEN;
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

process.exit(failed ? 1 : 0);
