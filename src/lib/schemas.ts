import { z } from "zod";

/**
 * Input validation for write endpoints. The runner owns the schema, so the
 * dashboard only writes to the `checks` table (create / edit / pause / delete).
 * Everything else is read-only. Column names mirror the generated db-types.ts.
 */

const kind = z.enum(["http", "browser", "ssl", "dns", "tcp", "ping", "multistep"]);

// Network-check config (camelCase nested, mirroring the API's normalized shape).
const netConfigSchema = z.object({
  recordType: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS"]).nullable().optional(),
  expectedValue: z.string().trim().nullable().optional(),
  port: z.coerce.number().int().positive().nullable().optional(),
});
const formFactor = z.enum(["mobile", "desktop"]);
const method = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const severity = z.enum(["warning", "critical"]);

// A trimmed, non-empty string that becomes null when blank — used for optional
// free-text fields so the UI can clear them.
const optionalText = z
  .string()
  .trim()
  .transform((v) => (v.length === 0 ? null : v))
  .nullable();

const requiredUrl = z.string().trim().url("Must be a valid URL");

const positiveInt = z.coerce.number().int().positive();
const nonNegativeInt = z.coerce.number().int().nonnegative();

// HTTP assertion model. Kept permissive client-side — the API is the source of
// truth for cross-field rules (target required for header/json_path, expected
// required except `exists`, …) and returns field-keyed 400s the UI surfaces.
const assertionSchema = z.object({
  source: z.enum(["status", "response_time", "header", "body", "json_path", "size"]),
  comparison: z.enum([
    "eq",
    "ne",
    "lt",
    "gt",
    "gte",
    "lte",
    "contains",
    "not_contains",
    "matches",
    "exists",
    "one_of",
  ]),
  target: z.string().trim().nullable().optional(),
  expected: z.unknown().optional(),
});

// Auth is a secret REFERENCE: *_env fields hold env-var NAMES, never raw secrets.
const authSchema = z.object({
  type: z.enum(["none", "basic", "bearer", "api_key"]),
  token_env: z.string().trim().nullable().optional(),
  username: z.string().trim().nullable().optional(),
  password_env: z.string().trim().nullable().optional(),
  header: z.string().trim().nullable().optional(),
  value_env: z.string().trim().nullable().optional(),
});

// Multistep (kind="multistep") API-chain step. Same request/assertion/auth model
// as a single check + extract rules ([{var, jsonPath}]); url/headers/body may hold
// {{var}} templates. The API validates {{var}} reference integrity (dangling → 400).
const extractRuleSchema = z.object({
  var: z.string().trim(),
  jsonPath: z.string().trim(),
});
const stepSchema = z.object({
  name: z.string().trim(),
  method: method.nullable().optional(),
  url: z.string().trim(),
  headers: z.record(z.string(), z.string()).nullable().optional(),
  body: z.string().nullable().optional(),
  auth: authSchema.nullable().optional(),
  assertions: z.array(assertionSchema).nullable().optional(),
  extract: z.array(extractRuleSchema).nullable().optional(),
});

export const createCheckSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  kind,
  // target_url is NOT NULL in the schema — required for every check.
  target_url: requiredUrl,
  flow_name: optionalText.optional().default(null),
  method: method.default("GET"),
  expected_status: positiveInt.default(200),
  body_must_contain: optionalText.optional().default(null),
  interval_seconds: positiveInt.default(300),
  timeout_ms: positiveInt.default(30_000),
  failure_threshold: positiveInt.default(3),
  severity: severity.default("critical"),
  enabled: z.boolean().default(true),
  lighthouse_enabled: z.boolean().default(false),
  lighthouse_interval_seconds: positiveInt.nullable().optional().default(null),
  // lighthouse_form_factor is NOT NULL (db default 'desktop').
  lighthouse_form_factor: formFactor.default("desktop"),
  perf_budget_lcp_ms: positiveInt.nullable().optional().default(null),
  perf_budget_transfer_bytes: nonNegativeInt.nullable().optional().default(null),
  // SSL checks: warn when the cert has <= this many days remaining.
  cert_expiry_warn_days: positiveInt.nullable().optional().default(null),
  // Network checks (dns/tcp/ping): per-kind config (sent as-is; API validates).
  net_config: netConfigSchema.nullable().optional().default(null),
  // Multistep chains: ordered steps (sent as-is; API validates {{var}} integrity).
  steps: z.array(stepSchema).nullable().optional().default(null),
  // HTTP no-code assertions + request config (sent as-is; API validates).
  assertions: z.array(assertionSchema).optional().default([]),
  request_headers: z.record(z.string(), z.string()).nullable().optional().default(null),
  request_body: z.string().nullable().optional().default(null),
  auth: authSchema.nullable().optional().default(null),
  // Monitors-as-code activation (Phase 13): bind to a manifest spec. Optional (NO default → the key
  // stays absent for a hand-made check, so toCamelBody never sends it). The API validates spec_path's
  // shape + source_key uniqueness (a duplicate → 409).
  source_key: optionalText.optional(),
  spec_path: optionalText.optional(),
});

export type CreateCheckInput = z.infer<typeof createCheckSchema>;

// PATCH: every field optional; only provided keys are updated.
export const updateCheckSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    kind,
    target_url: requiredUrl,
    flow_name: optionalText,
    method,
    expected_status: positiveInt,
    body_must_contain: optionalText,
    interval_seconds: positiveInt,
    timeout_ms: positiveInt,
    failure_threshold: positiveInt,
    severity,
    enabled: z.boolean(),
    // Reversible archive (0071): true → archive (set archived_at); false → unarchive. Sent as `archived`
    // (→ api PATCH { archived }). DISTINCT from `enabled`/pause; `.partial()` makes it optional.
    archived: z.boolean(),
    lighthouse_enabled: z.boolean(),
    lighthouse_interval_seconds: positiveInt.nullable(),
    lighthouse_form_factor: formFactor,
    perf_budget_lcp_ms: positiveInt.nullable(),
    perf_budget_transfer_bytes: nonNegativeInt.nullable(),
    cert_expiry_warn_days: positiveInt.nullable(),
    net_config: netConfigSchema.nullable(),
    steps: z.array(stepSchema).nullable(),
    assertions: z.array(assertionSchema),
    request_headers: z.record(z.string(), z.string()).nullable(),
    request_body: z.string().nullable(),
    auth: authSchema.nullable(),
  })
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: "No fields to update",
  });

export type UpdateCheckInput = z.infer<typeof updateCheckSchema>;

// Pagination for run history.
export const runsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
