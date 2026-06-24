"use client";

import { useEffect, useMemo, useState } from "react";

import {
  useChannels,
  useRouting,
  useChecks,
  useDeliveryReadiness,
  deleteChannel,
  setRouting,
  sendChannelTest,
} from "@/lib/client";
import { ApiRequestError } from "@/lib/api-client";
import { Modal } from "@/components/modal";
import { ChannelForm } from "@/components/channel-form";
import { EmptyState, Spinner } from "@/components/states";
import { useToasts, ToastStack } from "@/components/toast";
import type { DeliveryReadiness } from "@/lib/api-client";
import type { Channel, Routing, RoutingSeverity } from "@/lib/types";

// Severities MUST match the API vocabulary (it 400s on anything else): critical | warning.
const SEVERITIES: { key: RoutingSeverity; label: string; tone: string }[] = [
  { key: "critical", label: "Critical", tone: "var(--color-fail)" },
  { key: "warning", label: "Warning", tone: "var(--color-warn)" },
];

const apiReason = (err: unknown, fallback: string) =>
  err instanceof ApiRequestError ? err.message : fallback;

function canDeliver(c: Channel): boolean {
  return c.type === "email" ? (c.config.to?.length ?? 0) > 0 : Boolean(c.config.url);
}

function targetSummary(c: Channel): string {
  if (c.type === "email") {
    const to = c.config.to ?? [];
    return to.length ? to.join(", ") : "no recipients";
  }
  return c.config.url ?? "no URL";
}

/** Multi-select of channels (by id) — chip toggles (used by per-check overrides). */
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
  const { data: readiness } = useDeliveryReadiness();
  const { toasts, push, dismiss } = useToasts();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [deleting, setDeleting] = useState<Channel | null>(null);

  const [draft, setDraft] = useState<Routing | null>(null);
  const [dirty, setDirty] = useState(false);
  const [savingRouting, setSavingRouting] = useState(false);

  // per-channel test-send state
  const [testing, setTesting] = useState<Record<number, boolean>>({});
  const [testResult, setTestResult] = useState<Record<number, { ok: boolean; text: string }>>({});

  useEffect(() => {
    if (draft || !routingData) return;
    const severity: Routing["severity"] = {};
    for (const s of SEVERITIES) severity[s.key] = { channelIds: routingData.severity[s.key]?.channelIds ?? [] };
    setDraft({ severity, perCheck: routingData.perCheck ?? {} });
  }, [routingData, draft]);

  const channelList = useMemo(() => channels ?? [], [channels]);
  const channelById = useMemo(() => new Map(channelList.map((c) => [c.id, c])), [channelList]);
  const apiAvailable = channels !== undefined;

  // Which channels are referenced by ≥1 route (severity default or per-check)?
  const routedIds = useMemo(() => {
    const ids = new Set<number>();
    if (draft) {
      for (const s of SEVERITIES) (draft.severity[s.key]?.channelIds ?? []).forEach((id) => ids.add(id));
      for (const rule of Object.values(draft.perCheck)) rule.channelIds.forEach((id) => ids.add(id));
    }
    return ids;
  }, [draft]);

  function toggleSeverity(sev: RoutingSeverity, channelId: number) {
    setDraft((d) => {
      if (!d) return d;
      const cur = d.severity[sev]?.channelIds ?? [];
      const next = cur.includes(channelId) ? cur.filter((x) => x !== channelId) : [...cur, channelId];
      return { ...d, severity: { ...d.severity, [sev]: { channelIds: next } } };
    });
    setDirty(true);
  }

  function toggleOverride(checkId: number, channelId: number) {
    setDraft((d) => {
      if (!d) return d;
      const cur = d.perCheck[checkId]?.channelIds ?? [];
      const next = cur.includes(channelId) ? cur.filter((x) => x !== channelId) : [...cur, channelId];
      return { ...d, perCheck: { ...d.perCheck, [checkId]: { channelIds: next } } };
    });
    setDirty(true);
  }

  function addOverride(checkId: number) {
    setDraft((d) => (d ? { ...d, perCheck: { ...d.perCheck, [checkId]: { channelIds: [] } } } : d));
    setDirty(true);
  }

  function removeOverride(checkId: number) {
    setDraft((d) => {
      if (!d) return d;
      const next = { ...d.perCheck };
      delete next[checkId];
      return { ...d, perCheck: next };
    });
    setDirty(true);
  }

  async function saveRouting() {
    if (!draft) return;
    setSavingRouting(true);
    try {
      const valid = (ids: number[]) => ids.filter((id) => channelById.has(id));
      const severity: Routing["severity"] = {};
      for (const s of SEVERITIES) severity[s.key] = { channelIds: valid(draft.severity[s.key]?.channelIds ?? []) };
      const perCheck: Routing["perCheck"] = {};
      for (const [cid, rule] of Object.entries(draft.perCheck)) {
        const ids = valid(rule.channelIds);
        if (ids.length) perCheck[cid] = { channelIds: ids };
      }
      await setRouting({ severity, perCheck });
      setDirty(false);
      push("success", "Routing saved.");
    } catch (err) {
      // ★ Never silent — surface WHAT failed and WHY.
      push("error", `Couldn't save routing: ${apiReason(err, "the request failed.")}`);
    } finally {
      setSavingRouting(false);
    }
  }

  async function runTest(c: Channel) {
    setTesting((t) => ({ ...t, [c.id]: true }));
    setTestResult((r) => {
      const next = { ...r };
      delete next[c.id];
      return next;
    });
    try {
      const res = await sendChannelTest(c.id);
      if ("unavailable" in res && res.unavailable) {
        setTestResult((r) => ({ ...r, [c.id]: { ok: false, text: "Test delivery isn't available yet." } }));
        push("error", `Test delivery isn't available yet (the API endpoint isn't deployed).`);
      } else if (res.ok) {
        setTestResult((r) => ({ ...r, [c.id]: { ok: true, text: "Test sent ✓" } }));
        push("success", `Test sent to “${c.name}”.`);
      } else {
        const why = res.detail || "delivery failed";
        setTestResult((r) => ({ ...r, [c.id]: { ok: false, text: `Test failed: ${why}` } }));
        push("error", `Test to “${c.name}” failed: ${why}`);
      }
    } catch (err) {
      const why = apiReason(err, "the request failed.");
      setTestResult((r) => ({ ...r, [c.id]: { ok: false, text: `Test failed: ${why}` } }));
      push("error", `Test to “${c.name}” failed: ${why}`);
    } finally {
      setTesting((t) => ({ ...t, [c.id]: false }));
    }
  }

  const overrideCheckIds = draft ? Object.keys(draft.perCheck).map(Number) : [];
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
          <DeliveryBanner readiness={readiness} />

          {/* ── Channels ──────────────────────────────────────────────────── */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-[var(--color-ink)]">Channels</h2>
            {channelList.length === 0 ? (
              <EmptyState
                title="No channels yet"
                hint="Add an email or webhook destination to start receiving alerts."
                action={
                  <button onClick={() => setCreating(true)} className="sw-btn sw-btn-primary">
                    + New channel
                  </button>
                }
              />
            ) : (
              <div className="sw-panel divide-y divide-[var(--color-border)] overflow-hidden" data-testid="channel-list">
                {channelList.map((c) => {
                  const deliverable = canDeliver(c);
                  const routed = routedIds.has(c.id);
                  const result = testResult[c.id];
                  return (
                    <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0" style={{ opacity: c.enabled ? 1 : 0.55 }}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-[var(--color-ink)]">{c.name}</span>
                          <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
                            {c.type}
                          </span>
                          {!c.enabled && <Badge tone="var(--color-idle)">disabled</Badge>}
                          {c.enabled && !deliverable && (
                            <Badge tone="var(--color-fail)" testid={`badge-undeliverable-${c.id}`}>
                              won&apos;t deliver
                            </Badge>
                          )}
                          {c.enabled && deliverable && !routed && (
                            <Badge tone="var(--color-warn)" testid={`badge-orphaned-${c.id}`}>
                              not routed
                            </Badge>
                          )}
                          {c.enabled && deliverable && routed && (
                            <Badge tone="var(--color-pass)" testid={`badge-routed-${c.id}`}>
                              routed
                            </Badge>
                          )}
                        </div>
                        <span className="sw-mono mt-0.5 block truncate text-[11px] text-[var(--color-ink-faint)]">
                          {targetSummary(c)}
                        </span>
                        {result && (
                          <span
                            className="mt-1 block text-[11px]"
                            style={{ color: result.ok ? "var(--color-pass)" : "var(--color-fail)" }}
                            data-testid={`test-result-${c.id}`}
                          >
                            {result.text}
                          </span>
                        )}
                      </div>
                      <div className="flex shrink-0 gap-1.5">
                        <button
                          onClick={() => runTest(c)}
                          disabled={testing[c.id] || !deliverable}
                          title={deliverable ? "Send a test delivery" : "Configure a target first"}
                          className="sw-btn sw-btn-ghost sw-btn-sm"
                          data-testid={`send-test-${c.id}`}
                        >
                          {testing[c.id] ? "Sending…" : "Send test"}
                        </button>
                        <button onClick={() => setEditing(c)} className="sw-btn sw-btn-ghost sw-btn-sm">
                          Edit
                        </button>
                        <button onClick={() => setDeleting(c)} className="sw-btn sw-btn-ghost sw-btn-sm">
                          Delete
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* ── Routing ───────────────────────────────────────────────────── */}
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <h2 className="text-sm font-semibold text-[var(--color-ink)]">Routing</h2>
                {dirty && (
                  <span
                    className="sw-mono text-[10px] uppercase tracking-wider"
                    style={{ color: "var(--color-warn)" }}
                    data-testid="unsaved-hint"
                  >
                    · unsaved changes
                  </span>
                )}
              </div>
              <button
                onClick={saveRouting}
                disabled={!dirty || savingRouting}
                className={`sw-btn sw-btn-sm ${dirty ? "sw-btn-primary" : ""}`}
              >
                {savingRouting ? "Saving…" : "Save routing"}
              </button>
            </div>

            <div className="sw-panel space-y-4 p-4">
              {/* Matrix: severities (rows) × channels (cols). */}
              <div>
                <div className="sw-eyebrow mb-2">Severity routing</div>
                {channelList.length === 0 ? (
                  <p className="text-[11px] text-[var(--color-ink-faint)]">
                    Add a channel above to route severities to it.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-left" data-testid="routing-matrix">
                      <thead>
                        <tr>
                          <th className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
                            Severity
                          </th>
                          {channelList.map((c) => (
                            <th
                              key={c.id}
                              className="w-24 px-2 py-1.5 text-center text-[11px] font-medium text-[var(--color-ink-dim)]"
                            >
                              <span className="block truncate text-center" title={c.name}>{c.name}</span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {SEVERITIES.map((s) => (
                          <tr key={s.key} className="border-t border-[var(--color-border)]">
                            <td className="px-2 py-2">
                              <span
                                className="sw-mono text-[11px] font-medium uppercase tracking-wider"
                                style={{ color: s.tone }}
                              >
                                {s.label}
                              </span>
                            </td>
                            {channelList.map((c) => {
                              const on = (draft?.severity[s.key]?.channelIds ?? []).includes(c.id);
                              return (
                                <td key={c.id} className="w-24 px-2 py-2 text-center">
                                  <button
                                    type="button"
                                    role="checkbox"
                                    aria-checked={on}
                                    aria-label={`route ${s.key} to ${c.name}`}
                                    onClick={() => toggleSeverity(s.key, c.id)}
                                    className="inline-flex h-6 w-6 items-center justify-center rounded-md border transition"
                                    style={{
                                      borderColor: on ? s.tone : "var(--color-border-strong)",
                                      background: on
                                        ? `color-mix(in srgb, ${s.tone} 22%, transparent)`
                                        : "transparent",
                                      color: on ? s.tone : "transparent",
                                    }}
                                  >
                                    ✓
                                  </button>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Per-check overrides */}
              <div className="border-t border-[var(--color-border)] pt-4">
                <div className="sw-eyebrow mb-2">Per-check overrides</div>
                {overrideCheckIds.length === 0 ? (
                  <p className="mb-2 text-[11px] text-[var(--color-ink-faint)]">
                    No per-check overrides — every check uses the severity routing above. Add one to send a
                    specific check&apos;s alerts to different channels.
                  </p>
                ) : (
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
                            selected={draft?.perCheck[cid]?.channelIds ?? []}
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
                )}
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
        <ChannelForm
          onDone={() => {
            setCreating(false);
            push("success", "Channel created.");
          }}
          onCancel={() => setCreating(false)}
        />
      </Modal>
      <Modal open={editing !== null} onClose={() => setEditing(null)} title={`Edit · ${editing?.name ?? ""}`}>
        {editing && (
          <ChannelForm
            initial={editing}
            onDone={() => {
              setEditing(null);
              push("success", "Channel updated.");
            }}
            onCancel={() => setEditing(null)}
          />
        )}
      </Modal>
      {deleting && (
        <DeleteChannelDialog
          channel={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            push("success", "Channel deleted.");
          }}
        />
      )}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function Badge({ tone, children, testid }: { tone: string; children: React.ReactNode; testid?: string }) {
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider"
      style={{
        color: tone,
        background: `color-mix(in srgb, ${tone} 14%, transparent)`,
        border: `1px solid color-mix(in srgb, ${tone} 34%, transparent)`,
      }}
      data-testid={testid}
    >
      {children}
    </span>
  );
}

function DeliveryBanner({ readiness }: { readiness: DeliveryReadiness | null | undefined }) {
  // Accurate when the readiness endpoint exists; a neutral note (no false certainty)
  // when it doesn't (404 → null) — a permanent wrong warning trains users to ignore it.
  if (readiness === undefined) return null; // loading
  if (readiness && readiness.transportConfigured) {
    return (
      <Banner tone="var(--color-pass)" testid="delivery-active">
        <strong>Alerting is active.</strong> The email transport is configured — routed alerts will be
        delivered.
      </Banner>
    );
  }
  if (readiness && !readiness.transportConfigured) {
    return (
      <Banner tone="var(--color-warn)" testid="delivery-not-configured">
        <strong>Transport not configured.</strong> {readiness.detail || "The ACS email transport isn't set up, so alerts won't be delivered until ops configures it."}
      </Banner>
    );
  }
  // readiness === null → can't verify; neutral, no failure claim.
  return (
    <Banner tone="var(--color-border-strong)" testid="delivery-unknown" muted>
      Email delivery uses the ACS transport configured in infrastructure. Configure channels and routing
      here; delivery readiness is managed by ops.
    </Banner>
  );
}

function Banner({
  tone,
  children,
  testid,
  muted = false,
}: {
  tone: string;
  children: React.ReactNode;
  testid?: string;
  muted?: boolean;
}) {
  return (
    <div
      className="rounded-lg px-4 py-3 text-[13px]"
      style={{
        background: `color-mix(in srgb, ${tone} ${muted ? 8 : 12}%, transparent)`,
        border: `1px solid color-mix(in srgb, ${tone} ${muted ? 30 : 40}%, transparent)`,
        color: muted ? "var(--color-ink-dim)" : tone,
      }}
      data-testid={testid}
    >
      {children}
    </div>
  );
}

function DeleteChannelDialog({
  channel,
  onClose,
  onDeleted,
}: {
  channel: Channel;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      await deleteChannel(channel.id);
      onDeleted();
    } catch (err) {
      // Surface the real reason — esp. the 409 delete-guard ("N routes point at this channel").
      setError(apiReason(err, "Failed to delete channel. Please try again."));
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
        {error && (
          <div
            className="rounded-lg px-3 py-2 text-[13px]"
            style={{
              background: "color-mix(in srgb, var(--color-fail) 12%, transparent)",
              border: "1px solid color-mix(in srgb, var(--color-fail) 40%, transparent)",
              color: "var(--color-fail)",
            }}
            data-testid="delete-error"
          >
            <strong>Can&apos;t delete this channel.</strong> {error}
          </div>
        )}
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
