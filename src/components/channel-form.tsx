"use client";

import { useState } from "react";

import { createChannel, updateChannel } from "@/lib/client";
import { ApiRequestError } from "@/lib/api-client";
import type { Channel, ChannelType } from "@/lib/types";

interface Props {
  initial?: Channel | null;
  onDone: () => void;
  onCancel: () => void;
}

/** Recipients are stored as an array; the input is comma/newline-separated. */
function parseRecipients(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function ChannelForm({ initial, onDone, onCancel }: Props) {
  const isEdit = Boolean(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<ChannelType>(initial?.type ?? "email");
  const [recipients, setRecipients] = useState((initial?.config.to ?? []).join(", "));
  const [url, setUrl] = useState(initial?.config.url ?? "");
  const [authHeader, setAuthHeader] = useState(initial?.config.authHeader ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (name.trim() === "") {
      setError("Name is required.");
      return;
    }
    // Validation mirrors the API: email needs ≥1 recipient (the sender is transport env, not here);
    // webhook needs a URL.
    const to = parseRecipients(recipients);
    if (type === "email") {
      if (to.length === 0) {
        setError("Add at least one recipient email address.");
        return;
      }
    } else if (url.trim() === "") {
      setError("A webhook URL is required.");
      return;
    }

    const config =
      type === "email"
        ? { to }
        : { url: url.trim(), authHeader: authHeader.trim() || null };

    setSubmitting(true);
    try {
      const payload = { name: name.trim(), type, config, enabled };
      if (isEdit && initial) {
        await updateChannel(initial.id, payload);
      } else {
        await createChannel(payload);
      }
      onDone();
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.message : "Failed to save channel. Please try again.",
      );
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

      <label className="block">
        <span className="sw-label">Name</span>
        <input
          className="sw-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="On-call email"
          autoFocus
        />
      </label>

      <div>
        <span className="sw-label">Type</span>
        <div className="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] p-0.5">
          {(["email", "webhook"] as ChannelType[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition ${
                type === t
                  ? "bg-[var(--color-panel-2)] text-[var(--color-ink)]"
                  : "text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {type === "email" ? (
        <>
          <label className="block">
            <span className="sw-label">Recipients</span>
            <input
              className="sw-input sw-mono"
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              placeholder="oncall@example.com, sre@example.com"
              aria-label="recipients"
            />
            <span className="mt-1 block text-[11px] text-[var(--color-ink-faint)]">
              Comma-separated. Who receives the alert.
            </span>
          </label>
          {/* ★ No sender or credential field — both are transport properties (a verified sender on
              the ACS-owned domain + the ACS connection string) configured in infrastructure, not
              per-channel. The user sets recipients only. */}
          <p className="rounded-lg border border-dashed border-[var(--color-border)] px-3 py-2 text-[11px] text-[var(--color-ink-dim)]">
            Sent from the configured ACS sender (set in infrastructure) — the sender and transport
            credentials are not editable here. You set the recipients only.
          </p>
        </>
      ) : (
        <>
          <label className="block">
            <span className="sw-label">Webhook URL</span>
            <input
              className="sw-input sw-mono"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://hooks.example.com/synthwatch"
              inputMode="url"
              aria-label="webhook url"
            />
          </label>
          <label className="block">
            <span className="sw-label">Auth header (optional)</span>
            <input
              className="sw-input sw-mono"
              value={authHeader}
              onChange={(e) => setAuthHeader(e.target.value)}
              placeholder="Authorization: Bearer …"
              aria-label="auth header"
            />
            <span className="mt-1 block text-[11px] text-[var(--color-ink-faint)]">
              Sent as-is to the target on each delivery. Leave blank for none.
            </span>
          </label>
        </>
      )}

      <button
        type="button"
        onClick={() => setEnabled((v) => !v)}
        className="flex items-center gap-2.5 text-sm"
      >
        <span
          className="relative h-5 w-9 rounded-full transition"
          style={{ background: enabled ? "var(--color-brand)" : "var(--color-border-strong)" }}
        >
          <span
            className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all"
            style={{ left: enabled ? "18px" : "2px" }}
          />
        </span>
        <span className="text-[var(--color-ink-dim)]">{enabled ? "Enabled" : "Disabled"}</span>
      </button>

      <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] pt-4">
        <button type="button" onClick={onCancel} className="sw-btn">
          Cancel
        </button>
        <button type="submit" disabled={submitting} className="sw-btn sw-btn-primary">
          {submitting ? "Saving…" : isEdit ? "Save changes" : "Create channel"}
        </button>
      </div>
    </form>
  );
}
