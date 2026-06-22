"use client";

import { useState } from "react";

import type {
  Assertion,
  AssertionComparison,
  AssertionSource,
  AuthType,
  Check,
  CheckAuth,
} from "@/lib/types";

// ── editor state (strings for inputs; converted on submit) ───────────────────
export interface AssertionRow {
  source: AssertionSource;
  comparison: AssertionComparison;
  target: string;
  expected: string;
}
export interface HeaderRow {
  key: string;
  value: string;
}
export interface AuthState {
  type: AuthType;
  token_env: string;
  username: string;
  password_env: string;
  header: string;
  value_env: string;
}
export interface HttpConfigState {
  assertions: AssertionRow[];
  headers: HeaderRow[];
  request_body: string;
  auth: AuthState;
}

const SOURCES: { value: AssertionSource; label: string }[] = [
  { value: "status", label: "Status code" },
  { value: "response_time", label: "Response time (ms)" },
  { value: "header", label: "Header" },
  { value: "body", label: "Body" },
  { value: "json_path", label: "JSON path" },
  { value: "size", label: "Size (bytes)" },
];

// Valid comparisons per source (sensible subset).
const COMPARISONS: Record<AssertionSource, AssertionComparison[]> = {
  status: ["eq", "ne", "lt", "gt", "gte", "lte", "one_of"],
  response_time: ["lt", "lte", "gt", "gte"],
  header: ["exists", "eq", "ne", "contains", "not_contains", "matches", "one_of"],
  body: ["contains", "not_contains", "matches", "eq", "ne"],
  json_path: ["exists", "eq", "ne", "lt", "gt", "gte", "lte", "contains", "not_contains", "matches", "one_of"],
  size: ["lt", "lte", "gt", "gte", "eq", "ne"],
};

const COMPARISON_LABEL: Record<AssertionComparison, string> = {
  eq: "= equals",
  ne: "≠ not equals",
  lt: "< less than",
  gt: "> greater than",
  gte: "≥ at least",
  lte: "≤ at most",
  contains: "contains",
  not_contains: "does not contain",
  matches: "matches (regex)",
  exists: "exists",
  one_of: "one of (comma-sep)",
};

const needsTarget = (s: AssertionSource) => s === "header" || s === "json_path";
const needsExpected = (c: AssertionComparison) => c !== "exists";
const targetPlaceholder = (s: AssertionSource) => (s === "header" ? "Header-Name" : "$.data.status");

const AUTH_TYPES: { value: AuthType; label: string }[] = [
  { value: "none", label: "None" },
  { value: "bearer", label: "Bearer token" },
  { value: "basic", label: "Basic" },
  { value: "api_key", label: "API key" },
];

// ── (de)serialization between the API shape and the editor state ─────────────

function expectedToString(expected: unknown, comparison: AssertionComparison): string {
  if (comparison === "exists" || expected === null || expected === undefined) return "";
  if (Array.isArray(expected)) return expected.join(", ");
  if (typeof expected === "object") return JSON.stringify(expected);
  return String(expected);
}

export function emptyHttpConfig(): HttpConfigState {
  return {
    assertions: [],
    headers: [],
    request_body: "",
    auth: { type: "none", token_env: "", username: "", password_env: "", header: "", value_env: "" },
  };
}

/** Build editor state from raw request parts — shared by single checks and chain steps. */
export function httpConfigFromParts(
  assertions: Assertion[] | null | undefined,
  headers: Record<string, string> | null | undefined,
  body: string | null | undefined,
  auth: CheckAuth | null | undefined,
): HttpConfigState {
  return {
    assertions: (assertions ?? []).map((x) => ({
      source: x.source,
      comparison: x.comparison,
      target: x.target ?? "",
      expected: expectedToString(x.expected, x.comparison),
    })),
    headers: Object.entries(headers ?? {}).map(([key, value]) => ({ key, value })),
    request_body: body ?? "",
    auth: {
      type: auth?.type ?? "none",
      token_env: auth?.token_env ?? "",
      username: auth?.username ?? "",
      password_env: auth?.password_env ?? "",
      header: auth?.header ?? "",
      value_env: auth?.value_env ?? "",
    },
  };
}

export function httpConfigFromCheck(check: Check | null | undefined): HttpConfigState {
  if (!check) return emptyHttpConfig();
  return httpConfigFromParts(check.assertions, check.request_headers, check.request_body, check.auth);
}

const looksNumeric = (s: string) => s !== "" && !Number.isNaN(Number(s));
const coerce = (s: string): string | number => (looksNumeric(s) ? Number(s) : s);

function parseExpected(value: string, comparison: AssertionComparison): unknown {
  if (comparison === "one_of") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
      .map(coerce);
  }
  return coerce(value.trim());
}

export interface HttpConfigPayload {
  assertions: Assertion[];
  request_headers: Record<string, string> | null;
  request_body: string | null;
  auth: CheckAuth | null;
}

/** Build the API payload pieces from the editor state. */
export function buildHttpConfigPayload(v: HttpConfigState): HttpConfigPayload {
  const assertions: Assertion[] = v.assertions.map((r) => {
    const a: Assertion = { source: r.source, comparison: r.comparison };
    a.target = needsTarget(r.source) ? r.target.trim() || null : null;
    if (needsExpected(r.comparison)) a.expected = parseExpected(r.expected, r.comparison);
    return a;
  });

  const headerEntries = v.headers.filter((h) => h.key.trim() !== "");
  const request_headers = headerEntries.length
    ? Object.fromEntries(headerEntries.map((h) => [h.key.trim(), h.value]))
    : null;

  const request_body = v.request_body.trim() === "" ? null : v.request_body;

  let auth: CheckAuth | null = null;
  const t = v.auth.type;
  if (t === "bearer") auth = { type: t, token_env: v.auth.token_env.trim() || null };
  else if (t === "basic")
    auth = { type: t, username: v.auth.username.trim() || null, password_env: v.auth.password_env.trim() || null };
  else if (t === "api_key")
    auth = { type: t, header: v.auth.header.trim() || null, value_env: v.auth.value_env.trim() || null };

  return { assertions, request_headers, request_body, auth };
}

// ── component ────────────────────────────────────────────────────────────────

const SELECT_CLS = "sw-select sw-mono text-[13px]";

function fieldError(errors: Record<string, string>, prefix: string): string | null {
  const key = Object.keys(errors).find((k) => k.startsWith(prefix));
  return key ? errors[key] ?? null : null;
}

export function AssertionBuilder({
  value,
  onChange,
  errors,
}: {
  value: HttpConfigState;
  onChange: (v: HttpConfigState) => void;
  errors: Record<string, string>;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const setAssertion = (i: number, patch: Partial<AssertionRow>) => {
    const next = value.assertions.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    onChange({ ...value, assertions: next });
  };
  const changeSource = (i: number, source: AssertionSource) => {
    const valid = COMPARISONS[source];
    const cur = value.assertions[i]?.comparison;
    const comparison = cur && valid.includes(cur) ? cur : (valid[0] as AssertionComparison);
    setAssertion(i, { source, comparison });
  };
  const addAssertion = () =>
    onChange({
      ...value,
      assertions: [...value.assertions, { source: "status", comparison: "eq", target: "", expected: "" }],
    });
  const removeAssertion = (i: number) =>
    onChange({ ...value, assertions: value.assertions.filter((_, idx) => idx !== i) });

  const setHeader = (i: number, patch: Partial<HeaderRow>) =>
    onChange({ ...value, headers: value.headers.map((h, idx) => (idx === i ? { ...h, ...patch } : h)) });
  const addHeader = () => onChange({ ...value, headers: [...value.headers, { key: "", value: "" }] });
  const removeHeader = (i: number) => onChange({ ...value, headers: value.headers.filter((_, idx) => idx !== i) });

  const setAuth = (patch: Partial<AuthState>) => onChange({ ...value, auth: { ...value.auth, ...patch } });

  return (
    <div className="space-y-4">
      {/* ── Assertions ───────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
        <div className="mb-1 flex items-center justify-between">
          <span className="sw-eyebrow">Assertions</span>
          <span className="text-[11px] text-[var(--color-ink-faint)]">
            none = basic status/body match above
          </span>
        </div>

        <div className="space-y-2">
          {value.assertions.map((row, i) => {
            const rowErr = fieldError(errors, `assertions[${i}]`);
            return (
              <div key={i} className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className={SELECT_CLS}
                    value={row.source}
                    onChange={(e) => changeSource(i, e.target.value as AssertionSource)}
                    aria-label="assertion source"
                  >
                    {SOURCES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <select
                    className={SELECT_CLS}
                    value={row.comparison}
                    onChange={(e) => setAssertion(i, { comparison: e.target.value as AssertionComparison })}
                    aria-label="assertion comparison"
                  >
                    {COMPARISONS[row.source].map((c) => (
                      <option key={c} value={c}>
                        {COMPARISON_LABEL[c]}
                      </option>
                    ))}
                  </select>
                  {needsTarget(row.source) && (
                    <input
                      className="sw-input sw-mono flex-1 text-[13px]"
                      style={{ minWidth: 120 }}
                      value={row.target}
                      onChange={(e) => setAssertion(i, { target: e.target.value })}
                      placeholder={targetPlaceholder(row.source)}
                      aria-label="assertion target"
                    />
                  )}
                  {needsExpected(row.comparison) && (
                    <input
                      className="sw-input flex-1 text-[13px]"
                      style={{ minWidth: 100 }}
                      value={row.expected}
                      onChange={(e) => setAssertion(i, { expected: e.target.value })}
                      placeholder={row.comparison === "one_of" ? "200, 201, 204" : "expected"}
                      aria-label="assertion expected"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => removeAssertion(i)}
                    className="sw-btn sw-btn-ghost sw-btn-sm"
                    aria-label="remove assertion"
                  >
                    ✕
                  </button>
                </div>
                {rowErr && (
                  <p className="text-[11px]" style={{ color: "var(--color-fail)" }}>
                    {rowErr}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <button type="button" onClick={addAssertion} className="sw-btn sw-btn-sm mt-3">
          + Add assertion
        </button>
      </div>

      {/* ── Advanced: headers / body / auth ──────────────────────────────── */}
      <button
        type="button"
        onClick={() => setAdvancedOpen((o) => !o)}
        className="sw-btn sw-btn-ghost sw-btn-sm"
      >
        {advancedOpen ? "▾" : "▸"} Advanced — request headers, body & auth
      </button>

      {advancedOpen && (
        <div className="space-y-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          {/* headers */}
          <div>
            <span className="sw-label">Request headers</span>
            {fieldError(errors, "requestHeaders") && (
              <p className="mb-1 text-[11px]" style={{ color: "var(--color-fail)" }}>
                {fieldError(errors, "requestHeaders")}
              </p>
            )}
            <div className="space-y-2">
              {value.headers.map((h, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    className="sw-input sw-mono flex-1 text-[13px]"
                    value={h.key}
                    onChange={(e) => setHeader(i, { key: e.target.value })}
                    placeholder="Header-Name"
                    aria-label="header name"
                  />
                  <input
                    className="sw-input sw-mono flex-1 text-[13px]"
                    value={h.value}
                    onChange={(e) => setHeader(i, { value: e.target.value })}
                    placeholder="value"
                    aria-label="header value"
                  />
                  <button
                    type="button"
                    onClick={() => removeHeader(i)}
                    className="sw-btn sw-btn-ghost sw-btn-sm"
                    aria-label="remove header"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <button type="button" onClick={addHeader} className="sw-btn sw-btn-sm mt-2">
              + Add header
            </button>
          </div>

          {/* body */}
          <label className="block">
            <span className="sw-label">Request body</span>
            <textarea
              className="sw-textarea sw-mono text-[13px]"
              rows={3}
              value={value.request_body}
              onChange={(e) => onChange({ ...value, request_body: e.target.value })}
              placeholder={'{"key":"value"}  — sent for POST/PUT/PATCH'}
            />
            {fieldError(errors, "requestBody") && (
              <p className="mt-1 text-[11px]" style={{ color: "var(--color-fail)" }}>
                {fieldError(errors, "requestBody")}
              </p>
            )}
          </label>

          {/* auth — secret REFERENCES only */}
          <div>
            <span className="sw-label">Auth</span>
            <select
              className={`${SELECT_CLS} w-full`}
              value={value.auth.type}
              onChange={(e) => setAuth({ type: e.target.value as AuthType })}
              aria-label="auth type"
            >
              {AUTH_TYPES.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>

            {value.auth.type !== "none" && (
              <p className="mt-2 text-[11px] text-[var(--color-ink-faint)]">
                Enter the <strong>env var name</strong>, not the secret. The runner reads the value
                from this environment variable at request time; the value is never stored here.
              </p>
            )}

            {value.auth.type === "bearer" && (
              <div className="mt-2">
                <input
                  className="sw-input sw-mono text-[13px]"
                  value={value.auth.token_env}
                  onChange={(e) => setAuth({ token_env: e.target.value })}
                  placeholder="API_TOKEN_ENV"
                  aria-label="bearer token env var name"
                />
                <span className="mt-1 block text-[11px] text-[var(--color-ink-faint)]">Token env var name</span>
                <AuthErr errors={errors} />
              </div>
            )}

            {value.auth.type === "basic" && (
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div>
                  <input
                    className="sw-input sw-mono text-[13px]"
                    value={value.auth.username}
                    onChange={(e) => setAuth({ username: e.target.value })}
                    placeholder="username"
                    aria-label="basic auth username"
                  />
                  <span className="mt-1 block text-[11px] text-[var(--color-ink-faint)]">Username</span>
                </div>
                <div>
                  <input
                    className="sw-input sw-mono text-[13px]"
                    value={value.auth.password_env}
                    onChange={(e) => setAuth({ password_env: e.target.value })}
                    placeholder="BASIC_PASSWORD_ENV"
                    aria-label="basic auth password env var name"
                  />
                  <span className="mt-1 block text-[11px] text-[var(--color-ink-faint)]">Password env var name</span>
                </div>
                <AuthErr errors={errors} />
              </div>
            )}

            {value.auth.type === "api_key" && (
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div>
                  <input
                    className="sw-input sw-mono text-[13px]"
                    value={value.auth.header}
                    onChange={(e) => setAuth({ header: e.target.value })}
                    placeholder="X-API-Key"
                    aria-label="api key header name"
                  />
                  <span className="mt-1 block text-[11px] text-[var(--color-ink-faint)]">Header name</span>
                </div>
                <div>
                  <input
                    className="sw-input sw-mono text-[13px]"
                    value={value.auth.value_env}
                    onChange={(e) => setAuth({ value_env: e.target.value })}
                    placeholder="API_KEY_ENV"
                    aria-label="api key value env var name"
                  />
                  <span className="mt-1 block text-[11px] text-[var(--color-ink-faint)]">Value env var name</span>
                </div>
                <AuthErr errors={errors} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AuthErr({ errors }: { errors: Record<string, string> }) {
  const e = fieldError(errors, "auth");
  if (!e) return null;
  return (
    <p className="text-[11px] sm:col-span-2" style={{ color: "var(--color-fail)" }}>
      {e}
    </p>
  );
}
