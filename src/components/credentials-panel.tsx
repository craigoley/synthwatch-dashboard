"use client";

import { useState } from "react";

import type { Check } from "@/lib/types";
import { useAuth } from "@/components/auth-provider";
import { setCredentials } from "@/lib/api-client";
import { revalidateChecks } from "@/lib/client";

/**
 * Model-B credential EDITOR (Step C — extends the #219 read-only viewer). Two write-only credential columns:
 * `secret_headers` ({ headerName -> value }) and `login_credentials` ({ role -> value }). The API encrypts each
 * value on write (AES-256-GCM) and the read DTO masks every configured slot to the literal "set" — the plaintext
 * is NEVER served back. So this panel:
 *   • shows each currently-configured slot as a masked "set" chip (from the GET readback), never a value;
 *   • lets an editor enter NEW name/value pairs and write them via PUT /checks/{id}/credentials;
 *   • is honest that saving REPLACES the whole column (the API's replace-per-column semantics) and that
 *     existing values can't be read back — so you must re-enter every value you want to keep.
 *
 * Gate: rendered only for an editor (`canWrite`). The API independently nulls both columns for a non-write
 * session, so a viewer's `check.*` is null regardless — the panel inherits that server-side gate and adds the
 * client `canWrite` check so a non-editor never sees inputs.
 */
export function CredentialsPanel({ check }: { check: Check }) {
  const { canWrite } = useAuth();
  // COLLAPSED by default (a disclosure) — the box took too much top-of-page space. React state only, no
  // localStorage (unavailable in this environment). All editor functionality is preserved when expanded.
  const [open, setOpen] = useState(false);
  // Non-editor → nothing (mirrors the API nulling the fields for a non-write session). An editor sees the
  // panel even with no credentials set yet, so they can add the first one.
  if (!canWrite) return null;

  // A small "N set" summary on the collapsed header so the count is visible without expanding.
  const setCount =
    Object.keys(check.secret_headers ?? {}).length + Object.keys(check.login_credentials ?? {}).length;

  return (
    <div className="sw-panel p-4" data-testid="credentials-panel">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="credentials-disclosure"
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="flex items-center gap-2">
          <svg
            width="12" height="12" viewBox="0 0 12 12" aria-hidden
            className={`text-[var(--color-ink-faint)] transition-transform ${open ? "rotate-90" : ""}`}
          >
            <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <h3 className="text-sm font-semibold text-[var(--color-ink)]">Credentials</h3>
          {setCount > 0 && (
            <span className="sw-mono text-[11px] text-[var(--color-ink-dim)]">· {setCount} set</span>
          )}
        </span>
        <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
          write-only
        </span>
      </button>

      {open && (
        <div className="mt-3" data-testid="credentials-body">
          <CredentialColumn
            checkId={check.id}
            column="secretHeaders"
            title="Secret headers"
            keyLabel="Header name"
            keyPlaceholder="X-Api-Key"
            current={check.secret_headers}
          />
          <div className="my-4 border-t border-[var(--color-border)]" />
          <CredentialColumn
            checkId={check.id}
            column="loginCredentials"
            title="Login credentials"
            keyLabel="Field"
            keyPlaceholder="role (e.g. username)"
            current={check.login_credentials}
          />

          <p className="mt-4 text-[11px] leading-relaxed text-[var(--color-ink-faint)]" data-testid="credentials-honesty">
            Values are encrypted at rest (AES-256-GCM) and used directly by the runner. They are{" "}
            <strong>write-only</strong> — never displayed back here; a configured slot shows only as “set”. Saving a
            section <strong>replaces every slot in it</strong>, and existing values can’t be read back, so include
            every value you want to keep.
          </p>
        </div>
      )}
    </div>
  );
}

type ColumnKey = "secretHeaders" | "loginCredentials";
interface EditRow {
  name: string;
  value: string;
}

function CredentialColumn({
  checkId,
  column,
  title,
  keyLabel,
  keyPlaceholder,
  current,
}: {
  checkId: number;
  column: ColumnKey;
  title: string;
  keyLabel: string;
  keyPlaceholder: string;
  /** Masked map { name -> "set" } (or null when nothing is configured). Values are always the literal "set". */
  current: Record<string, string> | null;
}) {
  const configured = Object.keys(current ?? {});
  const [rows, setRows] = useState<EditRow[]>([{ name: "", value: "" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const setRow = (i: number, patch: Partial<EditRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => [...rs, { name: "", value: "" }]);
  const removeRow = (i: number) => setRows((rs) => (rs.length === 1 ? [{ name: "", value: "" }] : rs.filter((_, j) => j !== i)));

  // Assemble the desired map: rows with BOTH a name and a value. (Replace semantics — this is the full new set.)
  const filled = rows.filter((r) => r.name.trim() !== "" && r.value !== "");
  const namesOnly = rows.filter((r) => r.name.trim() !== "" && r.value === "");

  async function write(map: Record<string, string>) {
    setBusy(true);
    setError(null);
    setSavedNote(null);
    try {
      await setCredentials(checkId, { [column]: map });
      await revalidateChecks(checkId); // re-GET → the masked "set" state refreshes; we never held a value
      setRows([{ name: "", value: "" }]);
      setSavedNote(Object.keys(map).length === 0 ? "Cleared." : "Saved — values stored encrypted.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const missing = namesOnly[0];
    if (missing) {
      setError(`Enter a value for “${missing.name.trim()}”, or remove that row.`);
      return;
    }
    if (filled.length === 0) {
      setError("Add at least one name and value, or use Clear to remove all.");
      return;
    }
    const map: Record<string, string> = {};
    for (const r of filled) map[r.name.trim()] = r.value;
    await write(map);
  }

  return (
    <div data-testid={`cred-column-${column}`}>
      <div className="mb-1.5 flex items-center gap-2">
        <h4 className="text-[13px] font-medium text-[var(--color-ink)]">{title}</h4>
        <span className="sw-mono text-[10px] text-[var(--color-ink-faint)]">
          {configured.length > 0 ? `${configured.length} set` : "none set"}
        </span>
      </div>

      {/* Currently-configured slots — masked "set", never a value. */}
      {configured.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5" data-testid={`cred-current-${column}`}>
          {configured.map((name) => (
            <span
              key={name}
              className="sw-mono inline-flex items-center gap-1.5 rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-0.5 text-[11px] text-[var(--color-ink-dim)]"
              data-testid={`cred-slot-${column}-${name}`}
            >
              <span className="text-[var(--color-ink)]">{name}</span>
              <span aria-hidden className="text-[var(--color-ink-faint)]">•••</span>
              <span className="uppercase tracking-wider text-[var(--color-brand)]">set</span>
            </span>
          ))}
        </div>
      )}

      {/* New name/value rows — the values entered here REPLACE the whole column on save. */}
      <div className="space-y-1.5">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input
              type="text"
              aria-label={`${title} ${keyLabel} ${i + 1}`}
              data-testid={`cred-name-${column}-${i}`}
              placeholder={keyPlaceholder}
              value={r.name}
              onChange={(e) => setRow(i, { name: e.target.value })}
              className="sw-mono w-2/5 rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-[12px] text-[var(--color-ink)]"
            />
            <input
              type="password"
              aria-label={`${title} value ${i + 1}`}
              data-testid={`cred-value-${column}-${i}`}
              placeholder="value (encrypted on save)"
              value={r.value}
              onChange={(e) => setRow(i, { value: e.target.value })}
              className="sw-mono flex-1 rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-[12px] text-[var(--color-ink)]"
            />
            <button
              type="button"
              onClick={() => removeRow(i)}
              aria-label={`remove ${title} row ${i + 1}`}
              className="sw-mono px-1.5 text-[13px] text-[var(--color-ink-faint)] transition hover:text-[var(--color-fail)]"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={addRow}
          className="sw-mono text-[11px] text-[var(--color-ink-faint)] transition hover:text-[var(--color-ink)]"
        >
          + add
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          data-testid={`cred-save-${column}`}
          className="sw-mono rounded bg-[var(--color-brand)] px-2.5 py-1 text-[11px] font-medium text-white transition disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {configured.length > 0 && (
          <button
            type="button"
            onClick={() => write({})}
            disabled={busy}
            data-testid={`cred-clear-${column}`}
            className="sw-mono text-[11px] text-[var(--color-ink-faint)] transition hover:text-[var(--color-fail)]"
          >
            Clear all
          </button>
        )}
      </div>

      {error && (
        <p className="mt-1.5 text-[11px] text-[var(--color-fail)]" data-testid={`cred-error-${column}`}>
          {error}
        </p>
      )}
      {savedNote && (
        <p className="mt-1.5 text-[11px] text-[var(--color-pass)]" data-testid={`cred-saved-${column}`}>
          {savedNote}
        </p>
      )}
    </div>
  );
}
