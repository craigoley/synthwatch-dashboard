import { z } from "zod";

/**
 * Input validation for write endpoints. The runner owns the schema, so the
 * dashboard only writes to the `checks` table (create / edit / pause / delete).
 * Everything else is read-only.
 */

const kind = z.enum(["http", "browser"]);
const formFactor = z.enum(["mobile", "desktop"]);

// A trimmed, non-empty string that becomes null when blank — used for optional
// free-text/url fields so the UI can clear them.
const optionalText = z
  .string()
  .trim()
  .transform((v) => (v.length === 0 ? null : v))
  .nullable();

const optionalUrl = z
  .string()
  .trim()
  .url("Must be a valid URL")
  .nullable()
  .or(z.literal("").transform(() => null));

const positiveInt = z.coerce.number().int().positive();
const nonNegativeInt = z.coerce.number().int().nonnegative();

export const createCheckSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(200),
    kind,
    target_url: optionalUrl.optional().default(null),
    flow: optionalText.optional().default(null),
    interval_seconds: positiveInt.default(300),
    timeout_ms: positiveInt.default(30_000),
    latency_warn_ms: positiveInt.nullable().optional().default(null),
    enabled: z.boolean().default(true),
    failure_threshold: positiveInt.default(1),
    lighthouse_enabled: z.boolean().default(false),
    lighthouse_interval_seconds: positiveInt.nullable().optional().default(null),
    lighthouse_form_factor: formFactor.nullable().optional().default(null),
    perf_budget_lcp_ms: positiveInt.nullable().optional().default(null),
    perf_budget_transfer_bytes: nonNegativeInt.nullable().optional().default(null),
  })
  .superRefine((data, ctx) => {
    if (data.kind === "http" && !data.target_url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target_url"],
        message: "HTTP checks require a target URL",
      });
    }
  });

export type CreateCheckInput = z.infer<typeof createCheckSchema>;

// PATCH: every field optional; only provided keys are updated.
export const updateCheckSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    kind,
    target_url: optionalUrl,
    flow: optionalText,
    interval_seconds: positiveInt,
    timeout_ms: positiveInt,
    latency_warn_ms: positiveInt.nullable(),
    enabled: z.boolean(),
    failure_threshold: positiveInt,
    lighthouse_enabled: z.boolean(),
    lighthouse_interval_seconds: positiveInt.nullable(),
    lighthouse_form_factor: formFactor.nullable(),
    perf_budget_lcp_ms: positiveInt.nullable(),
    perf_budget_transfer_bytes: nonNegativeInt.nullable(),
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
