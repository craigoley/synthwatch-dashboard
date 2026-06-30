"use client";

import { useState } from "react";

import { getParseIntent } from "@/lib/api-client";
import type { Check } from "@/lib/types";

// ★ PREFILL not CREATE: this only parses text → opens the create modal prefilled. The human reviews + clicks
// Create. Single-shot — to redo, close the modal and retype. Browser asks get the "authored as code" redirect.
export function MonitorChatInput({
  onPrefill,
}: {
  onPrefill: (fields: Partial<Check>, fieldErrors: Record<string, string>) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "muted" | "error"; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await getParseIntent(t);
      if (!r.configured) {
        setMsg({ tone: "muted", text: r.note ?? "AI monitor-prefill isn’t configured in this environment." });
      } else if (r.redirect) {
        setMsg({
          tone: "muted",
          text: r.reason ?? "Browser monitors are authored as code in the monitors repo, then set up from the Catalog.",
        });
      } else if (r.note) {
        setMsg({ tone: "error", text: r.note }); // AOAI failure (honest transient / deterministic message)
      } else if (r.prefill) {
        onPrefill(r.prefill, r.fieldErrors); // open the create modal prefilled (validate-don't-trust errors included)
        setText("");
      }
    } catch {
      setMsg({ tone: "error", text: "Couldn’t reach the prefill service — please try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full">
      <div className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
          placeholder="Describe a monitor… e.g. “ping meals2go.com” or “ssl for https://wegmans.com”"
          aria-label="Describe a monitor to prefill"
          className="sw-input min-w-0 flex-1"
        />
        <button type="submit" disabled={busy || !text.trim()} className="sw-btn shrink-0">
          {busy ? "Parsing…" : "Prefill"}
        </button>
      </div>
      {msg && (
        <p
          className="mt-1.5 text-xs"
          style={{ color: msg.tone === "error" ? "var(--color-fail)" : "var(--color-ink-dim)" }}
        >
          {msg.text}
        </p>
      )}
    </form>
  );
}
