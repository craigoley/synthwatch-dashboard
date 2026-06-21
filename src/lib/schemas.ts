import { z } from "zod";

/**
 * Input validation for write endpoints. The runner owns the schema, so the
 * dashboard only writes to the `checks` table (create / edit / pause / delete).
 * Everything else is read-only. Column names mirror the generated db-types.ts.
 */

const kind = z.enum(["http", "browser", "ssl"]);
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
    lighthouse_enabled: z.boolean(),
    lighthouse_interval_seconds: positiveInt.nullable(),
    lighthouse_form_factor: formFactor,
    perf_budget_lcp_ms: positiveInt.nullable(),
    perf_budget_transfer_bytes: nonNegativeInt.nullable(),
    cert_expiry_warn_days: positiveInt.nullable(),
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
