import type { Tag } from "@/lib/types";

// A tag chip's hue comes from its KEY. The four SUGGESTED keys carry a fixed, intentional hue so they
// read consistently everywhere; EVERY other (arbitrary, user-defined) key is NEUTRAL.
//
// ★ Arbitrary tags must NOT reuse the status-law colors (pass-green / warn-amber / fail-red / running-blue).
// The old fallback HASHED each key into a palette that included those status colors, so a plain label like
// "wegmans" hashed to red and read as an error/alert — a false signal, not a real state. Keeping arbitrary
// tags neutral preserves the status colors' meaning (globals.css: "Status color law is absolute").
const KEY_TONE: Record<string, string> = {
  env: "var(--color-running)",
  service: "var(--color-brand)",
  team: "var(--color-warn)",
  criticality: "var(--color-fail)",
};
const NEUTRAL_TONE = "var(--color-ink-dim)";

function toneFor(key: string): string {
  return KEY_TONE[key] ?? NEUTRAL_TONE;
}

/** Small, subtle key:value tag chips. Renders nothing when there are no tags. */
export function TagChips({ tags, className = "" }: { tags: Tag[]; className?: string }) {
  if (!tags || tags.length === 0) return null;
  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`} data-testid="tag-chips">
      {tags.map((t) => {
        const tone = toneFor(t.key);
        return (
          <span
            key={`${t.key}:${t.value}`}
            className="sw-mono inline-flex items-center rounded text-[10px] leading-none"
            style={{
              border: `1px solid color-mix(in srgb, ${tone} 35%, transparent)`,
              background: `color-mix(in srgb, ${tone} 10%, transparent)`,
            }}
            title={`${t.key}: ${t.value}`}
          >
            <span className="px-1.5 py-0.5 text-[var(--color-ink-faint)]">{t.key}</span>
            <span
              className="px-1.5 py-0.5 font-medium"
              style={{ color: tone, borderLeft: `1px solid color-mix(in srgb, ${tone} 35%, transparent)` }}
            >
              {t.value}
            </span>
          </span>
        );
      })}
    </div>
  );
}
