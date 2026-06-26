"use client";

import { useEffect, useMemo, useState } from "react";

import {
  createCheck,
  updateCheck,
  setCheckLocations,
  setCheckTags,
  useFlows,
  useSpecCatalog,
  useLocations,
  useCheckLocations,
  useSuggestedKeys,
  useCheckTags,
} from "@/lib/client";
import { ApiRequestError } from "@/lib/api-client";
import {
  AssertionBuilder,
  buildHttpConfigPayload,
  httpConfigFromCheck,
  type HttpConfigState,
} from "@/components/assertion-builder";
import {
  MultistepBuilder,
  buildStepsPayload,
  stepsFromCheck,
  type StepState,
} from "@/components/multistep-builder";
import { FlowCombobox, type FlowComboOption } from "@/components/flow-combobox";
import type { Check, CheckKind, DnsRecordType, HttpMethod, LighthouseFormFactor, Tag } from "@/lib/types";
import { flowNameFor, type ActivationContext } from "@/lib/specs";
import { minutesToSeconds, secondsToMinutesLabel } from "@/lib/format";

interface Props {
  initial?: Check | null;
  /**
   * Spec-activation mode (Phase 13): prefill from a manifest spec and LOCK its identity (kind=browser,
   * spec_path, source_key, synthetic flow_name). Mutually exclusive with `initial` (edit). When set, the
   * submit carries spec_path + source_key so the runner runs the Git spec (Option C) next tick.
   */
  activation?: ActivationContext | null;
  onDone: () => void;
  onCancel: () => void;
}

type SeverityOpt = "warning" | "critical";

interface FormState {
  name: string;
  kind: CheckKind;
  target_url: string;
  flow_name: string;
  /** Spec binding when a Git-manifest spec is selected (browser, Option C). null = a plain/typed flow. */
  spec_path: string | null;
  source_key: string | null;
  method: HttpMethod;
  expected_status: string;
  body_must_contain: string;
  // UI speaks MINUTES; converted to the API's interval_seconds on submit (see format.ts).
  interval_minutes: string;
  timeout_ms: string;
  failure_threshold: string;
  severity: SeverityOpt;
  enabled: boolean;
  lighthouse_enabled: boolean;
  lighthouse_interval_seconds: string;
  lighthouse_form_factor: LighthouseFormFactor;
  perf_budget_lcp_ms: string;
  perf_budget_transfer_bytes: string;
  cert_expiry_warn_days: string;
  dns_record_type: DnsRecordType;
  dns_expected_value: string;
  tcp_port: string;
  ping_port: string;
  /** Run-location assignment (seeded from /api/locations once it loads). */
  locations: string[];
  /** key:value tags (seeded from /api/checks/{id}/tags once it loads). */
  tags: Tag[];
}

function asRecordType(r: string | null | undefined): DnsRecordType {
  const allowed: DnsRecordType[] = ["A", "AAAA", "CNAME", "MX", "TXT", "NS"];
  return allowed.includes(r as DnsRecordType) ? (r as DnsRecordType) : "A";
}

function numOrNull(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function asMethod(m: string | undefined): HttpMethod {
  const allowed: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
  return allowed.includes(m as HttpMethod) ? (m as HttpMethod) : "GET";
}

function asFormFactor(f: string | undefined): LighthouseFormFactor {
  return f === "mobile" ? "mobile" : "desktop";
}

function asSeverity(s: string | undefined): SeverityOpt {
  return s === "warning" ? "warning" : "critical";
}

function fromCheck(c: Check | null | undefined): FormState {
  return {
    name: c?.name ?? "",
    kind: c?.kind ?? "http",
    target_url: c?.target_url ?? "",
    flow_name: c?.flow_name ?? "",
    spec_path: c?.spec_path ?? null,
    source_key: c?.source_key ?? null,
    method: asMethod(c?.method),
    expected_status: String(c?.expected_status ?? 200),
    body_must_contain: c?.body_must_contain ?? "",
    interval_minutes: secondsToMinutesLabel(c?.interval_seconds ?? 300), // stored seconds → minutes
    timeout_ms: String(c?.timeout_ms ?? 30000),
    failure_threshold: String(c?.failure_threshold ?? 3),
    severity: asSeverity(c?.severity),
    enabled: c?.enabled ?? true,
    lighthouse_enabled: c?.lighthouse_enabled ?? false,
    lighthouse_interval_seconds:
      c?.lighthouse_interval_seconds != null ? String(c.lighthouse_interval_seconds) : "",
    lighthouse_form_factor: asFormFactor(c?.lighthouse_form_factor),
    perf_budget_lcp_ms: c?.perf_budget_lcp_ms != null ? String(c.perf_budget_lcp_ms) : "",
    perf_budget_transfer_bytes:
      c?.perf_budget_transfer_bytes != null ? String(c.perf_budget_transfer_bytes) : "",
    cert_expiry_warn_days: c?.cert_expiry_warn_days != null ? String(c.cert_expiry_warn_days) : "30",
    dns_record_type: asRecordType(c?.net_config?.recordType),
    dns_expected_value: c?.net_config?.expectedValue ?? "",
    tcp_port: c?.kind === "tcp" && c.net_config?.port != null ? String(c.net_config.port) : "",
    ping_port: c?.kind === "ping" && c.net_config?.port != null ? String(c.net_config.port) : "",
    // Seeded asynchronously once /api/locations (and, on edit, the current
    // assignment) load — see the seeding effect in MonitorForm.
    locations: [],
    tags: [],
  };
}

/** Seed the form from an activation prefill: browser kind + synthetic flow_name locked, identity
    (name/target/interval/tags) prefilled and editable. target may be "" — the form then asks for it. */
function formFromActivation(a: ActivationContext): FormState {
  return {
    ...fromCheck(null),
    name: a.name,
    kind: "browser",
    target_url: a.target ?? "",
    flow_name: a.flowName,
    interval_minutes: secondsToMinutesLabel(a.intervalSeconds), // spec's suggested seconds → minutes
    tags: a.tags,
  };
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
            value === o.value
              ? "bg-[var(--color-panel-2)] text-[var(--color-ink)]"
              : "text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2.5 text-sm"
    >
      <span
        className="relative h-5 w-9 rounded-full transition"
        style={{ background: checked ? "var(--color-brand)" : "var(--color-border-strong)" }}
      >
        <span
          className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all"
          style={{ left: checked ? "18px" : "2px" }}
        />
      </span>
      <span className="text-[var(--color-ink-dim)]">{label}</span>
    </button>
  );
}

/** key:value tag editor: existing tags as removable chips + a key/value add row.
    Suggested keys (env/service/team/criticality) offered via a datalist, but any
    key is allowed. One value per key — re-adding a key replaces its value. */
function TagEditor({
  tags,
  suggestedKeys,
  onAdd,
  onRemove,
}: {
  tags: Tag[];
  suggestedKeys: string[];
  onAdd: (key: string, value: string) => void;
  onRemove: (key: string) => void;
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const add = () => {
    if (!key.trim() || !value.trim()) return;
    onAdd(key, value);
    setKey("");
    setValue("");
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      add();
    }
  };
  return (
    <div className="w-full">
      <span className="sw-label">Tags</span>
      {tags.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5" data-testid="tag-editor-chips">
          {tags.map((t) => (
            <span
              key={t.key}
              className="sw-mono inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-[11px]"
            >
              <span className="text-[var(--color-ink-faint)]">{t.key}:</span>
              <span className="text-[var(--color-ink)]">{t.value}</span>
              <button
                type="button"
                onClick={() => onRemove(t.key)}
                aria-label={`remove tag ${t.key}`}
                className="text-[var(--color-ink-faint)] transition hover:text-[var(--color-fail)]"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="sw-input sw-mono w-32 text-[13px]"
          list="sw-tag-keys"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="key"
          aria-label="tag key"
        />
        <datalist id="sw-tag-keys">
          {suggestedKeys.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
        <span className="text-[var(--color-ink-faint)]">:</span>
        <input
          className="sw-input sw-mono w-40 text-[13px]"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="value"
          aria-label="tag value"
        />
        <button
          type="button"
          onClick={add}
          disabled={!key.trim() || !value.trim()}
          className="sw-btn sw-btn-sm"
        >
          + Add tag
        </button>
      </div>
      <span className="mt-1 block text-[11px] text-[var(--color-ink-faint)]">
        Lowercased on save. Suggested keys: env, service, team, criticality — or use your own.
      </span>
    </div>
  );
}

/** Multi-select of run locations — same chip styling as Segmented, but toggles
    multiple. Wraps full-width on mobile (like the Type row). */
function LocationSelect({
  options,
  selected,
  onToggle,
}: {
  options: string[];
  selected: string[];
  onToggle: (name: string) => void;
}) {
  return (
    <div className="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] p-0.5">
      {options.map((name) => {
        const on = selected.includes(name);
        return (
          <button
            key={name}
            type="button"
            role="checkbox"
            aria-checked={on}
            aria-label={name}
            onClick={() => onToggle(name)}
            className={`sw-mono rounded-md px-3 py-1.5 text-xs font-medium transition ${
              on
                ? "bg-[var(--color-panel-2)] text-[var(--color-ink)]"
                : "text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
            }`}
          >
            {on ? "✓ " : ""}
            {name}
          </button>
        );
      })}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="sw-label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-[var(--color-ink-faint)]">{hint}</span>}
    </label>
  );
}

export function MonitorForm({ initial, activation, onDone, onCancel }: Props) {
  const isActivation = Boolean(activation);
  const [form, setForm] = useState<FormState>(() =>
    activation ? formFromActivation(activation) : fromCheck(initial),
  );
  const [http, setHttp] = useState<HttpConfigState>(() => httpConfigFromCheck(initial));
  const [steps, setSteps] = useState<StepState[]>(() => stepsFromCheck(initial));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: flows } = useFlows();
  const { data: specCatalog } = useSpecCatalog();

  // The flow selector lists the SAME specs the catalog knows (the Git manifest via spec_catalog) so a
  // spec defined in Git but never run — e.g. recipe-nav — is selectable immediately, plus any
  // runner-baked flows. Monitored specs are omitted: one check per source_key (unique index), so a
  // second would 409 — mirrors the catalog only offering Unmonitored rows for setup.
  const flowOptions = useMemo<FlowComboOption[]>(() => {
    const specOpts: FlowComboOption[] = (specCatalog?.items ?? [])
      .filter((s) => !s.monitored)
      .map((s) => ({
        value: flowNameFor(s.spec_path),
        description: s.description,
        kind: "spec",
        entryUrl: s.target,
        specPath: s.spec_path,
        sourceKey: s.source_key,
        secondary: s.name,
      }));
    const specValues = new Set(specOpts.map((o) => o.value));
    const flowOpts: FlowComboOption[] = (flows ?? [])
      .filter((f) => !specValues.has(f.name)) // a spec of the same name wins (it's spec-backed)
      .map((f) => ({ value: f.name, description: f.description, kind: "flow", entryUrl: f.entry_url_hint }));
    return [...specOpts, ...flowOpts];
  }, [specCatalog, flows]);

  const isEdit = Boolean(initial);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  // ─── locations (run-location assignment) ───────────────────────────────────
  const { data: locationOptions } = useLocations();
  const { data: currentLocations } = useCheckLocations(isEdit && initial ? initial.id : null);
  const [locationsSeeded, setLocationsSeeded] = useState(false);
  const enabledLocations = (locationOptions ?? []).filter((l) => l.enabled).map((l) => l.name);

  // Seed the selection ONCE the options (and, on edit, the assignment) load:
  // a NEW check defaults to ALL enabled (matches the backend default); an edit
  // shows its current assignment (intersected with still-enabled locations).
  useEffect(() => {
    if (locationsSeeded || !locationOptions) return;
    const enabled = locationOptions.filter((l) => l.enabled).map((l) => l.name);
    if (isEdit) {
      if (currentLocations === undefined) return; // wait for the assignment too
      setForm((f) => ({ ...f, locations: currentLocations.filter((n) => enabled.includes(n)) }));
    } else {
      setForm((f) => ({ ...f, locations: enabled }));
    }
    setLocationsSeeded(true);
  }, [locationOptions, currentLocations, isEdit, locationsSeeded]);

  // Only enforce / render the selector once it's seeded AND there are options —
  // so before the parallel API PR serves /api/locations (404 → never seeded), the
  // field stays hidden and save is never blocked (the backend defaults to all).
  const locationsActive = locationsSeeded && enabledLocations.length > 0;
  const toggleLocation = (name: string) =>
    setForm((f) => ({
      ...f,
      locations: f.locations.includes(name)
        ? f.locations.filter((n) => n !== name)
        : [...f.locations, name],
    }));

  // ─── tags (Phase 9a) ───────────────────────────────────────────────────────
  const { data: suggestedKeys } = useSuggestedKeys();
  const { data: currentTags } = useCheckTags(isEdit && initial ? initial.id : null);
  const [tagsSeeded, setTagsSeeded] = useState(false);

  // Seed once the suggested-keys endpoint responds (and, on edit, the current tags).
  useEffect(() => {
    if (tagsSeeded || suggestedKeys === undefined) return;
    if (isEdit) {
      if (currentTags === undefined) return; // wait for the check's tags too
      setForm((f) => ({ ...f, tags: currentTags }));
    }
    setTagsSeeded(true);
  }, [suggestedKeys, currentTags, isEdit, tagsSeeded]);

  // Editor only renders once the tag API has responded (pre-API 404 → suggestedKeys
  // stays undefined → never seeded → editor hidden, save skips the tag PUT).
  const tagsActive = tagsSeeded;

  const [tagError, setTagError] = useState<string | null>(null);

  // Persist a tag change. On EDIT the check already exists, so save IMMEDIATELY (a dedicated PUT — no
  // modal submit needed; "add chip = saved"). On CREATE there's no id yet, so just stage into form.tags;
  // the create submit persists them. (Fixes the silent UX trap: a staged-but-unsubmitted edit was lost.)
  const persistTags = (next: Tag[]) => {
    setForm((f) => ({ ...f, tags: next }));
    if (isEdit && initial) {
      setTagError(null);
      void setCheckTags(initial.id, next).catch(() => setTagError("Couldn't save tags — check your connection and retry."));
    }
  };
  // Add/replace a tag — normalized lowercase; one value per key (replace on collision).
  const addTag = (key: string, value: string) => {
    const k = key.trim().toLowerCase();
    const v = value.trim().toLowerCase();
    if (!k || !v) return;
    persistTags([...form.tags.filter((t) => t.key !== k), { key: k, value: v }]);
  };
  const removeTag = (key: string) => persistTags(form.tags.filter((t) => t.key !== key));

  // Free-typed flow name: a genuinely-new flow → clear any spec binding (it's not a manifest spec).
  const onFlowText = (text: string) =>
    setForm((f) => ({ ...f, flow_name: text, spec_path: null, source_key: null }));

  // Picking an option. A spec option locks its spec_path + source_key (the Phase 13 activation
  // contract) so the runner fetches+runs the Git spec; a baked flow clears the binding. Either way,
  // suggest the entry/target URL without overwriting one the author already typed.
  const onFlowSelect = (opt: FlowComboOption) =>
    setForm((f) => ({
      ...f,
      flow_name: opt.value,
      spec_path: opt.specPath ?? null,
      source_key: opt.sourceKey ?? null,
      target_url: opt.entryUrl && f.target_url.trim() === "" ? opt.entryUrl : f.target_url,
    }));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});

    if (form.name.trim() === "") {
      setError("Name is required.");
      return;
    }
    // Multistep has no single target (derived from step 1's URL); guard the chain
    // is non-empty instead. Every other kind requires target_url (NOT NULL column).
    if (form.kind === "multistep") {
      if (steps.length === 0) {
        setError("Add at least one step to the chain.");
        return;
      }
      if (steps[0]!.url.trim() === "") {
        setError("The first step needs a URL.");
        return;
      }
    } else if (form.target_url.trim() === "") {
      setError("A target URL is required.");
      return;
    }
    // Mirror the API's ≥1-location rule — never PUT an empty set it would 400 on.
    if (locationsActive && form.locations.length === 0) {
      setError("Select at least one location for this check to run from.");
      return;
    }

    const stepsPayload = form.kind === "multistep" ? buildStepsPayload(steps) : null;

    const payload = {
      name: form.name.trim(),
      kind: form.kind,
      // Multistep has no single target — the chain's entry is step 1's URL. The
      // column is NOT NULL, so derive it (the field is hidden for this kind).
      target_url:
        form.kind === "multistep"
          ? stepsPayload?.[0]?.url || "https://multistep.local"
          : form.target_url.trim(),
      flow_name: form.kind === "browser" ? form.flow_name.trim() || null : null,
      method: form.method,
      expected_status: numOrNull(form.expected_status) ?? 200,
      body_must_contain: form.kind === "http" ? form.body_must_contain.trim() || null : null,
      // minutes → seconds at the API boundary (5 min → 300s). Default 5 min when blank.
      interval_seconds: minutesToSeconds(numOrNull(form.interval_minutes) ?? 5),
      timeout_ms: numOrNull(form.timeout_ms) ?? 30000,
      failure_threshold: numOrNull(form.failure_threshold) ?? 3,
      severity: form.severity,
      enabled: form.enabled,
      // Lighthouse + perf budgets are browser-only; force off for http/ssl.
      lighthouse_enabled: form.kind === "browser" ? form.lighthouse_enabled : false,
      lighthouse_interval_seconds:
        form.kind === "browser" && form.lighthouse_enabled
          ? numOrNull(form.lighthouse_interval_seconds)
          : null,
      lighthouse_form_factor: form.lighthouse_form_factor,
      perf_budget_lcp_ms: form.kind === "browser" ? numOrNull(form.perf_budget_lcp_ms) : null,
      perf_budget_transfer_bytes:
        form.kind === "browser" ? numOrNull(form.perf_budget_transfer_bytes) : null,
      // SSL-only: warn window in days.
      cert_expiry_warn_days: form.kind === "ssl" ? numOrNull(form.cert_expiry_warn_days) ?? 30 : null,
      // Network-only (dns/tcp/ping): per-kind config (camelCase nested, as the API expects).
      net_config:
        form.kind === "dns"
          ? { recordType: form.dns_record_type, expectedValue: form.dns_expected_value.trim() || null, port: null }
          : form.kind === "tcp"
            ? { recordType: null, expectedValue: null, port: numOrNull(form.tcp_port) }
            : form.kind === "ping"
              ? { recordType: null, expectedValue: null, port: numOrNull(form.ping_port) }
              : null,
      // Multistep-only: the ordered step chain. Cleared for other kinds.
      steps: stepsPayload,
      // HTTP-only: no-code assertions + request config. Cleared for other kinds.
      ...(form.kind === "http"
        ? buildHttpConfigPayload(http)
        : { assertions: [], request_headers: null, request_body: null, auth: null }),
      // Spec binding. spec_path makes the runner fetch+run the Git spec (Option C); source_key links
      // the catalog row (a duplicate → 409). flow_name above is the synthetic flowNameFor(spec_path)
      // that satisfies browser_needs_flow. Two entry points converge on the SAME shape: catalog
      // activation, and a free-form New-monitor that selected a manifest spec (create only — edit
      // leaves the binding untouched, as PATCH omits unspecified fields).
      ...(activation
        ? { source_key: activation.sourceKey, spec_path: activation.specPath }
        : !isEdit && form.kind === "browser" && form.spec_path
          ? { source_key: form.source_key, spec_path: form.spec_path }
          : {}),
    };

    setSubmitting(true);
    try {
      const saved =
        isEdit && initial ? await updateCheck(initial.id, payload) : await createCheck(payload);
      // The location assignment is a separate endpoint (PUT /checks/{id}/locations).
      // Skipped when the feature isn't live yet — the backend defaults to all.
      if (locationsActive) {
        await setCheckLocations(saved.id, form.locations);
      }
      // Tags are likewise a separate endpoint (PUT /checks/{id}/tags); skipped pre-API.
      if (tagsActive) {
        await setCheckTags(saved.id, form.tags);
      }
      onDone();
    } catch (err) {
      if (err instanceof ApiRequestError) {
        // Duplicate source_key (the partial unique index) → the API returns 409. A monitor for this
        // spec already exists; say so plainly rather than echoing the raw conflict message.
        if (err.status === 409) {
          setError("A monitor for this spec already exists.");
        } else {
          // The API returns field-keyed validation messages (e.g.
          // "assertions[0].comparison"); surface them inline on the right row.
          if (err.details && typeof err.details === "object" && !Array.isArray(err.details)) {
            setFieldErrors(err.details as Record<string, string>);
          }
          setError(err.message);
        }
      } else {
        setError("Failed to save monitor. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {error && (
        <div
          className="rounded-lg px-3 py-2 text-sm"
          style={{
            background: "color-mix(in srgb, var(--color-fail) 12%, transparent)",
            border: "1px solid color-mix(in srgb, var(--color-fail) 40%, transparent)",
            color: "var(--color-fail)",
          }}
        >
          {error}
        </div>
      )}

      {/* Activation: the spec identity is LOCKED (browser kind + spec_path + source_key + synthetic
          flow_name). Shown read-only so it's clear what runs; the name above stays editable. */}
      {isActivation && activation && (
        <div
          data-testid="activation-banner"
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3"
        >
          <div className="sw-eyebrow mb-1">Activating spec — Browser</div>
          <div className="sw-mono truncate text-[12px] text-[var(--color-ink)]">{activation.specPath}</div>
          <div className="sw-mono mt-1 text-[11px] text-[var(--color-ink-faint)]">
            id {activation.sourceKey} · flow {activation.flowName} (synthetic) · fetched from Git each run
          </div>
        </div>
      )}

      <Field label="Name">
        <input
          className="sw-input"
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="Checkout flow — production"
          autoFocus
        />
      </Field>

      <div className="flex flex-wrap items-center gap-6">
        {/* Label reads "Type" to the user; the field still binds to `kind` (the DB
            column / API key / runner all stay `kind` — display string only). The
            block is full-width on mobile so the 7 options wrap inside the modal.
            Hidden in activation mode — the spec locks kind to 'browser'. */}
        {!isActivation && (
          <div className="w-full sm:w-auto">
            <span className="sw-label">Type</span>
            <Segmented
              value={form.kind}
              onChange={(v) => set("kind", v)}
              options={[
                { value: "http", label: "HTTP" },
                { value: "browser", label: "Browser" },
                { value: "ssl", label: "SSL" },
                { value: "dns", label: "DNS" },
                { value: "tcp", label: "TCP" },
                { value: "ping", label: "Ping" },
                { value: "multistep", label: "Multistep" },
              ]}
            />
          </div>
        )}
        <div>
          <span className="sw-label">Severity</span>
          <Segmented
            value={form.severity}
            onChange={(v) => set("severity", v)}
            options={[
              { value: "warning", label: "Warning" },
              { value: "critical", label: "Critical" },
            ]}
          />
        </div>
        <div className="pt-5">
          <Toggle
            checked={form.enabled}
            onChange={(v) => set("enabled", v)}
            label={form.enabled ? "Enabled" : "Paused"}
          />
        </div>
      </div>

      {/* Run-location assignment — full-width so the chips wrap on mobile like Type.
          Hidden until /api/locations is served (parallel API PR); see locationsActive. */}
      {locationsActive && (
        <div className="w-full">
          <span className="sw-label">Locations</span>
          <LocationSelect
            options={enabledLocations}
            selected={form.locations}
            onToggle={toggleLocation}
          />
          {form.locations.length === 0 ? (
            <span className="mt-1 block text-[11px]" style={{ color: "var(--color-fail)" }}>
              Select at least one location.
            </span>
          ) : (
            <span className="mt-1 block text-[11px] text-[var(--color-ink-faint)]">
              This check runs from the selected location{form.locations.length === 1 ? "" : "s"}.
            </span>
          )}
        </div>
      )}

      {/* key:value tags — hidden until /api/tags/suggested is served (pre-API 404). */}
      {tagsActive && (
        <div>
          <TagEditor
            tags={form.tags}
            suggestedKeys={suggestedKeys ?? []}
            onAdd={addTag}
            onRemove={removeTag}
          />
          {/* Make staged-vs-saved unmistakable: on edit, each change is saved immediately; on create
              they persist with the new monitor. (Previously a chip was only staged and silently lost.) */}
          <p className="mt-1 text-[11px] text-[var(--color-ink-faint)]">
            {isEdit ? "Tags save automatically." : "Tags are saved when you create the monitor."}
          </p>
          {tagError && (
            <p className="mt-1 text-[11px]" style={{ color: "var(--color-fail)" }}>{tagError}</p>
          )}
        </div>
      )}

      {/* Multistep has no single target — the chain defines its own per-step URLs. */}
      {form.kind !== "multistep" && (
        <Field
          label={form.kind === "dns" || form.kind === "tcp" || form.kind === "ping" ? "Target host" : "Target URL"}
          hint={
            form.kind === "browser"
              ? "Entry URL for the browser flow."
              : form.kind === "ssl"
                ? "Host or https:// URL whose TLS certificate to check (port 443 default)."
                : form.kind === "dns"
                  ? "Hostname to resolve (e.g. example.com)."
                  : form.kind === "tcp" || form.kind === "ping"
                    ? "Host, or host:port (e.g. example.com or example.com:5432)."
                    : "Endpoint to probe."
          }
        >
          <input
            className="sw-input"
            value={form.target_url}
            onChange={(e) => set("target_url", e.target.value)}
            placeholder={
              form.kind === "dns" || form.kind === "tcp" || form.kind === "ping"
                ? "example.com"
                : "https://example.com/health"
            }
            inputMode="url"
          />
        </Field>
      )}

      {form.kind === "multistep" && (
        <MultistepBuilder steps={steps} onChange={setSteps} errors={fieldErrors} />
      )}

      {form.kind === "browser" && !isActivation && (
        <Field
          label="Flow"
          hint="Pick a spec from the Git catalog (or a runner flow), or type a new flow name. Choosing a spec runs it from Git — no first run needed."
        >
          <FlowCombobox
            value={form.flow_name}
            options={flowOptions}
            onChange={onFlowText}
            onSelect={onFlowSelect}
            placeholder="search a spec, or type a new flow name"
          />
          {form.spec_path ? (
            <span className="mt-1 block text-[11px] text-[var(--color-ink-faint)]" data-testid="flow-spec-bound">
              Spec-backed · fetched from Git each run · <span className="sw-mono">{form.spec_path}</span>
            </span>
          ) : (
            form.flow_name.trim() !== "" && (
              <span className="mt-1 block text-[11px] text-[var(--color-ink-faint)]">
                Runner flow <span className="sw-mono">{form.flow_name.trim()}</span> (not a Git spec).
              </span>
            )
          )}
        </Field>
      )}

      {form.kind === "http" && (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <div className="mb-3 sw-eyebrow">HTTP assertion</div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <span className="sw-label">Method</span>
              <Segmented
                value={form.method}
                onChange={(v) => set("method", v)}
                options={[
                  { value: "GET", label: "GET" },
                  { value: "POST", label: "POST" },
                  { value: "HEAD", label: "HEAD" },
                ]}
              />
            </div>
            <Field label="Expected status">
              <input
                className="sw-input sw-mono"
                value={form.expected_status}
                onChange={(e) => set("expected_status", e.target.value)}
                inputMode="numeric"
                placeholder="200"
              />
            </Field>
            <Field label="Body must contain">
              <input
                className="sw-input"
                value={form.body_must_contain}
                onChange={(e) => set("body_must_contain", e.target.value)}
                placeholder="ok"
              />
            </Field>
          </div>
        </div>
      )}

      {form.kind === "http" && (
        <AssertionBuilder value={http} onChange={setHttp} errors={fieldErrors} />
      )}

      {form.kind === "ssl" && (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <div className="mb-3 sw-eyebrow">TLS certificate</div>
          <Field
            label="Cert expiry warn (days)"
            hint="Warn (not fail) once the certificate has this many days or fewer remaining."
          >
            <input
              className="sw-input sw-mono"
              value={form.cert_expiry_warn_days}
              onChange={(e) => set("cert_expiry_warn_days", e.target.value)}
              inputMode="numeric"
              placeholder="30"
            />
          </Field>
        </div>
      )}

      {form.kind === "dns" && (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <div className="mb-3 sw-eyebrow">DNS</div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <span className="sw-label">Record type</span>
              <Segmented
                value={form.dns_record_type}
                onChange={(v) => set("dns_record_type", v)}
                options={[
                  { value: "A", label: "A" },
                  { value: "AAAA", label: "AAAA" },
                  { value: "CNAME", label: "CNAME" },
                  { value: "MX", label: "MX" },
                  { value: "TXT", label: "TXT" },
                  { value: "NS", label: "NS" },
                ]}
              />
            </div>
            <Field label="Expected value" hint="Optional — fail unless a record contains this substring.">
              <input
                className="sw-input sw-mono"
                value={form.dns_expected_value}
                onChange={(e) => set("dns_expected_value", e.target.value)}
                placeholder="93.184 (optional)"
              />
            </Field>
          </div>
        </div>
      )}

      {form.kind === "tcp" && (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <div className="mb-3 sw-eyebrow">TCP</div>
          <Field label="Port" hint="Required — the TCP port to connect to (or include host:port above).">
            <input
              className="sw-input sw-mono"
              value={form.tcp_port}
              onChange={(e) => set("tcp_port", e.target.value)}
              inputMode="numeric"
              placeholder="443"
            />
          </Field>
          {(fieldErrors["netConfig.port"] || fieldErrors["netConfig"]) && (
            <p className="mt-1 text-[11px]" style={{ color: "var(--color-fail)" }}>
              {fieldErrors["netConfig.port"] ?? fieldErrors["netConfig"]}
            </p>
          )}
        </div>
      )}

      {form.kind === "ping" && (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <div className="mb-3 sw-eyebrow">Ping</div>
          <Field label="Port" hint="Optional — TCP-reachability probe; defaults to 443.">
            <input
              className="sw-input sw-mono"
              value={form.ping_port}
              onChange={(e) => set("ping_port", e.target.value)}
              inputMode="numeric"
              placeholder="443"
            />
          </Field>
          {(fieldErrors["netConfig.port"] || fieldErrors["netConfig"]) && (
            <p className="mt-1 text-[11px]" style={{ color: "var(--color-fail)" }}>
              {fieldErrors["netConfig.port"] ?? fieldErrors["netConfig"]}
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-3 gap-4">
        <Field label="Interval (minutes)">
          <input
            className="sw-input sw-mono"
            type="number"
            min={1}
            step={1}
            value={form.interval_minutes}
            onChange={(e) => set("interval_minutes", e.target.value)}
            inputMode="numeric"
            placeholder="5"
          />
        </Field>
        <Field label="Timeout (ms)">
          <input
            className="sw-input sw-mono"
            value={form.timeout_ms}
            onChange={(e) => set("timeout_ms", e.target.value)}
            inputMode="numeric"
          />
        </Field>
        <Field label="Fail threshold">
          <input
            className="sw-input sw-mono"
            value={form.failure_threshold}
            onChange={(e) => set("failure_threshold", e.target.value)}
            inputMode="numeric"
          />
        </Field>
      </div>

      {form.kind === "browser" && (
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="sw-eyebrow">Lighthouse</span>
          <Toggle
            checked={form.lighthouse_enabled}
            onChange={(v) => set("lighthouse_enabled", v)}
            label={form.lighthouse_enabled ? "On" : "Off"}
          />
        </div>
        {form.lighthouse_enabled && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="LH interval (s)">
              <input
                className="sw-input sw-mono"
                value={form.lighthouse_interval_seconds}
                onChange={(e) => set("lighthouse_interval_seconds", e.target.value)}
                inputMode="numeric"
                placeholder="3600"
              />
            </Field>
            <div>
              <span className="sw-label">Form factor</span>
              <Segmented
                value={form.lighthouse_form_factor}
                onChange={(v) => set("lighthouse_form_factor", v)}
                options={[
                  { value: "mobile", label: "Mobile" },
                  { value: "desktop", label: "Desktop" },
                ]}
              />
            </div>
          </div>
        )}
      </div>
      )}

      {form.kind === "browser" && (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Perf budget — LCP (ms)" hint="Optional regression budget.">
          <input
            className="sw-input sw-mono"
            value={form.perf_budget_lcp_ms}
            onChange={(e) => set("perf_budget_lcp_ms", e.target.value)}
            inputMode="numeric"
            placeholder="2500"
          />
        </Field>
        <Field label="Perf budget — transfer (bytes)" hint="Optional page-weight budget.">
          <input
            className="sw-input sw-mono"
            value={form.perf_budget_transfer_bytes}
            onChange={(e) => set("perf_budget_transfer_bytes", e.target.value)}
            inputMode="numeric"
            placeholder="1500000"
          />
        </Field>
      </div>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] pt-4">
        <button type="button" onClick={onCancel} className="sw-btn">
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || (locationsActive && form.locations.length === 0)}
          className="sw-btn sw-btn-primary"
        >
          {submitting ? "Saving…" : isActivation ? "Set up monitor" : isEdit ? "Save changes" : "Create monitor"}
        </button>
      </div>
    </form>
  );
}
