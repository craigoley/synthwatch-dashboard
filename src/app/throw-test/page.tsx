/**
 * Error-boundary self-test route. INERT by default — it only throws when explicitly asked with `?boom=1`,
 * and even then the worst a user sees is the recovery panel (no data, no side effects). Exists so the error
 * boundaries (app/error.tsx + global-error.tsx) have a deterministic, production-safe way to be exercised by
 * the e2e (the harness can't otherwise force a React render throw). Not linked from anywhere.
 */
export default async function ThrowTest({
  searchParams,
}: {
  searchParams: Promise<{ boom?: string }>;
}) {
  const { boom } = await searchParams;
  if (boom === "1") {
    throw new Error("Boundary self-test: forced render throw (?boom=1).");
  }
  return (
    <div className="sw-panel p-6 text-sm text-[var(--color-ink-dim)]">
      Error-boundary self-test route. Append <code className="sw-mono">?boom=1</code> to force a render throw
      and verify the recovery UI (the app shell + nav stay alive).
    </div>
  );
}
