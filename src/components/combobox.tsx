"use client";

/**
 * Generic string combobox — a typeable input + a styled listbox of suggestions, mirroring FlowCombobox's
 * house pattern (sw-panel dropdown, keyboard nav, click-away) but for plain string options. Replaces native
 * <input list>+<datalist>, whose options render as an unstyled browser popover that reads like a tooltip.
 *
 * Free-text is first-class: typing a value with no matching option is fully allowed (suggestions ASSIST, never
 * constrain). Honest-empty: when nothing matches the typed prefix, NO popover shows (not an empty box).
 */

import { useId, useMemo, useRef, useState } from "react";

export function Combobox({
  value,
  onChange,
  options,
  onEnter,
  placeholder,
  ariaLabel,
  testId,
  className = "sw-input sw-mono text-[13px]",
}: {
  value: string;
  /** Called on both typing AND picking an option (an option just sets the value). */
  onChange: (text: string) => void;
  /** Suggestion pool; filtered by the typed PREFIX (case-insensitive). */
  options: string[];
  /** Enter when no suggestion is highlighted (e.g. the parent's "add"). */
  onEnter?: () => void;
  placeholder?: string;
  ariaLabel?: string;
  testId?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const q = value.trim().toLowerCase();
  const filtered = useMemo(() => {
    // distinct, prefix-matched; a value that already equals an option still lists it (so it's browsable).
    const seen = new Set<string>();
    const out: string[] = [];
    for (const o of options) {
      if (!o || seen.has(o)) continue;
      seen.add(o);
      if (!q || o.toLowerCase().startsWith(q)) out.push(o);
    }
    return out;
  }, [options, q]);

  const visible = open && filtered.length > 0;

  function choose(opt: string) {
    onChange(opt);
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
        choose(filtered[active]); // pick the highlighted suggestion (fills the field, does NOT submit)
      } else {
        onEnter?.(); // no suggestion open → let the parent act (e.g. add the tag)
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="relative">
      <input
        className={className}
        role="combobox"
        aria-expanded={visible}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={visible ? `${listId}-opt-${active}` : undefined}
        aria-label={ariaLabel}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        data-testid={testId}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          blurTimer.current = setTimeout(() => setOpen(false), 120); // defer so an option click lands first
        }}
      />
      {visible && (
        <ul
          id={listId}
          role="listbox"
          data-testid={testId ? `${testId}-list` : undefined}
          className="sw-panel absolute z-20 mt-1 max-h-56 w-full min-w-[8rem] overflow-auto py-1 shadow-[0_12px_40px_-16px_rgba(0,0,0,0.85)]"
          onMouseDown={(e) => {
            e.preventDefault(); // keep focus on the input (blur-close must not race the click)
            if (blurTimer.current) clearTimeout(blurTimer.current);
          }}
        >
          {filtered.map((opt, i) => (
            <li key={opt}>
              <button
                type="button"
                role="option"
                id={`${listId}-opt-${i}`}
                aria-selected={i === active}
                data-testid={testId ? `${testId}-option-${opt}` : undefined}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(opt)}
                className={`sw-mono block w-full px-3 py-1.5 text-left text-[13px] transition ${
                  i === active ? "bg-[var(--color-panel-2)] text-[var(--color-ink)]" : "text-[var(--color-ink-dim)] hover:bg-[var(--color-panel-2)]"
                }`}
              >
                {opt}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
