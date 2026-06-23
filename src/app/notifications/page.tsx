"use client";

import { useEffect, useMemo, useState } from "react";

import {
  useChannels,
  useRouting,
  useChecks,
  deleteChannel,
  setRouting,
} from "@/lib/client";
import { Modal } from "@/components/modal";
import { ChannelForm } from "@/components/channel-form";
import { EmptyState, Spinner } from "@/components/states";
import type { Channel, Routing, RoutingSeverity } from "@/lib/types";

// v1 routing severities (alert trigger categories). Tag-based routing is Phase 9.
const SEVERITIES: { key: RoutingSeverity; label: string; tone: string }[] = [
  { key: "fail", label: "Fail", tone: "var(--color-fail)" },
  { key: "error", label: "Error", tone: "var(--color-fail)" },
  { key: "warn", label: "Warn", tone: "var(--color-warn)" },
  { key: "resolved", label: "Resolved", tone: "var(--color-pass)" },
];

function targetSummary(c: Channel): string {
  if (c.type === "email") {
    const to = c.config.to ?? [];
    return to.length ? to.join(", ") : "no recipients";
  }
  return c.config.url ?? "no URL";
}

/** Multi-select of channels (by id) — chip toggles, like the location selector. */
function ChannelPicker({
  channels,
  selected,
  onToggle,
  labelFor,
}: {
  channels: Channel[];
  selected: number[];
  onToggle: (id: number) => void;
  labelFor: (c: Channel) => string;
}) {
  if (channels.length === 0) {
    return <span className="text-[11px] text-[var(--color-ink-faint)]">No channels to route to yet.</span>;
  }
  return (
    <div className="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] p-0.5">
      {channels.map((c) => {
        const on = selected.includes(c.id);
        return (
          <button
            key={c.id}
            type="button"
            role="checkbox"
            aria-checked={on}
            aria-label={labelFor(c)}
            onClick={() => onToggle(c.id)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
              on
                ? "bg-[var(--color-panel-2)] text-[var(--color-ink)]"
                : "text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
            }`}
          >
            {on ? "✓ " : ""}
            {c.name}
          </button>
        );
      })}
    </div>
  );
}

export default function NotificationsPage() {
  const { data: channels, isLoading: channelsLoading } = useChannels();
  const { data: routingData } = useRouting();
  const { data: checks } = useChecks();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [deleting, setDeleting] = useState<Channel | null>(null);

  // Local routing draft (seeded once from the server; edits mark it dirty).
  const [draft, setDraft] = useState<Routing | null>(null);
  const [dirty, setDirty] = useState(false);
  const [savingRouting, setSavingRouting] = useState(false);
  const [routingError, setRoutingError] = useState<string | null>(null);

  useEffect(() => {
    if (draft || !routingData) return;
    const defaults: Routing["defaults"] = {};
    for (const s of SEVERITIES) {
      defaults[s.key] = { channelIds: routingData.defaults[s.key]?.channelIds ?? [] };
    }
    setDraft({ defaults, overrides: routingData.overrides ?? {} });
  }, [routingData, draft]);

  const channelList = useMemo(() => channels ?? [], [channels]);
  const channelById = useMemo(
    () => new Map(channelList.map((c) => [c.id, c])),
    [channelList],
  );

  // Before the parallel API PR serves the endpoints, the reads 404 → undefined.
  const apiAvailable = channels !== undefined;

  function toggleSeverity(sev: RoutingSeverity, channelId: number) {
    setDraft((d) => {
      if (!d) return d;
      const cur = d.defaults[sev]?.channelIds ?? [];
      const next = cur.includes(channelId) ? cur.filter((x) => x !== channelId) : [...cur, channelId];
      return { ...d, defaults: { ...d.defaults, [sev]: { channelIds: next } } };
    });
    setDirty(true);
  }

  function toggleOverride(checkId: number, channelId: number) {
    setDraft((d) => {
      if (!d) return d;
      const cur = d.overrides[checkId]?.channelIds ?? [];
      const next = cur.includes(channelId) ? cur.filter((x) => x !== channelId) : [...cur, channelId];
      return { ...d, overrides: { ...d.overrides, [checkId]: { channelIds: next } } };
    });
    setDirty(true);
  }

  function addOverride(checkId: number) {
    setDraft((d) => (d ? { ...d, overrides: { ...d.overrides, [checkId]: { channelIds: [] } } } : d));
    setDirty(true);
  }

  function removeOverride(checkId: number) {
    setDraft((d) => {
      if (!d) return d;
      const next = { ...d.overrides };
      delete next[checkId];
      return { ...d, overrides: next };
    });
    setDirty(true);
  }

  async function saveRouting() {
    if (!draft) return;
    setSavingRouting(true);
    setRoutingError(null);
    try {
      // Validation: drop any reference to a channel that no longer exists.
      const valid = (ids: number[]) => ids.filter((id) => channelById.has(id));
      const defaults: Routing["defaults"] = {};
      for (const s of SEVERITIES) defaults[s.key] = { channelIds: valid(draft.defaults[s.key]?.channelIds ?? []) };
      const overrides: Routing["overrides"] = {};
      for (const [cid, rule] of Object.entries(draft.overrides)) {
        const ids = valid(rule.channelIds);
        if (ids.length) overrides[cid] = { channelIds: ids };
      }
      await setRouting({ defaults, overrides });
      setDirty(false);
    } catch {
      setRoutingError("Failed to save routing. Please try again.");
    } finally {
      setSavingRouting(false);
    }
  }

  const overrideCheckIds = draft ? Object.keys(draft.overrides).map(Number) : [];
  const checksWithoutOverride = (checks ?? []).filter((c) => !overrideCheckIds.includes(c.id));

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="sw-eyebrow">Configuration</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Notifications</h1>
        </div>
        {apiAvailable && (
          <button onClick={() => setCreating(true)} className="sw-btn sw-btn-primary">
            + New channel
          </button>
        )}
      </header>

      {/* ── Honest delivery state ───────────────────────────────────────────── */}
      {!apiAvailable ? (
        channelsLoading ? (
          <div className="py-16"><Spinner label="Loading notifications…" /></div>
        ) : (
          <div
            className="rounded-lg px-4 py-3 text-sm"
            style={{
              background: "color-mix(in srgb, var(--color-warn) 12%, transparent)",
              border: "1px solid color-mix(in srgb, var(--color-warn) 40%, transparent)",
              color: "var(--color-warn)",
            }}
            data-testid="setup-pending"
          >
            <strong>Alerting setup pending.</strong> The notifications service isn&apos;t available
            yet — channels and routing can be managed here once it&apos;s deployed.
          </div>
        )
      ) : (
        <>
          <DeliveryBanner channelCount={channelList.length} />

          {/* ── Channels ──────────────────────────────────────────────────── */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-[var(--color-ink)]">Channels</h2>
            {channelList.length === 0 ? (
              <EmptyState
                title="No channels yet."
                hint="Add an email or webhook channel to start routing alerts."
                action={
                  <button onClick={() => setCreating(true)} className="sw-btn sw-btn-primary">
                    + New channel
                  </button>
                }
              />
            ) : (
              <div
                className="sw-panel divide-y divide-[var(--color-border)] overflow-hidden"
                data-testid="channel-list"
              >
                {channelList.map((c) => (
                  <div
                    key={c.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                    style={{ opacity: c.enabled ? 1 : 0.6 }}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-[var(--color-ink)]">{c.name}</span>
                        <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
                          {c.type}
                        </span>
                        {!c.enabled && (
                          <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
                            · disabled
                          </span>
                        )}
                      </div>
                      <span className="sw-mono block truncate text-[11px] text-[var(--color-ink-faint)]">
                        {targetSummary(c)}
                      </span>
                    </div>
                    <div className="flex gap-1.5">
                      <button onClick={() => setEditing(c)} className="sw-btn sw-btn-ghost sw-btn-sm">
                        Edit
                      </button>
                      <button onClick={() => setDeleting(c)} className="sw-btn sw-btn-ghost sw-btn-sm">
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── Routing ───────────────────────────────────────────────────── */}
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-[var(--color-ink)]">Routing</h2>
              <button
                onClick={saveRouting}
                disabled={!dirty || savingRouting}
                className="sw-btn sw-btn-primary sw-btn-sm"
              >
                {savingRouting ? "Saving…" : "Save routing"}
              </button>
            </div>
            {routingError && (
              <p className="text-[12px]" style={{ color: "var(--color-fail)" }}>{routingError}</p>
            )}

            <div className="sw-panel space-y-4 p-4">
              <div>
                <div className="sw-eyebrow mb-2">Severity defaults</div>
                <div className="space-y-3">
                  {SEVERITIES.map((s) => (
                    <div key={s.key} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-4">
                      <span
                        className="sw-mono w-20 text-[11px] font-medium uppercase tracking-wider"
                        style={{ color: s.tone }}
                      >
                        {s.label}
                      </span>
                      <ChannelPicker
                        channels={channelList}
                        selected={draft?.defaults[s.key]?.channelIds ?? []}
                        onToggle={(id) => toggleSeverity(s.key, id)}
                        labelFor={(c) => `route ${s.key} to ${c.name}`}
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="border-t border-[var(--color-border)] pt-4">
                <div className="sw-eyebrow mb-2">Per-check overrides</div>
                {overrideCheckIds.length === 0 && (
                  <p className="mb-2 text-[11px] text-[var(--color-ink-faint)]">
                    No overrides — every check uses the severity defaults above.
                  </p>
                )}
                <div className="space-y-3">
                  {overrideCheckIds.map((cid) => {
                    const check = (checks ?? []).find((c) => c.id === cid);
                    return (
                      <div key={cid} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-4">
                        <span className="w-40 truncate text-[12px] text-[var(--color-ink)]">
                          {check?.name ?? `Check #${cid}`}
                        </span>
                        <ChannelPicker
                          channels={channelList}
                          selected={draft?.overrides[cid]?.channelIds ?? []}
                          onToggle={(id) => toggleOverride(cid, id)}
                          labelFor={(c) => `override ${cid} to ${c.name}`}
                        />
                        <button
                          onClick={() => removeOverride(cid)}
                          className="sw-btn sw-btn-ghost sw-btn-sm self-start"
                        >
                          Remove
                        </button>
                      </div>
                    );
                  })}
                </div>
                {checksWithoutOverride.length > 0 && channelList.length > 0 && (
                  <div className="mt-3">
                    <select
                      className="sw-input max-w-xs text-[13px]"
                      aria-label="add per-check override"
                      value=""
                      onChange={(e) => e.target.value && addOverride(Number(e.target.value))}
                    >
                      <option value="">+ Add a per-check override…</option>
                      {checksWithoutOverride.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              <p className="border-t border-[var(--color-border)] pt-3 text-[11px] text-[var(--color-ink-faint)]">
                Tag-based routing is coming with tags (Phase 9).
              </p>
            </div>
          </section>
        </>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title="New channel">
        <ChannelForm onDone={() => setCreating(false)} onCancel={() => setCreating(false)} />
      </Modal>
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={`Edit · ${editing?.name ?? ""}`}
      >
        {editing && (
          <ChannelForm initial={editing} onDone={() => setEditing(null)} onCancel={() => setEditing(null)} />
        )}
      </Modal>
      {deleting && (
        <DeleteChannelDialog channel={deleting} onClose={() => setDeleting(null)} />
      )}
    </div>
  );
}

function DeliveryBanner({ channelCount }: { channelCount: number }) {
  if (channelCount === 0) {
    return (
      <div
        className="rounded-lg px-4 py-3 text-sm"
        style={{
          background: "color-mix(in srgb, var(--color-fail) 12%, transparent)",
          border: "1px solid color-mix(in srgb, var(--color-fail) 40%, transparent)",
          color: "var(--color-fail)",
        }}
        data-testid="no-delivery"
      >
        <strong>Alerts are not being delivered.</strong> No channels are configured — add one below.
      </div>
    );
  }
  return (
    <div
      className="rounded-lg px-4 py-3 text-[13px]"
      style={{
        background: "color-mix(in srgb, var(--color-warn) 10%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-warn) 35%, transparent)",
        color: "var(--color-ink-dim)",
      }}
      data-testid="transport-note"
    >
      Channels and routing are configured here, but{" "}
      <strong style={{ color: "var(--color-warn)" }}>email delivery depends on the ACS transport
      configured in infrastructure</strong>{" "}— until that&apos;s set up, configured alerts won&apos;t
      actually be delivered.
    </div>
  );
}

function DeleteChannelDialog({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      await deleteChannel(channel.id);
      onClose();
    } catch {
      setError("Failed to delete channel.");
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title={`Delete · ${channel.name}`} width={460}>
      <div className="space-y-4">
        <p className="text-sm text-[var(--color-ink-dim)]">
          Delete the <strong>{channel.name}</strong> channel? Any routing that points at it will be
          cleared.
        </p>
        {error && <p className="text-[12px]" style={{ color: "var(--color-fail)" }}>{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <button onClick={onClose} className="sw-btn">Cancel</button>
          <button onClick={run} disabled={busy} className="sw-btn sw-btn-danger">
            {busy ? "Deleting…" : "Delete channel"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
