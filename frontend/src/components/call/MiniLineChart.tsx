/**
 * MiniLineChart — small inline SVG line chart for the call demo.
 *
 * Reads as a clinical mini-trend: thin line, dotted baseline, optional
 * highlight markers (e.g. "video call days"). All colours come from
 * theme CSS variables so it adapts to whatever preset the user has on.
 *
 * Why a hand-rolled SVG instead of Recharts: Recharts is already in
 * the bundle for waveforms but it's heavyweight (multiple wrapper
 * components, ResponsiveContainer's resize observer, etc.) and the
 * call page already has rAF-driven content fighting for the main
 * thread. A 30-line SVG is more than enough for a 14-point trend
 * line, doesn't observe resizes (we're rendered inside a fixed-width
 * card), and doesn't add re-render cost when the user speaks.
 */

interface MiniLineChartProps {
  /** Y values, in display order. Length determines x-axis density. */
  data: number[];
  /** Optional x-axis labels, same length as data. Empty strings are
   *  rendered as gaps so callers can show only every Nth tick. */
  labels?: string[];
  /** Small uppercase caption rendered above the chart. */
  caption?: string;
  /** Y-axis unit appended to min/max labels (e.g. "ms", "bpm"). */
  unit?: string;
  /** Horizontal reference line (e.g. weekly average); dashed. */
  baseline?: number;
  /** Indices of points to mark with a coloured dot, e.g. days the
   *  user had a video call. Useful for "look — these dipped". */
  highlight?: number[];
}

const WIDTH = 380;
const HEIGHT = 110;
const PAD_TOP = 14;
const PAD_BOTTOM = 22;
const PAD_X = 10;

export function MiniLineChart({
  data,
  labels,
  caption,
  unit,
  baseline,
  highlight = [],
}: MiniLineChartProps) {
  if (data.length < 2) return null;

  const chartW = WIDTH - PAD_X * 2;
  const chartH = HEIGHT - PAD_TOP - PAD_BOTTOM;

  // Range includes the baseline so a reference line at the very edge
  // doesn't get clipped against the chart's top/bottom edge.
  const candidateMin = baseline !== undefined ? Math.min(...data, baseline) : Math.min(...data);
  const candidateMax = baseline !== undefined ? Math.max(...data, baseline) : Math.max(...data);
  // Add 8% headroom so the line doesn't kiss the box edges.
  const span = candidateMax - candidateMin || 1;
  const yMin = candidateMin - span * 0.08;
  const yMax = candidateMax + span * 0.08;
  const yRange = yMax - yMin;

  const xAt = (i: number) => PAD_X + (i / (data.length - 1)) * chartW;
  const yAt = (v: number) => PAD_TOP + (1 - (v - yMin) / yRange) * chartH;

  const path = data
    .map((v, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`)
    .join(' ');

  // Area-fill path for a soft tint under the line — same line + a
  // closing segment back to the baseline rectangle.
  const areaPath =
    `${path} L ${xAt(data.length - 1).toFixed(1)} ${(PAD_TOP + chartH).toFixed(1)} ` +
    `L ${xAt(0).toFixed(1)} ${(PAD_TOP + chartH).toFixed(1)} Z`;

  return (
    <div className="rounded-2xl border border-card-border bg-card-bg/60 px-4 py-3 max-w-[82%]">
      {caption && (
        <div className="flex items-center gap-2 mb-2 text-[10px] uppercase tracking-[0.22em] text-text-muted">
          <span aria-hidden>📈</span>
          <span>{caption}</span>
        </div>
      )}
      <svg
        width="100%"
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={caption ?? 'trend chart'}
      >
        <defs>
          <linearGradient id="mini-line-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(var(--color-accent))" stopOpacity="0.28" />
            <stop offset="100%" stopColor="rgb(var(--color-accent))" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Baseline reference */}
        {baseline !== undefined && (
          <line
            x1={PAD_X}
            x2={WIDTH - PAD_X}
            y1={yAt(baseline)}
            y2={yAt(baseline)}
            stroke="rgb(var(--color-text-muted) / 0.4)"
            strokeWidth={1}
            strokeDasharray="3 4"
          />
        )}

        {/* Soft fill under the line */}
        <path d={areaPath} fill="url(#mini-line-fill)" />

        {/* The line itself */}
        <path
          d={path}
          fill="none"
          stroke="rgb(var(--color-accent))"
          strokeWidth={1.8}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Highlight markers — overlaid on top so they're always visible */}
        {highlight.map((i) =>
          i >= 0 && i < data.length ? (
            <circle
              key={i}
              cx={xAt(i)}
              cy={yAt(data[i])}
              r={3.5}
              fill="rgb(var(--color-status-warning))"
              stroke="rgb(var(--color-card-bg))"
              strokeWidth={1.5}
            />
          ) : null,
        )}
      </svg>

      {labels && labels.length === data.length && (
        <div className="mt-1 flex justify-between text-[10px] text-text-muted font-mono">
          {labels.map((l, i) => (
            // Render every label slot but only show non-empty strings;
            // keeps labels evenly spaced even when only the endpoints
            // and a couple of mid-points are populated.
            <span key={i} className="min-w-0">
              {l}
            </span>
          ))}
        </div>
      )}

      {/* Y-axis range hint as a subtle footer; one line only so the
          panel stays compact. */}
      {(unit || baseline !== undefined) && (
        <div className="mt-1 flex justify-between text-[10px] text-text-muted/70 font-mono">
          <span>
            {candidateMin}
            {unit ? ` ${unit}` : ''}
          </span>
          {baseline !== undefined && (
            <span className="text-text-muted/50">
              avg {baseline}
              {unit ? ` ${unit}` : ''}
            </span>
          )}
          <span>
            {candidateMax}
            {unit ? ` ${unit}` : ''}
          </span>
        </div>
      )}
    </div>
  );
}
