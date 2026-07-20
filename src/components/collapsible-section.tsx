"use client";

import type { ReactNode } from "react";

/**
 * A disclosure section for the monitors page (#280 a11y bar): a real <button> header with aria-expanded +
 * aria-controls, a chevron that ROTATES (a shape change, not a color change), and a "Show"/"Hide" text label —
 * so the expanded/collapsed state is never conveyed by color alone. Native <button> gives Enter/Space + focus.
 *
 * ★ The BODY collapses; the SIGNAL never does. `header` (the count / ⚠ warning) is ALWAYS rendered in the
 *   button, so a section pinned closed still announces new drift / new specs. The body uses the `hidden`
 *   attribute — it stays in the DOM (aria-controls points at a real element, screen readers can reach it) but
 *   is removed from the a11y tree + layout when collapsed.
 *
 * `id` doubles as the scroll anchor (the section element carries it) so /monitors?from=catalog can scroll here.
 */
export function CollapsibleSection({
  id,
  label,
  open,
  onToggle,
  header,
  subtitle,
  testId,
  children,
}: {
  id: string;
  /** aria-label for the <section> landmark. */
  label: string;
  open: boolean;
  onToggle: () => void;
  /** The always-visible signal (a count / ⚠ warning) — never hidden, even when collapsed. */
  header: ReactNode;
  /** The "what will I find if I click this?" line — matters most when collapsed. */
  subtitle?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  const bodyId = `${id}-body`;
  return (
    <section id={id} aria-label={label} data-testid={testId} className="scroll-mt-4">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        data-testid={testId ? `${testId}-toggle` : undefined}
        className="flex w-full items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-left transition hover:border-[var(--color-border-strong)]"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          aria-hidden="true"
          className="shrink-0 transition-transform text-[var(--color-ink-faint)]"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        >
          <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-[var(--color-ink)]">{header}</span>
          {subtitle && <span className="mt-0.5 block text-[11px] text-[var(--color-ink-dim)]">{subtitle}</span>}
        </span>
        {/* Text label — the affordance is glyph-rotation + this word, never color alone (#280). */}
        <span className="shrink-0 text-[11px] uppercase tracking-wider text-[var(--color-ink-faint)]">
          {open ? "Hide" : "Show"}
        </span>
      </button>
      <div id={bodyId} hidden={!open} className="pt-3">
        {children}
      </div>
    </section>
  );
}
