import type { SparkPoint } from "@/lib/types";
import { TONE_VAR } from "@/components/status-badge";

/**
 * Tiny inline-SVG sparkline of recent run durations (no chart library — keeps
 * the status grid light). Tone follows the most recent run's outcome. Failed /
 * errored runs (no duration) are marked as ticks along the baseline.
 */
export function Sparkline({
  points,
  width = 132,
  height = 34,
}: {
  points: SparkPoint[];
  width?: number;
  height?: number;
}) {
  const durations = points.map((p) => p.d);
  const numeric = durations.filter((d): d is number => typeof d === "number");

  if (points.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-[10px] text-[var(--color-ink-faint)]"
        style={{ width, height }}
      >
        no runs
      </div>
    );
  }

  const last = points[points.length - 1];
  const tone =
    last?.s === "fail" || last?.s === "error"
      ? TONE_VAR.fail
      : last?.s === "warn"
        ? TONE_VAR.warn
        : last?.s === "running"
          ? TONE_VAR.running
          : TONE_VAR.pass;

  const max = numeric.length ? Math.max(...numeric) : 1;
  const min = numeric.length ? Math.min(...numeric) : 0;
  const range = max - min || 1;
  const pad = 3;
  const innerH = height - pad * 2;
  const stepX = points.length > 1 ? width / (points.length - 1) : width;

  const coords = points.map((p, i) => {
    const x = i * stepX;
    const y =
      typeof p.d === "number"
        ? pad + innerH - ((p.d - min) / range) * innerH
        : null;
    return { x, y, p };
  });

  const linePts = coords.filter((c) => c.y !== null) as { x: number; y: number }[];
  const path = linePts.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const areaPath =
    linePts.length > 1
      ? `${path} L${linePts[linePts.length - 1]!.x.toFixed(1)},${height} L${linePts[0]!.x.toFixed(1)},${height} Z`
      : "";

  const gid = `spark-${tone.replace(/[^a-z0-9]/gi, "")}`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={tone} stopOpacity="0.28" />
          <stop offset="100%" stopColor={tone} stopOpacity="0" />
        </linearGradient>
      </defs>
      {areaPath && <path d={areaPath} fill={`url(#${gid})`} />}
      {linePts.length > 1 && (
        <path d={path} fill="none" stroke={tone} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      )}
      {/* failure ticks along the baseline */}
      {coords.map((c, i) =>
        c.p.s === "fail" || c.p.s === "error" ? (
          <line
            key={i}
            x1={c.x}
            x2={c.x}
            y1={height - 5}
            y2={height}
            stroke={TONE_VAR.fail}
            strokeWidth="1.5"
          />
        ) : null,
      )}
      {/* highlight the latest point */}
      {linePts.length > 0 && (
        <circle cx={linePts[linePts.length - 1]!.x} cy={linePts[linePts.length - 1]!.y} r="2" fill={tone} />
      )}
    </svg>
  );
}
