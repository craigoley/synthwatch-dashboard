import type { RunStatus } from "@/lib/types";
import { runStatusMeta, type StatusMeta } from "@/lib/status";

const TONE_VAR: Record<StatusMeta["token"], string> = {
  pass: "var(--color-pass)",
  warn: "var(--color-warn)",
  fail: "var(--color-fail)",
  running: "var(--color-running)",
  idle: "var(--color-idle)",
};

export function StatusBadge({ status }: { status: RunStatus | null }) {
  const meta = runStatusMeta(status);
  return (
    <span className="sw-badge" style={{ ["--tone" as string]: TONE_VAR[meta.token] }}>
      <span className={`sw-dot ${meta.dotClass}`} />
      {meta.label}
    </span>
  );
}

export function ToneBadge({
  label,
  token,
}: {
  label: string;
  token: StatusMeta["token"];
}) {
  return (
    <span className="sw-badge" style={{ ["--tone" as string]: TONE_VAR[token] }}>
      {label}
    </span>
  );
}

export function StatusDot({ status }: { status: RunStatus | null }) {
  const meta = runStatusMeta(status);
  // ★ a11y: a bare colour dot conveys nothing to a screen reader (or a colourblind eye) — give it a
  // role + label so the status is announced, not just hover-titled.
  return <span role="img" aria-label={meta.label} className={`sw-dot ${meta.dotClass}`} title={meta.label} />;
}

export { TONE_VAR };
