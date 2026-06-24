"use client";

import type { ReactNode } from "react";

import { useNarrative } from "@/lib/client";
import { formatRelative } from "@/lib/format";
import type { NarrativeFact, ReportWindow } from "@/lib/types";

// ── tiny, dependency-free, XSS-SAFE markdown → React (no dangerouslySetInnerHTML;
// React escapes all text). Handles the narrative subset: paragraphs, bullet lists,
// **bold**, *italic*, `code`. Anything else renders as literal text.
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) {
      out.push(<code key={k++} className="sw-mono rounded bg-[var(--color-bg)] px-1 py-0.5 text-[0.92em]">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**")) {
      out.push(<strong key={k++} className="font-semibold text-[var(--color-ink)]">{tok.slice(2, -2)}</strong>);
    } else {
      out.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const blocks = text.trim().split(/\n{2,}/).filter(Boolean);
  return (
    <div className={`space-y-2 text-sm leading-relaxed text-[var(--color-ink-dim)] ${className}`} data-testid="narrative-body">
      {blocks.map((b, i) => {
        const lines = b.split("\n").filter((l) => l.trim() !== "");
        const isList = lines.length > 0 && lines.every((l) => /^\s*[-*]\s+/.test(l));
        if (isList) {
          return (
            <ul key={i} className="ml-4 list-disc space-y-1">
              {lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*[-*]\s+/, ""))}</li>)}
            </ul>
          );
        }
        return <p key={i}>{inline(b.replace(/\n/g, " "))}</p>;
      })}
    </div>
  );
}

function FactChips({ facts }: { facts: NarrativeFact[] }) {
  if (facts.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="narrative-facts">
      {facts.map((f, i) => (
        <span
          key={i}
          className="inline-flex items-baseline gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1"
          data-testid="narrative-fact"
          title={f.delta ? `${f.label}: ${f.value} (${f.delta})` : `${f.label}: ${f.value}`}
        >
          <span className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">{f.label}</span>
          <span className="sw-mono text-[12px] font-medium text-[var(--color-ink)]">{f.value}</span>
          {f.delta && <span className="sw-mono text-[11px] text-[var(--color-ink-dim)]">{f.delta}</span>}
        </span>
      ))}
    </div>
  );
}

/**
 * AI narrative summary (Layer 3). scope=fleet (full card atop the reports page) or
 * scope=monitor (compact, on a monitor's detail). ★ Renders the factPack cited numbers
 * beside the prose so a reader can VERIFY the claims, not just trust them. ★ HIDES
 * entirely when there's no narrative (404 / not generated) — never an error or empty box.
 */
export function NarrativeCard({
  scope,
  window,
  checkKey,
  compact = false,
}: {
  scope: "fleet" | "monitor";
  window: ReportWindow;
  checkKey?: number;
  compact?: boolean;
}) {
  const { data } = useNarrative(scope, window, scope === "monitor" ? (checkKey ?? null) : null);
  if (!data) return null; // loading or absent → hide (graceful)

  const when = data.generatedAt ? formatRelative(data.generatedAt) : null;

  if (compact) {
    return (
      <div
        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3"
        data-testid="narrative-card"
        data-scope="monitor"
      >
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="sw-eyebrow">Summary</span>
          {data.stale && <span className="sw-mono text-[10px] uppercase tracking-wider" style={{ color: "var(--color-warn)" }}>stale</span>}
        </div>
        <p className="mb-2 text-sm font-medium text-[var(--color-ink)]">{data.headline}</p>
        {data.body && <Markdown text={data.body} className="!text-[13px]" />}
        <div className="mt-2"><FactChips facts={data.factPack} /></div>
      </div>
    );
  }

  return (
    <section
      className="sw-panel space-y-3 p-4"
      data-testid="narrative-card"
      data-scope="fleet"
      style={{ borderColor: "color-mix(in srgb, var(--color-brand) 30%, var(--color-border))" }}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="sw-eyebrow" style={{ color: "var(--color-brand)" }}>AI summary</span>
          {data.stale && (
            <span className="sw-mono rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
              style={{ color: "var(--color-warn)", background: "color-mix(in srgb, var(--color-warn) 12%, transparent)" }}>
              stale — regenerating
            </span>
          )}
        </div>
        {when && <span className="sw-mono text-[10px] text-[var(--color-ink-faint)]">generated {when}</span>}
      </div>

      <h2 className="text-base font-semibold tracking-tight text-[var(--color-ink)]">{data.headline}</h2>

      {data.factPack.length > 0 && <FactChips facts={data.factPack} />}

      {data.body && <Markdown text={data.body} />}

      {data.highlights.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-[var(--color-border)] pt-3">
          {data.highlights.map((h, i) => (
            <span
              key={i}
              data-testid="narrative-highlight"
              className="sw-mono rounded-md px-2 py-1 text-[11px]"
              style={{
                color: "var(--color-brand)",
                background: "color-mix(in srgb, var(--color-brand) 10%, transparent)",
                border: "1px solid color-mix(in srgb, var(--color-brand) 30%, transparent)",
              }}
            >
              {h}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
