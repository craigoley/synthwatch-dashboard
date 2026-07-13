import type { Metadata } from "next";
import Link from "next/link";

/**
 * The 2am glossary (Diátaxis REFERENCE). An on-call engineer opens the dashboard at 2am and hits words —
 * "flap", "spurious-red", "flake budget" — that the UI never defines. This is the one page that does, in the
 * OPERATOR's language ("recovered on recheck", not "superseded_by_run_id"). One definition each, linked from
 * the trust legend. Static server component — no data, no auth; it's a dictionary.
 */

export const metadata: Metadata = {
  title: "Glossary — SynthWatch",
  description: "What the trust + monitoring terms mean, in plain language.",
};

type Term = { id: string; term: string; short: string; body: React.ReactNode };

const TERMS: Term[] = [
  {
    id: "trust-chip",
    term: "Trust chip",
    short: "The one-word verdict on whether you can trust a monitor.",
    body: (
      <>
        <p>
          A monitor being green tells you the last run passed. The <strong>trust chip</strong> tells you whether
          that green is <em>trustworthy</em> — computed by the platform from named rules (spelled out in the
          Trust legend), never a made-up score. Four states:
        </p>
        <ul className="mt-2 space-y-1">
          <li><strong>Proven live</strong> — green recently, and clean on every axis. You can rely on it.</li>
          <li><strong>Nominal</strong> — green is going stale, or one axis is elevated. Worth a glance, not yet a problem.</li>
          <li><strong>Flaky</strong> — one axis crossed the line; the chip names which (flap / retry / monitor-noise / spurious-red). The monitor’s signal is noisy.</li>
          <li><strong>Unverified</strong> — never been green, or hasn’t run yet. Unproven — <em>not</em> broken.</li>
        </ul>
      </>
    ),
  },
  {
    id: "flap",
    term: "Flap",
    short: "A failure that recovered on recheck — it didn’t count.",
    body: (
      <p>
        A run that <strong>failed, then passed on an automatic recheck</strong> moments later. Because it
        recovered on its own, it did <em>not</em> count as an outage. A high <strong>flap rate</strong> means the
        monitor (or the site) is jittery — flapping a lot is noise you want to chase down, but it is not downtime.
        The platform surfaces flaps precisely so a self-healed failure is <em>acknowledged</em>, never silently
        swallowed.
      </p>
    ),
  },
  {
    id: "retry",
    term: "Retry (degrading-but-green)",
    short: "Passed, but only after more than one attempt.",
    body: (
      <p>
        A run that needed <strong>more than one try</strong> to pass. The monitor is still green, but a rising
        retry rate is an <strong>early warning</strong> — “degrading but green.” It never demotes the trust chip
        on its own; it’s a heads-up that something is getting slower or flakier before it actually breaks.
      </p>
    ),
  },
  {
    id: "transient",
    term: "Transient — monitor-side vs service-side",
    short: "Whose fault the flap was: the monitor’s, or the site’s.",
    body: (
      <>
        <p>A <strong>transient</strong> is a failure that recovered on recheck (a flap). Whose fault it was matters:</p>
        <ul className="mt-2 space-y-1">
          <li>
            <strong>Service-side</strong> — the site really had a brief blip and the monitor <em>caught</em> it.
            The monitor told the truth. This is a <em>good</em> monitor doing its job — it is never held against it.
          </li>
          <li>
            <strong>Monitor-side</strong> — the <em>monitor itself</em> was flaky (a brittle selector, a timing
            race) while the site was fine. This is the monitor <em>crying wolf</em>. Only this counts against a
            monitor’s trust.
          </li>
        </ul>
        <p className="mt-2">
          The split is shown as <span className="sw-mono">Nm / Ns / Ni</span> — monitor-side / service-side /
          indeterminate (not yet classified).
        </p>
      </>
    ),
  },
  {
    id: "spurious-red",
    term: "Spurious-red",
    short: "How often this monitor cried wolf (its own fault).",
    body: (
      <p>
        The rate of <strong>monitor-side</strong> transients — how often a monitor went red for a reason that
        turned out to be <em>its own</em> fault (a flaky selector, a race), not the site being down. A red the
        monitor correctly caught (a real service blip) <em>never</em> counts here — a monitor is never penalised
        for the site being flaky. Spurious-red is only measurable for monitors that capture error signals
        (browser/multistep flows); for simple http/dns/ssl checks it isn’t applicable.
      </p>
    ),
  },
  {
    id: "flake-budget",
    term: "Flake budget & directed task",
    short: "How much crying-wolf a monitor gets before it’s “degraded as a monitor.”",
    body: (
      <p>
        Every monitor is allowed a small amount of <strong>monitor-side</strong> flakiness — by default 2% of its
        runs. Burn through that <strong>flake budget</strong> and the monitor is flagged
        <strong> “degraded as a monitor.”</strong> Read that carefully: it’s a <em>monitor</em> problem, not a
        site outage — the fix is to the check, never a mute. When it trips, the platform issues a
        <strong> directed task</strong> — a specific instruction (e.g. “stabilise the add-to-cart selector”) that
        tells you <em>what to fix</em>, not just that something is wrong.
      </p>
    ),
  },
  {
    id: "error-diff",
    term: "Error diff",
    short: "On a red run, what errors are NEW since the last few runs.",
    body: (
      <p>
        When a monitor goes red, the <strong>error diff</strong> answers <em>“what changed?”</em> — the JS / API /
        page errors that weren’t there on the recent good runs. <strong>First-party</strong> errors (your own
        site’s) lead; third-party tracker noise is tucked behind a toggle so it can’t drown the signal. A new
        first-party error that first appeared right after a deploy is your prime suspect.
      </p>
    ),
  },
];

export default function GlossaryPage() {
  return (
    <div className="mx-auto max-w-3xl" data-testid="glossary">
      <div className="mb-6">
        <Link href="/reports?tab=trust" className="text-[12px] text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]">
          ← Back to Trust
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-[var(--color-ink)]">Glossary</h1>
        <p className="mt-1 text-[13px] text-[var(--color-ink-dim)]">
          What the trust &amp; monitoring words mean — in plain language, for when a monitor is red at 2am.
        </p>
      </div>

      <dl className="space-y-3">
        {TERMS.map((t) => (
          <div key={t.id} id={t.id} className="sw-panel scroll-mt-20 p-4" data-testid={`glossary-term-${t.id}`}>
            <dt className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm font-semibold text-[var(--color-ink)]">{t.term}</span>
              <span className="text-[12px] text-[var(--color-ink-faint)]">{t.short}</span>
            </dt>
            <dd className="mt-2 text-[13px] leading-relaxed text-[var(--color-ink-dim)]">{t.body}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
