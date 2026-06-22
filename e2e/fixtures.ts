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

export function emptyIncidents(): RawObj {
  return { open: [], resolved: [] };
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
