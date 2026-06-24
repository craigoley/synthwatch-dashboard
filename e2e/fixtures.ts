/**
 * Raw camelCase API fixtures — these mirror the C# API's response shapes EXACTLY,
 * because the page.route intercept serves them BEFORE api-client maps camel→snake.
 * Keys were derived from real /api responses (captured 2026-06-22) so they can't
 * drift into fiction. If the API contract changes, update these + the api-client
 * mapping together.
 */

const NOW = "2026-06-22T18:00:00Z";

export type RawObj = Record<string, unknown>;

/** A /checks list item (the status-grid shape). */
export function listItem(over: RawObj = {}): RawObj {
  return {
    id: 1,
    name: "Check",
    kind: "http",
    targetUrl: "https://example.com/health",
    flowName: null,
    method: "GET",
    expectedStatus: 200,
    intervalSeconds: 300,
    timeoutMs: 30000,
    failureThreshold: 3,
    severity: "critical",
    enabled: true,
    lighthouseEnabled: false,
    lastRunAt: NOW,
    createdAt: NOW,
    currentStatus: "pass",
    currentHealth: "healthy",
    lastRunId: 100,
    lastDurationMs: 250,
    lastHttpStatus: 200,
    hasOpenIncident: false,
    p50Ms: 250,
    p95Ms: 400,
    runs24h: 24,
    spark: [],
    openIncidentCount: 0,
    maxOpenSeverity: null,
    certExpiryWarnDays: null,
    lastCertDaysRemaining: null,
    assertions: [],
    requestHeaders: null,
    requestBody: null,
    auth: null,
    netConfig: null,
    steps: null,
    slo: null,
    locations: [{ location: "default", status: "pass" }],
    tags: [],
    ...over,
  };
}

/** A run (recentRuns / runs history shape). */
export function run(over: RawObj = {}): RawObj {
  return {
    id: 100,
    checkId: 1,
    status: "pass",
    startedAt: NOW,
    finishedAt: NOW,
    durationMs: 250,
    httpStatus: 200,
    errorMessage: null,
    failedStep: null,
    location: "default",
    screenshotUrl: null,
    traceUrl: null,
    certDaysRemaining: null,
    ...over,
  };
}

/** A /checks/{id} detail (list item + detail-only keys + recentRuns). */
export function detail(checkOver: RawObj = {}, recentRuns: RawObj[] = []): RawObj {
  return {
    ...listItem(checkOver),
    bodyMustContain: null,
    lighthouseIntervalSeconds: null,
    lighthouseFormFactor: "desktop",
    perfBudgetLcpMs: null,
    perfBudgetTransferBytes: null,
    recentRuns,
  };
}

/** The login→verify multistep chain (camelCase nested, as the API stores it). */
export function twoStepChain(): RawObj[] {
  return [
    {
      name: "login",
      method: "POST",
      url: "https://api.example.com/login",
      headers: null,
      body: '{"u":"x"}',
      auth: { type: "bearer", token_env: "API_TOKEN_ENV" },
      assertions: [{ source: "status", comparison: "eq", target: null, expected: 200 }],
      extract: [{ var: "token", jsonPath: "$.access_token" }],
    },
    {
      name: "verify",
      method: "GET",
      url: "https://api.example.com/me?t={{token}}",
      headers: { Authorization: "Bearer {{token}}" },
      body: null,
      auth: null,
      assertions: [{ source: "status", comparison: "eq", target: null, expected: 200 }],
      extract: null,
    },
  ];
}

export function runStep(over: RawObj = {}): RawObj {
  return {
    id: 1,
    runId: 701,
    stepIndex: 0,
    name: "step",
    status: "pass",
    durationMs: 100,
    errorMessage: null,
    startedAt: NOW,
    ...over,
  };
}

export function emptySla(window = "24h"): RawObj {
  return { window, items: [], fleet: null };
}

/** One per-check SLA row (raw camelCase). */
export function slaRow(over: RawObj = {}): RawObj {
  return {
    checkId: 1,
    checkName: "Check",
    kind: "http",
    windowFrom: NOW,
    windowTo: NOW,
    completedRuns: 100,
    upRuns: 100,
    downRuns: 0,
    availabilityPct: 100,
    insufficientData: false,
    ...over,
  };
}

export function slaResponse(window: string, items: RawObj[] = [], fleet: RawObj | null = null): RawObj {
  return { window, items, fleet };
}

/** Availability-over-time series: healthy with one dip + a null gap (no-data bucket). */
export function availabilitySeries(window = "24h"): RawObj {
  return {
    window,
    bucket: "hour",
    points: [
      { ts: "2026-06-23T10:00:00Z", availabilityPct: 100, upRuns: 6, downRuns: 0 },
      { ts: "2026-06-23T11:00:00Z", availabilityPct: 100, upRuns: 6, downRuns: 0 },
      { ts: "2026-06-23T12:00:00Z", availabilityPct: 83.33, upRuns: 5, downRuns: 1 }, // dip
      { ts: "2026-06-23T13:00:00Z", availabilityPct: null, upRuns: 0, downRuns: 0 }, // gap (no data)
      { ts: "2026-06-23T14:00:00Z", availabilityPct: 100, upRuns: 6, downRuns: 0 },
      { ts: "2026-06-23T15:00:00Z", availabilityPct: 100, upRuns: 6, downRuns: 0 },
    ],
  };
}

/** /incidents is a RAW ARRAY (api-client splits it into open/resolved). */
export function emptyIncidents(): RawObj[] {
  return [];
}

export function incident(over: RawObj = {}): RawObj {
  return {
    id: 1,
    checkId: 1,
    status: "open",
    severity: "critical",
    openedAt: NOW,
    resolvedAt: null,
    openedRunId: 100,
    resolvedRunId: null,
    consecutiveFailures: 3,
    summary: "Check failing",
    checkName: "Check",
    checkKind: "http",
    rca: null,
    ...over,
  };
}

/** GET /api/incidents/{id} — investigation detail (camelCase per the API contract). */
export function incidentDetail(over: RawObj = {}): RawObj {
  return {
    id: 1,
    checkId: 10,
    checkName: "Global API",
    checkKind: "http",
    status: "resolved",
    severity: "critical",
    openedAt: NOW,
    resolvedAt: NOW,
    durationSeconds: 540,
    consecutiveFailures: 3,
    summary: "503s from westus2",
    rca: null,
    perLocation: [
      { location: "eastus2", status: "pass" },
      { location: "westus2", status: "fail" },
    ],
    timeline: [],
    recurrence: [],
    ...over,
  };
}

export function defaultIncidentDetails(): Record<number, RawObj> {
  return {
    // id 1 — populated rca + a fail→recovery timeline (with screenshot/trace) + recurrence
    1: incidentDetail({
      id: 1,
      rca: {
        classification: "real-outage",
        confidence: "medium",
        observed: ["westus2 returned 503 on 3/3 attempts", "eastus2 returned 200 throughout"],
        inferred: ["likely a regional provider outage in westus2", "not a code regression — other regions healthy"],
        summary: "Failures isolated to westus2; eastus2 healthy.",
      },
      timeline: [
        {
          runId: 1001,
          status: "fail",
          startedAt: "2026-06-22T17:50:00Z",
          durationMs: 45000,
          httpStatus: 503,
          errorMessage: "503 Service Unavailable from westus2",
          failedStep: null,
          screenshotUrl: "/api/runs/1001/screenshot",
          traceUrl: "/api/runs/1001/trace",
          location: "westus2",
        },
        {
          runId: 1002,
          status: "pass",
          startedAt: "2026-06-22T18:00:00Z",
          durationMs: 240,
          httpStatus: 200,
          errorMessage: null,
          failedStep: null,
          screenshotUrl: null,
          traceUrl: null,
          location: "westus2",
        },
      ],
      recurrence: [
        { id: 3, openedAt: "2026-06-20T10:00:00Z", resolvedAt: "2026-06-20T10:30:00Z", status: "resolved", summary: "earlier westus2 blip" },
      ],
    }),
    // id 2 — rca null (graceful: no RCA panel), no recurrence
    2: incidentDetail({
      id: 2,
      checkName: "Legacy check",
      rca: null,
      timeline: [
        {
          runId: 2001,
          status: "fail",
          startedAt: NOW,
          durationMs: 30000,
          httpStatus: null,
          errorMessage: "timeout",
          failedStep: null,
          screenshotUrl: null,
          traceUrl: null,
          location: "default",
        },
      ],
      recurrence: [],
    }),
  };
}

/** One incident WITH a populated rca + one with rca null (graceful-empty case). */
export function defaultIncidents(): RawObj[] {
  return [
    incident({
      id: 1,
      checkId: 10,
      checkName: "Global API",
      summary: "503s from westus2",
      rca: {
        classification: "environment-regional",
        confidence: "high",
        observed: ["westus2 returned 503 on 3/3 attempts", "eastus2 returned 200 throughout"],
        inferred: [
          "likely a regional provider outage in westus2",
          "not a code regression — other regions stayed healthy",
        ],
        summary: "Failures isolated to westus2; eastus2 healthy — regional, not global.",
        signature: "10|503|",
      },
    }),
    incident({ id: 2, checkName: "Legacy check", summary: "timeout", rca: null }),
  ];
}

// ── the default world: one check of every kind + a DISABLED (paused) one ─────

/** Status-grid list covering every kind. id 8 is disabled with currentStatus
 *  "paused" — the regression that crashed runStatusMeta. */
export function defaultChecks(): RawObj[] {
  return [
    listItem({ id: 1, name: "API health", kind: "http", currentStatus: "pass" }),
    listItem({ id: 2, name: "Homepage flow", kind: "browser", flowName: "homepage-load", currentStatus: "pass" }),
    listItem({
      id: 3,
      name: "TLS cert",
      kind: "ssl",
      currentStatus: "warn",
      certExpiryWarnDays: 30,
      lastCertDaysRemaining: 12,
    }),
    listItem({
      id: 4,
      name: "DNS A record",
      kind: "dns",
      targetUrl: "example.com",
      netConfig: { recordType: "A", expectedValue: null, port: null },
      currentStatus: "pass",
    }),
    listItem({
      id: 5,
      name: "TCP port",
      kind: "tcp",
      targetUrl: "example.com",
      netConfig: { recordType: null, expectedValue: null, port: 443 },
      currentStatus: "pass",
    }),
    listItem({
      id: 6,
      name: "Ping host",
      kind: "ping",
      targetUrl: "example.com",
      netConfig: { recordType: null, expectedValue: null, port: null },
      currentStatus: "pass",
    }),
    listItem({ id: 7, name: "Login chain", kind: "multistep", steps: twoStepChain(), currentStatus: "fail" }),
    // ★ regional — some-but-not-all locations failing (amber "regional" indicator).
    listItem({
      id: 11,
      name: "Regional API",
      kind: "http",
      currentStatus: "pass",
      locations: [
        { location: "eastus2", status: "pass" },
        { location: "westus2", status: "fail" },
      ],
    }),
    // ★ degraded — a warn location (no fail/error) must read as "degraded", NOT
    // healthy. currentStatus is "pass" so the indicator can ONLY come from the
    // per-location warn (the #47 bug: warn was dropped from the aggregate).
    listItem({
      id: 14,
      name: "Degraded API",
      kind: "http",
      currentStatus: "pass",
      locations: [
        { location: "eastus2", status: "pass" },
        { location: "westus2", status: "warn" },
      ],
    }),
    // ★ disabled check — the API reports currentStatus "paused" (outside the run
    // taxonomy); this once crashed the grid via runStatusMeta. Lock it down.
    listItem({ id: 8, name: "Paused check", kind: "http", enabled: false, currentStatus: "paused" }),
  ];
}

/** Detail payloads keyed by id, with realistic per-kind runs. */
export function defaultDetails(): Record<number, RawObj> {
  return {
    1: detail({ id: 1, name: "API health", kind: "http" }, [run({ id: 100, status: "pass" })]),
    2: detail({ id: 2, name: "Homepage flow", kind: "browser", flowName: "homepage-load", currentStatus: "fail" }, [
      run({
        id: 200,
        status: "fail",
        failedStep: "click search",
        errorMessage: "timeout waiting for selector",
        screenshotUrl: "/api/runs/200/screenshot",
        traceUrl: "/api/runs/200/trace",
      }),
    ]),
    3: detail({ id: 3, name: "TLS cert", kind: "ssl", certExpiryWarnDays: 30, currentStatus: "warn" }, [
      run({ id: 300, status: "warn", errorMessage: "cert valid, expires 2026-07-04 (12d)", certDaysRemaining: 12 }),
    ]),
    4: detail(
      { id: 4, name: "DNS A record", kind: "dns", targetUrl: "example.com", netConfig: { recordType: "A", expectedValue: null, port: null } },
      [run({ id: 400, status: "pass", errorMessage: "A example.com: 93.184.216.34" })],
    ),
    5: detail(
      { id: 5, name: "TCP port", kind: "tcp", targetUrl: "example.com", netConfig: { recordType: null, expectedValue: null, port: 443 } },
      [run({ id: 500, status: "pass", errorMessage: "connected to example.com:443 in 12ms" })],
    ),
    6: detail(
      { id: 6, name: "Ping host", kind: "ping", targetUrl: "example.com", netConfig: { recordType: null, expectedValue: null, port: null } },
      [run({ id: 600, status: "pass", errorMessage: "example.com reachable (TCP 443 open) in 9ms" })],
    ),
    // multistep with a FAILED run (failed at "verify")
    7: detail({ id: 7, name: "Login chain", kind: "multistep", steps: twoStepChain(), currentStatus: "fail" }, [
      run({
        id: 701,
        checkId: 7,
        status: "fail",
        failedStep: "verify",
        errorMessage: 'assertion failed at step "verify": expected status 200, got 401',
      }),
    ]),
    8: detail({ id: 8, name: "Paused check", kind: "http", enabled: false, currentStatus: "paused" }, []),
    // a check with NO runs yet (graceful-degradation case)
    9: detail({ id: 9, name: "Brand new", kind: "http", currentStatus: null, lastRunId: null }, []),
    // SLO set, healthy budget but a fast burn firing (a fresh spike)
    12: detail(
      {
        id: 12,
        name: "SLO API",
        kind: "http",
        slo: { target: 0.999, budget: 10, consumed: 2, remaining: 8, burnRate: 15, fastBurn: true, slowBurn: false },
      },
      [run({ id: 1200, status: "pass" })],
    ),
    // SLO with an EXHAUSTED budget (remaining < 0 = blown), both burns firing
    13: detail(
      {
        id: 13,
        name: "Blown SLO",
        kind: "http",
        currentStatus: "fail",
        slo: { target: 0.999, budget: 5, consumed: 8, remaining: -3, burnRate: 40, fastBurn: true, slowBurn: true },
      },
      [run({ id: 1300, status: "fail" })],
    ),
    // MULTI-LOCATION: eastus2 healthy, westus2 failing → "regional" (partial) state.
    10: detail({ id: 10, name: "Global API", kind: "http", currentStatus: "fail" }, [
      run({ id: 1001, checkId: 10, status: "pass", location: "eastus2" }),
      run({ id: 1002, checkId: 10, status: "fail", location: "westus2", errorMessage: "503 from westus2" }),
    ]),
    // MULTI-LOCATION DEGRADED: eastus2 healthy, westus2 warn (no fail) → "degraded",
    // NOT "Healthy in all locations" (the #47 bug).
    14: detail({ id: 14, name: "Degraded API", kind: "http", currentStatus: "pass" }, [
      run({ id: 1401, checkId: 14, status: "pass", location: "eastus2" }),
      run({ id: 1402, checkId: 14, status: "warn", location: "westus2", errorMessage: "elevated latency in westus2" }),
    ]),
  };
}

/** run_steps keyed by runId (multistep run 701: login pass, verify fail). */
export function defaultSteps(): Record<number, RawObj[]> {
  return {
    701: [
      runStep({ id: 1, runId: 701, stepIndex: 0, name: "login", status: "pass", durationMs: 120 }),
      runStep({ id: 2, runId: 701, stepIndex: 1, name: "verify", status: "fail", durationMs: 90, errorMessage: "expected status 200, got 401" }),
    ],
  };
}
