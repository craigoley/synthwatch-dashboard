/** Shared loading / empty / error placeholders. */

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 text-sm text-[var(--color-ink-dim)]">
      <span className="sw-spin h-4 w-4 rounded-full border-2 border-[var(--color-border-strong)] border-t-[var(--color-brand)]" />
      {label ?? "Loading…"}
      <style>{`.sw-spin{animation:sw-rot .7s linear infinite}@keyframes sw-rot{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

export function ErrorState({ message, testId }: { message: string; testId?: string }) {
  return (
    <div
      className="sw-panel p-5 text-sm"
      style={{
        borderColor: "color-mix(in srgb, var(--color-fail) 40%, transparent)",
        color: "var(--color-fail)",
      }}
      role="alert"
      data-testid={testId}
    >
      <span className="sw-mono text-xs tracking-wider">ERROR · </span>
      {message}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="sw-panel flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="text-sm font-medium text-[var(--color-ink)]">{title}</div>
      {hint && <div className="max-w-md text-sm text-[var(--color-ink-dim)]">{hint}</div>}
      {action}
    </div>
  );
}
