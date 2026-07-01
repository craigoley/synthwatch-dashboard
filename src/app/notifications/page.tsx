"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  useChannels,
  useRouting,
  useChecks,
  useTags,
  useDeliveryReadiness,
  deleteChannel,
  setRouting,
  sendChannelTest,
  getChannelTestStatus,
} from "@/lib/client";
import { ApiRequestError } from "@/lib/api-client";
import { Modal } from "@/components/modal";
import { ChannelForm } from "@/components/channel-form";
import { useAuth } from "@/components/auth-provider";
import { SignInToEdit } from "@/components/write-gate";
import { EmptyState, Spinner } from "@/components/states";
import { useToasts, ToastStack } from "@/components/toast";
import { TagChips } from "@/components/tag-chips";
import type { DeliveryReadiness } from "@/lib/api-client";
import type { Channel, CheckWithStatus, Routing, RoutingSeverity, Tag } from "@/lib/types";

// Severities MUST match the API vocabulary (it 400s on anything else): critical | warning.
const SEVERITIES: { key: RoutingSeverity; label: string; tone: string }[] = [
  { key: "critical", label: "Critical", tone: "var(--color-fail)" },
  { key: "warning", label: "Warning", tone: "var(--color-warn)" },
];

const apiReason = (err: unknown, fallback: string) =>
  err instanceof ApiRequestError ? err.message : fallback;

// Async test-send tuning. The job runs on the runner (~10-15s), so we poll on a
// short interval and bail (softly) after a generous ceiling rather than hang.
const TEST_POLL_INTERVAL_MS = 2_000;
const TEST_POLL_TIMEOUT_MS = 60_000;

/** UI phase of a per-channel test send (see state declaration for the lifecycle). */
type TestPhase = "queuing" | "pending" | "sending" | "delivered" | "failed" | "timeout";

/** True while the test is still in flight — keeps the button disabled + spinning. */
const isTestBusy = (p: TestPhase | undefined): boolean =>
  p === "queuing" || p === "pending" || p === "sending";

interface FanOutChannel {
  channel: Channel;
  viaSeverity: boolean;
  viaPerCheck: boolean;
  viaTags: Tag[]; // which of the check's tags matched a tag-rule pointing here
  escalatedByTag: boolean;
}

/**
 * Client mirror of the runner's resolveChannels (#85): the deduped UNION of
 * severity-default ∪ per-check ∪ tag-rules matching the check's tags, restricted to
 * ENABLED channels, ordered by id. Also tracks WHICH dimension(s) reached each
 * channel (legibility) and flags tag-driven escalation of a warning onto a
 * normally-critical-only channel.
 */
function computeFanOut(
  check: CheckWithStatus,
  severity: RoutingSeverity,
  routing: Routing,
  channelsById: Map<number, Channel>,
): FanOutChannel[] {
  const sevIds = new Set(routing.severity[severity]?.channelIds ?? []);
  const critIds = new Set(routing.severity.critical?.channelIds ?? []);
  const perCheckIds = new Set(routing.perCheck[String(check.id)]?.channelIds ?? []);
  const tags = check.tags ?? [];
  const tagMatch = new Map<number, Tag[]>();
  for (const r of routing.tagRules) {
    if (tags.some((t) => t.key === r.tagKey && t.value === r.tagValue)) {
      const arr = tagMatch.get(r.channelId) ?? [];
      arr.push({ key: r.tagKey, value: r.tagValue });
      tagMatch.set(r.channelId, arr);
    }
  }
  const allIds = new Set<number>([...sevIds, ...perCheckIds, ...tagMatch.keys()]);
  const out: FanOutChannel[] = [];
  for (const id of allIds) {
    const channel = channelsById.get(id);
    if (!channel || !channel.enabled) continue; // resolveChannels: enabled channels only
    const viaSeverity = sevIds.has(id);
    const viaTags = tagMatch.get(id) ?? [];
    out.push({
      channel,
      viaSeverity,
      viaPerCheck: perCheckIds.has(id),
      viaTags,
      // a tag pulls a normally-critical-only channel into a WARNING page (3am risk)
      escalatedByTag: severity === "warning" && !viaSeverity && viaTags.length > 0 && critIds.has(id),
    });
  }
  return out.sort((a, b) => a.channel.id - b.channel.id);
}

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
  const { data: inUseTags } = useTags();
  const { data: readiness } = useDeliveryReadiness();
  const { canWrite } = useAuth();
  const { toasts, push, dismiss } = useToasts();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [deleting, setDeleting] = useState<Channel | null>(null);

  const [draft, setDraft] = useState<Routing | null>(null);
  const [dirty, setDirty] = useState(false);
  const [savingRouting, setSavingRouting] = useState(false);

  // Per-channel test-send state. A test send now runs on the runner (~10-15s), so
  // each channel tracks an async phase rather than a boolean:
  //   queuing  — POST in flight (enqueueing)
  //   pending  — queued, runner not started yet (polling)
  //   sending  — runner actively delivering (polling)
  //   delivered/failed — terminal outcome
  //   timeout  — gave up polling (~60s); the job may still complete on the runner
  // `testResult` holds the inline outcome line shown under the channel.
  const [testPhase, setTestPhase] = useState<Record<number, TestPhase>>({});
  const [testResult, setTestResult] = useState<Record<number, { ok: boolean; text: string }>>({});
  // Active poll timers, keyed by channel id — cleared on terminal state + unmount.
  const pollTimers = useRef<Record<number, ReturnType<typeof setInterval>>>({});

  // Stop every in-flight poll when the page unmounts / navigates away (no leaks).
  useEffect(() => {
    const timers = pollTimers.current;
    return () => {
      for (const t of Object.values(timers)) clearInterval(t);
    };
  }, []);

  useEffect(() => {
    if (draft || !routingData) return;
    const severity: Routing["severity"] = {};
    for (const s of SEVERITIES) severity[s.key] = { channelIds: routingData.severity[s.key]?.channelIds ?? [] };
    setDraft({ severity, perCheck: routingData.perCheck ?? {}, tagRules: routingData.tagRules ?? [] });
  }, [routingData, draft]);

  const channelList = useMemo(() => channels ?? [], [channels]);
  const channelById = useMemo(() => new Map(channelList.map((c) => [c.id, c])), [channelList]);
  const apiAvailable = channels !== undefined;

  // tag-rule autocomplete from in-use tags (any key/value still allowed).
  const tagKeyOptions = useMemo(() => [...new Set((inUseTags ?? []).map((t) => t.key))], [inUseTags]);
  const tagValueOptions = useMemo(() => [...new Set((inUseTags ?? []).map((t) => t.value))], [inUseTags]);

  // Which channels are referenced by ≥1 route (severity default or per-check)?
  const routedIds = useMemo(() => {
    const ids = new Set<number>();
    if (draft) {
      for (const s of SEVERITIES) (draft.severity[s.key]?.channelIds ?? []).forEach((id) => ids.add(id));
      for (const rule of Object.values(draft.perCheck)) rule.channelIds.forEach((id) => ids.add(id));
      for (const r of draft.tagRules) ids.add(r.channelId);
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

  // ── tag-rule editor state ──────────────────────────────────────────────────
  // Groups in the UI are unique (tagKey,tagValue); a pending group exists before
  // its first channel is picked (no TagRule rows yet). New-rule key/value inputs.
  const [pendingTagGroups, setPendingTagGroups] = useState<{ tagKey: string; tagValue: string }[]>([]);
  const [newTagKey, setNewTagKey] = useState("");
  const [newTagValue, setNewTagValue] = useState("");

  function toggleTagRule(tagKey: string, tagValue: string, channelId: number) {
    setDraft((d) => {
      if (!d) return d;
      const exists = d.tagRules.some(
        (r) => r.tagKey === tagKey && r.tagValue === tagValue && r.channelId === channelId,
      );
      const tagRules = exists
        ? d.tagRules.filter((r) => !(r.tagKey === tagKey && r.tagValue === tagValue && r.channelId === channelId))
        : [...d.tagRules, { tagKey, tagValue, channelId }];
      return { ...d, tagRules };
    });
    setDirty(true);
  }

  function addTagGroup() {
    const k = newTagKey.trim().toLowerCase();
    const v = newTagValue.trim().toLowerCase();
    if (!k || !v) return;
    setPendingTagGroups((g) =>
      g.some((x) => x.tagKey === k && x.tagValue === v) ? g : [...g, { tagKey: k, tagValue: v }],
    );
    setNewTagKey("");
    setNewTagValue("");
  }

  function removeTagGroup(tagKey: string, tagValue: string) {
    setDraft((d) =>
      d ? { ...d, tagRules: d.tagRules.filter((r) => !(r.tagKey === tagKey && r.tagValue === tagValue)) } : d,
    );
    setPendingTagGroups((g) => g.filter((x) => !(x.tagKey === tagKey && x.tagValue === tagValue)));
    setDirty(true);
  }

  // Unique (tagKey,tagValue) groups: those with rules + pending ones not yet saved.
  const tagGroups = useMemo(() => {
    const seen = new Set<string>();
    const groups: { tagKey: string; tagValue: string }[] = [];
    for (const r of draft?.tagRules ?? []) {
      const k = `${r.tagKey}:${r.tagValue}`;
      if (!seen.has(k)) { seen.add(k); groups.push({ tagKey: r.tagKey, tagValue: r.tagValue }); }
    }
    for (const g of pendingTagGroups) {
      const k = `${g.tagKey}:${g.tagValue}`;
      if (!seen.has(k)) { seen.add(k); groups.push(g); }
    }
    return groups;
  }, [draft?.tagRules, pendingTagGroups]);

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
      // tag-rules: drop any pointing at a deleted channel (mirrors severity/perCheck validation).
      const tagRules = draft.tagRules.filter((r) => channelById.has(r.channelId));
      await setRouting({ severity, perCheck, tagRules });
      setDirty(false);
      push("success", "Routing saved.");
    } catch (err) {
      // ★ Never silent — surface WHAT failed and WHY.
      push("error", `Couldn't save routing: ${apiReason(err, "the request failed.")}`);
    } finally {
      setSavingRouting(false);
    }
  }

  function clearTestPoll(id: number) {
    const t = pollTimers.current[id];
    if (t) {
      clearInterval(t);
      delete pollTimers.current[id];
    }
  }

  function setPhase(id: number, phase: TestPhase) {
    setTestPhase((p) => ({ ...p, [id]: phase }));
  }
  function setResult(id: number, ok: boolean, text: string) {
    setTestResult((r) => ({ ...r, [id]: { ok, text } }));
  }

  /**
   * Enqueue a test send on the runner, then poll for the outcome. The runner job
   * takes ~10-15s, so we NEVER block: we flip to a pending state, poll every ~2s,
   * resolve on delivered/failed, and soft-stop after ~60s rather than hang forever.
   */
  async function runTest(c: Channel) {
    if (isTestBusy(testPhase[c.id])) return; // guard re-click while in flight
    clearTestPoll(c.id); // never run two polls for one channel
    setPhase(c.id, "queuing");
    setResult(c.id, true, "Queuing test…");

    let res: Awaited<ReturnType<typeof sendChannelTest>>;
    try {
      res = await sendChannelTest(c.id);
    } catch (err) {
      // Network / 5xx on the POST itself — nothing was queued.
      const why = apiReason(err, "the request failed.");
      setPhase(c.id, "failed");
      setResult(c.id, false, `Test failed: ${why}`);
      push("error", `Test to “${c.name}” failed: ${why}`);
      return;
    }

    if ("unavailable" in res && res.unavailable) {
      setPhase(c.id, "failed");
      setResult(c.id, false, "Test delivery isn't available yet.");
      push("error", `Test delivery isn't available yet (the API endpoint isn't deployed).`);
      return;
    }

    const { requestId } = res;
    setPhase(c.id, "pending");
    setResult(c.id, true, "Sending test… (~15s)");

    // Count polls instead of reading the clock (the runner job is ~10-15s; we cap
    // at TEST_POLL_TIMEOUT_MS worth of fixed-interval polls, then soft-stop).
    const maxPolls = Math.ceil(TEST_POLL_TIMEOUT_MS / TEST_POLL_INTERVAL_MS);
    let pollCount = 0;
    const poll = async () => {
      pollCount += 1;
      try {
        const s = await getChannelTestStatus(c.id, requestId);
        if (s.status === "delivered") {
          clearTestPoll(c.id);
          setPhase(c.id, "delivered");
          setResult(c.id, true, s.detail ? `Test delivered ✓ (${s.detail})` : "Test delivered ✓");
          push("success", `Test delivered to “${c.name}”.`);
          return;
        }
        if (s.status === "failed") {
          clearTestPoll(c.id);
          const why = s.detail || "delivery failed";
          setPhase(c.id, "failed");
          setResult(c.id, false, `Test failed: ${why}`);
          push("error", `Test to “${c.name}” failed: ${why}`);
          return;
        }
        // still pending / sending — reflect the runner's phase, keep polling.
        setPhase(c.id, s.status);
        if (pollCount >= maxPolls) {
          clearTestPoll(c.id);
          setPhase(c.id, "timeout");
          setResult(c.id, true, "Still sending — check back shortly.");
        }
      } catch (err) {
        // Status endpoint failed (e.g. 404 unknown requestId) — stop, surface why.
        clearTestPoll(c.id);
        const why = apiReason(err, "couldn't read the test status.");
        setPhase(c.id, "failed");
        setResult(c.id, false, `Test failed: ${why}`);
        push("error", `Test to “${c.name}” failed: ${why}`);
      }
    };

    pollTimers.current[c.id] = setInterval(poll, TEST_POLL_INTERVAL_MS);
    void poll(); // fire once immediately — don't wait a full interval for the first read
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
        {apiAvailable && canWrite && (
          <button onClick={() => setCreating(true)} className="sw-btn sw-btn-primary">
            + New channel
          </button>
        )}
      </header>

      <SignInToEdit />

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
                  canWrite ? (
                    <button onClick={() => setCreating(true)} className="sw-btn sw-btn-primary">
                      + New channel
                    </button>
                  ) : undefined
                }
              />
            ) : (
              <div className="sw-panel divide-y divide-[var(--color-border)] overflow-hidden" data-testid="channel-list">
                {channelList.map((c) => {
                  const deliverable = canDeliver(c);
                  const routed = routedIds.has(c.id);
                  const result = testResult[c.id];
                  const phase = testPhase[c.id];
                  const busy = isTestBusy(phase);
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
                            className="mt-1 flex items-center gap-1.5 text-[11px]"
                            style={{
                              // While in flight (queuing/pending/sending) or timed out, stay
                              // neutral — green/red is reserved for the terminal verdict.
                              color: busy || phase === "timeout"
                                ? "var(--color-ink-dim)"
                                : result.ok
                                  ? "var(--color-pass)"
                                  : "var(--color-fail)",
                            }}
                            data-testid={`test-result-${c.id}`}
                          >
                            {busy && (
                              <span
                                className="sw-spin inline-block h-3 w-3 shrink-0 rounded-full border-2 border-[var(--color-border-strong)] border-t-[var(--color-brand)]"
                                aria-hidden="true"
                              />
                            )}
                            {result.text}
                          </span>
                        )}
                      </div>
                      {canWrite && (
                      <div className="flex shrink-0 gap-1.5">
                        <button
                          onClick={() => runTest(c)}
                          disabled={busy || !deliverable}
                          aria-busy={busy}
                          title={
                            deliverable
                              ? "Send a test delivery (runs on the runner, ~15s)"
                              : "Configure a target first"
                          }
                          className="sw-btn sw-btn-ghost sw-btn-sm"
                          data-testid={`send-test-${c.id}`}
                        >
                          {busy ? (
                            <span className="inline-flex items-center gap-1.5">
                              <span
                                className="sw-spin inline-block h-3 w-3 rounded-full border-2 border-[var(--color-border-strong)] border-t-[var(--color-brand)]"
                                aria-hidden="true"
                              />
                              {phase === "queuing" ? "Queuing…" : "Sending test… (~15s)"}
                            </span>
                          ) : (
                            "Send test"
                          )}
                        </button>
                        <button onClick={() => setEditing(c)} className="sw-btn sw-btn-ghost sw-btn-sm">
                          Edit
                        </button>
                        <button onClick={() => setDeleting(c)} className="sw-btn sw-btn-ghost sw-btn-sm">
                          Delete
                        </button>
                      </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* ── Routing (write controls; gated — read-only viewers can't manage routing) ── */}
          {canWrite && (
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

              {/* Tag rules — checks carrying a tag also route to these channels (additive). */}
              <div className="border-t border-[var(--color-border)] pt-4">
                <div className="sw-eyebrow mb-2">Tag rules</div>
                <p className="mb-2 text-[11px] text-[var(--color-ink-faint)]">
                  Checks carrying a tag also route to these channels — added on top of severity + per-check
                  (all routing is additive; see the fan-out preview below for the result).
                </p>
                {tagGroups.length === 0 && (
                  <p className="mb-2 text-[11px] text-[var(--color-ink-faint)]">No tag rules yet.</p>
                )}
                <div className="space-y-3">
                  {tagGroups.map((g) => {
                    const selected = (draft?.tagRules ?? [])
                      .filter((r) => r.tagKey === g.tagKey && r.tagValue === g.tagValue)
                      .map((r) => r.channelId);
                    return (
                      <div
                        key={`${g.tagKey}:${g.tagValue}`}
                        className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-4"
                        data-testid={`tag-rule-${g.tagKey}-${g.tagValue}`}
                      >
                        <span className="sw-mono w-40 shrink-0 truncate text-[12px] text-[var(--color-ink)]">
                          <span className="text-[var(--color-ink-faint)]">{g.tagKey}:</span>
                          {g.tagValue}
                        </span>
                        <ChannelPicker
                          channels={channelList}
                          selected={selected}
                          onToggle={(id) => toggleTagRule(g.tagKey, g.tagValue, id)}
                          labelFor={(c) => `tag-rule ${g.tagKey}:${g.tagValue} to ${c.name}`}
                        />
                        <button
                          onClick={() => removeTagGroup(g.tagKey, g.tagValue)}
                          className="sw-btn sw-btn-ghost sw-btn-sm self-start"
                        >
                          Remove
                        </button>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    className="sw-input sw-mono w-32 text-[13px]"
                    list="sw-routing-tag-keys"
                    value={newTagKey}
                    onChange={(e) => setNewTagKey(e.target.value)}
                    placeholder="key"
                    aria-label="tag rule key"
                  />
                  <datalist id="sw-routing-tag-keys">
                    {tagKeyOptions.map((k) => <option key={k} value={k} />)}
                  </datalist>
                  <span className="text-[var(--color-ink-faint)]">:</span>
                  <input
                    className="sw-input sw-mono w-40 text-[13px]"
                    list="sw-routing-tag-values"
                    value={newTagValue}
                    onChange={(e) => setNewTagValue(e.target.value)}
                    placeholder="value"
                    aria-label="tag rule value"
                  />
                  <datalist id="sw-routing-tag-values">
                    {tagValueOptions.map((v) => <option key={v} value={v} />)}
                  </datalist>
                  <button
                    onClick={addTagGroup}
                    disabled={!newTagKey.trim() || !newTagValue.trim()}
                    className="sw-btn sw-btn-sm"
                  >
                    + Add tag rule
                  </button>
                </div>
              </div>
            </div>
          </section>
          )}

          {/* ★ Fan-out preview — the legibility guardrail for all-additive routing. */}
          <FanOutPreview checks={checks ?? []} channelsById={channelById} routing={draft} />
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

/**
 * ★ The legibility guardrail: pick a check + severity → see the EXACT deduped set of
 * channels that will fire (severity ∪ per-check ∪ matching tag-rules), with the
 * source(s) per channel and a flag when a tag escalates a warning onto a normally
 * critical-only channel. Reflects the live draft, so the user sees the effect of a
 * rule before saving — not at 3am.
 */
function FanOutPreview({
  checks,
  channelsById,
  routing,
}: {
  checks: CheckWithStatus[];
  channelsById: Map<number, Channel>;
  routing: Routing | null;
}) {
  const [checkId, setCheckId] = useState<number | null>(null);
  const [severity, setSeverity] = useState<RoutingSeverity>("critical");
  const check = checks.find((c) => c.id === checkId) ?? checks[0] ?? null;

  if (!routing || checks.length === 0) return null;
  const fanOut = check ? computeFanOut(check, severity, routing, channelsById) : [];

  return (
    <section className="space-y-3" data-testid="fanout-preview">
      <h2 className="text-sm font-semibold text-[var(--color-ink)]">Alert fan-out preview</h2>
      <div className="sw-panel space-y-3 p-4">
        <p className="text-[11px] text-[var(--color-ink-faint)]">
          The exact channels a {severity} incident would fire — the deduped union of severity, per-check,
          and matching tag rules. A channel matched by more than one rule appears once.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="sw-input max-w-xs text-[13px]"
            aria-label="preview check"
            value={check?.id ?? ""}
            onChange={(e) => setCheckId(Number(e.target.value))}
          >
            {checks.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <div className="inline-flex rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] p-0.5">
            {SEVERITIES.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setSeverity(s.key)}
                aria-pressed={severity === s.key}
                className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                  severity === s.key
                    ? "bg-[var(--color-panel-2)] text-[var(--color-ink)]"
                    : "text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {check && (check.tags?.length ?? 0) > 0 && (
          <div className="flex items-center gap-2">
            <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">tags</span>
            <TagChips tags={check.tags} />
          </div>
        )}

        {fanOut.length === 0 ? (
          <div
            className="rounded-lg px-3 py-2 text-[13px]"
            style={{
              background: "color-mix(in srgb, var(--color-warn) 12%, transparent)",
              border: "1px solid color-mix(in srgb, var(--color-warn) 40%, transparent)",
              color: "var(--color-warn)",
            }}
            data-testid="fanout-empty"
          >
            A {severity} incident here would alert <strong>no one</strong> — no routing reaches an enabled
            channel.
          </div>
        ) : (
          <div className="space-y-1.5" data-testid="fanout-list">
            <p className="text-[11px] text-[var(--color-ink-faint)]">
              Fires {fanOut.length} channel{fanOut.length === 1 ? "" : "s"}:
            </p>
            {fanOut.map((f) => (
              <div
                key={f.channel.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2"
                data-testid={`fanout-channel-${f.channel.id}`}
              >
                <span className="text-sm font-medium text-[var(--color-ink)]">{f.channel.name}</span>
                <span className="sw-mono text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
                  {f.channel.type}
                </span>
                <span className="ml-auto flex flex-wrap items-center gap-1">
                  {f.viaSeverity && <Badge tone="var(--color-ink-dim)">severity</Badge>}
                  {f.viaPerCheck && <Badge tone="var(--color-running)">per-check</Badge>}
                  {f.viaTags.map((t) => (
                    <Badge key={`${t.key}:${t.value}`} tone="var(--color-brand)">
                      {t.key}:{t.value}
                    </Badge>
                  ))}
                  {f.escalatedByTag && (
                    <Badge tone="var(--color-fail)" testid={`fanout-escalation-${f.channel.id}`}>
                      ⚠ escalated by tag
                    </Badge>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
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
  // The banner reflects what's KNOWN, flags what's UNKNOWN, and never asserts a
  // deliverability state the API couldn't verify.
  if (readiness === undefined) return null; // loading

  // Endpoint not served yet (pre-merge 404) → neutral, no claim either way.
  if (readiness === null) {
    return (
      <Banner tone="var(--color-border-strong)" testid="delivery-unknown" muted>
        Email delivery uses the ACS transport configured in infrastructure. Configure channels and routing
        here; delivery readiness is managed by ops.
      </Banner>
    );
  }

  // Config the API CAN see — incomplete config means alerts definitely won't fire.
  if (!readiness.channelsConfigured || !readiness.routingConfigured) {
    const what =
      !readiness.channelsConfigured && !readiness.routingConfigured
        ? "No deliverable channels and no routing are configured"
        : !readiness.channelsConfigured
          ? "No deliverable channel is configured (a channel needs a recipient / URL)"
          : "No routing is configured (no severity, per-check, or tag rule points at a channel)";
    return (
      <Banner tone="var(--color-warn)" testid="delivery-incomplete">
        <strong>Alerts won&apos;t fire.</strong> {what} — set it up below.
      </Banner>
    );
  }

  // Config is complete; the verdict now hinges on the transport.
  if (readiness.transportConfigured === true) {
    return (
      <Banner tone="var(--color-pass)" testid="delivery-active">
        <strong>Alerting is active.</strong> Channels, routing, and the email transport are all configured —
        routed alerts will be delivered.
      </Banner>
    );
  }
  if (readiness.transportConfigured === false) {
    return (
      <Banner tone="var(--color-warn)" testid="delivery-not-configured">
        <strong>Transport not configured.</strong>{" "}
        {readiness.detail || "The ACS email transport isn't set up, so alerts won't be delivered until ops configures it."}
      </Banner>
    );
  }
  // transportConfigured === null → config is ready but the transport is UNVERIFIABLE
  // here (it lives on the runner). Honest: don't claim "active" OR "won't deliver".
  return (
    <Banner tone="var(--color-border-strong)" testid="delivery-transport-unknown" muted>
      Channels and routing are configured.{" "}
      {readiness.detail || "Email delivery depends on the ACS transport configured in infrastructure — the dashboard can't verify that from here."}
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
