import type { Tag } from "@/lib/types";

// Stable per-key color so the same key reads the same everywhere (env always one
// hue, service another, …). Suggested keys get fixed tones; others hash into the rest.
const KEY_TONE: Record<string, string> = {
  env: "var(--color-running)",
  service: "var(--color-brand)",
  team: "var(--color-warn)",
  criticality: "var(--color-fail)",
};
const PALETTE = [
  "var(--color-brand)",
  "var(--color-running)",
  "var(--color-warn)",
  "var(--color-pass)",
  "var(--color-fail)",
];

function toneFor(key: string): string {
  if (KEY_TONE[key]) return KEY_TONE[key];
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length] ?? "var(--color-brand)";
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
