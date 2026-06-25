"use client";

/**
 * Flow / spec selector for the New-monitor form — a real combobox (typeable input + a listbox of
 * options), replacing the old native <input list> + <datalist> whose option text rendered as a
 * disconnected floating popover. Each option shows the flow NAME and its DESCRIPTION inline (name +
 * subtext), so the choice is legible in the row itself.
 *
 * Options come from the SAME source the spec catalog uses (the Git manifest / spec_catalog) plus any
 * runner-baked flows — so a spec defined in Git but never run yet (e.g. recipe-nav) is selectable
 * immediately. Free text is preserved: typing a name that matches no option keeps the "type a new
 * one" affordance for genuinely-new flows.
 */

import { useId, useMemo, useRef, useState } from "react";

export interface FlowComboOption {
  /** The flow identity written to flow_name (a spec's synthetic flowNameFor, or a baked flow name). */
  value: string;
  /** Inline description shown as the option's subtext. */
  description: string | null;
  /** "spec" = Git-manifest spec (spec-backed, fetched at run); "flow" = runner-baked flow module. */
  kind: "spec" | "flow";
  /** Suggested target URL (manifest target / flow entry hint) — prefilled if the field is empty. */
  entryUrl?: string | null;
  /** Spec-backed only: the manifest binding the form locks onto selection. */
  specPath?: string;
  sourceKey?: string;
  /** Optional human label (e.g. the spec's display name) shown beside the value. */
  secondary?: string | null;
}

const KIND_BADGE: Record<FlowComboOption["kind"], { label: string; tone: string }> = {
  spec: { label: "Git spec", tone: "var(--color-brand)" },
  flow: { label: "runner flow", tone: "var(--color-ink-faint)" },
};

export function FlowCombobox({
  value,
  options,
  onChange,
  onSelect,
  placeholder,
}: {
  value: string;
  options: FlowComboOption[];
  /** User typed free text (clears any spec binding upstream). */
  onChange: (text: string) => void;
  /** User chose an option (upstream sets flow_name + any spec binding). */
  onSelect: (opt: FlowComboOption) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Filter by a case-insensitive substring over value/secondary/description. When the input exactly
  // matches the current value (i.e. nothing freshly typed), show everything so the full list is
  // browsable after a pick.
  const q = value.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return options;
    const exact = options.some((o) => o.value.toLowerCase() === q);
    if (exact) return options;
    return options.filter((o) =>
      [o.value, o.secondary ?? "", o.description ?? ""].some((s) => s.toLowerCase().includes(q)),
    );
  }, [options, q]);

  const visible = open && filtered.length > 0;

  function choose(opt: FlowComboOption) {
    onSelect(opt);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      if (visible && filtered[active]) {
        e.preventDefault();
        choose(filtered[active]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="relative">
      <input
        className="sw-input"
        role="combobox"
        aria-expanded={visible}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={visible ? `${listId}-opt-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        data-testid="flow-combobox-input"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Defer so an option's onMouseDown/click lands before we close.
          blurTimer.current = setTimeout(() => setOpen(false), 120);
        }}
      />
      <span aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-[var(--color-ink-faint)]">
        ▾
      </span>

      {visible && (
        <ul
          id={listId}
          role="listbox"
          data-testid="flow-combobox-list"
          className="sw-panel absolute z-20 mt-1 max-h-64 w-full overflow-auto py-1 shadow-[0_12px_40px_-16px_rgba(0,0,0,0.85)]"
          onMouseDown={(e) => {
            // Keep focus on the input (prevents the blur-close from racing the click).
            e.preventDefault();
            if (blurTimer.current) clearTimeout(blurTimer.current);
          }}
        >
          {filtered.map((opt, i) => {
            const badge = KIND_BADGE[opt.kind];
            const isActive = i === active;
            return (
              <li key={`${opt.kind}:${opt.value}`}>
                <button
                  type="button"
                  role="option"
                  id={`${listId}-opt-${i}`}
                  aria-selected={isActive}
                  data-testid={`flow-option-${opt.value}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(opt)}
                  className={`block w-full px-3 py-2 text-left transition ${
                    isActive ? "bg-[var(--color-panel-2)]" : "hover:bg-[var(--color-panel-2)]"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span className="sw-mono truncate text-[13px] font-medium text-[var(--color-ink)]">
                      {opt.value}
                    </span>
                    <span
                      className="sw-mono shrink-0 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider"
                      style={{
                        color: badge.tone,
                        background: `color-mix(in srgb, ${badge.tone} 12%, transparent)`,
                        border: `1px solid color-mix(in srgb, ${badge.tone} 30%, transparent)`,
                      }}
                    >
                      {badge.label}
                    </span>
                  </span>
                  {(opt.secondary || opt.description) && (
                    <span className="mt-0.5 block truncate text-[12px] text-[var(--color-ink-dim)]">
                      {opt.secondary ? <span className="text-[var(--color-ink)]">{opt.secondary}</span> : null}
                      {opt.secondary && opt.description ? " — " : null}
                      {opt.description}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
