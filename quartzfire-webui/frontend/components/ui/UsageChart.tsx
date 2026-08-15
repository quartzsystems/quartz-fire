"use client";

// Throughput-over-time chart used by Monitoring → Devices, both for the
// all-clients header graph and each client's detail panel. It plots the usage
// buckets the backend sums as download and upload rates — the same two series,
// colors, and hover as the dashboard's Network Usage tile, so the two read the
// same way. Self-contained inline SVG drawn at measured pixel size.

import { useMemo, useState } from "react";
import { formatRate } from "@/lib/format";
import { ChartTooltip, DOWN_COLOR, UP_COLOR } from "./ChartTooltip";
import { useChartSize } from "./useChartSize";

export interface UsagePoint {
  ts: number;
  bytes_in: number;
  bytes_out: number;
}

interface UsageChartProps {
  points: UsagePoint[];
  /** Full window in seconds, so the x-axis spans the whole period (like the
   *  reference), not just the range that happened to have traffic. */
  windowSecs: number;
  /** The box's clock when it produced `points` (unix seconds).
   *
   *  The axis must be laid out against the same clock that stamped the buckets
   *  and chose the window cutoff. Using the browser's clock instead breaks two
   *  ways when the two disagree — which they do on any box whose time drifts,
   *  and by an hour on a DST/timezone misconfiguration:
   *
   *    * buckets outside the browser's idea of the window are never drawn, yet
   *      the backend still counts them in the totals shown beside the chart —
   *      so the graph reads far lower than the figure above it, and
   *    * the trailing bucket's divisor is `now - ts`, which goes negative or
   *      tiny against a skewed clock and floors at MIN_DIVISOR_SECS, inflating
   *      a full bucket's rate by up to 10x into a spike that never happened.
   *
   *  Falls back to the browser clock only if the backend didn't say. */
  nowSecs?: number;
  bucketSecs?: number;
  height?: number;
}

/** The collector's own resolution (conntrack snapshot cadence). Dividing a
 *  freshly-rolled bucket by less than this turns a few stray bytes into a
 *  nonsense spike, so it floors the in-progress bucket's divisor. */
const MIN_DIVISOR_SECS = 30;

/** Nice time tick label for the given window. */
function tickLabel(ts: number, windowSecs: number): string {
  const d = new Date(ts * 1000);
  if (windowSecs <= 24 * 3600) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Precise label for the hovered bucket. */
function hoverLabel(ts: number, windowSecs: number): string {
  const d = new Date(ts * 1000);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return windowSecs <= 24 * 3600
    ? time
    : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

interface Bucket {
  ts: number;
  down: number;
  up: number;
}

export function UsageChart({ points, windowSecs, nowSecs, bucketSecs = 300, height = 200 }: UsageChartProps) {
  const { ref, width } = useChartSize(640);
  const [hover, setHover] = useState<number | null>(null);

  const W = width;
  const H = height;
  const padR = 12;
  const padT = 12;
  const padB = 26;

  const { series, maxRate, t0, t1 } = useMemo(() => {
    // Densify to a continuous timeline over the full window so gaps read as
    // zero (buckets with no traffic are simply absent from `points`).
    const now = nowSecs ?? Math.floor(Date.now() / 1000);
    const end = now - (now % bucketSecs);
    const start = end - Math.ceil(windowSecs / bucketSecs) * bucketSecs;
    const byTs = new Map(points.map((p) => [p.ts - (p.ts % bucketSecs), p]));
    const out: Bucket[] = [];
    let max = 0;
    for (let ts = start; ts <= end; ts += bucketSecs) {
      const p = byTs.get(ts);
      // The newest bucket is still filling: divide by the seconds that have
      // actually elapsed in it, not the full width, or live traffic reads low
      // and then ramps as the bucket closes. `elapsed` is clamped into the
      // bucket so a clock that slipped can't divide a full bucket by a sliver
      // and manufacture a spike.
      const elapsed = Math.min(bucketSecs, Math.max(0, now - ts));
      const complete = ts + bucketSecs <= now;
      const divisor = complete ? bucketSecs : Math.max(MIN_DIVISOR_SECS, elapsed);
      const down = (p?.bytes_in ?? 0) / divisor;
      const up = (p?.bytes_out ?? 0) / divisor;
      out.push({ ts, down, up });
      max = Math.max(max, down, up);
    }
    return { series: out, maxRate: max || 1, t0: start, t1: end };
  }, [points, windowSecs, nowSecs, bucketSecs]);

  // 4 horizontal gridlines with rate labels.
  const yTicks = [0, 1 / 3, 2 / 3, 1].map((f) => ({ f, label: f === 0 ? "0" : formatRate(maxRate * f) }));

  // Size the left gutter to the widest tick label instead of a fixed width: the
  // labels are right-anchored at `padL - LABEL_GAP`, so a long one ("85.49
  // Mbps") ran off the left edge of the SVG and got clipped. 11px text averages
  // ~6.2px/char here, and the ~2px slack keeps it honest for wide glyphs.
  const LABEL_GAP = 8;
  const labelPx = Math.max(...yTicks.map((t) => t.label.length)) * 6.2 + 2;
  const padL = Math.ceil(labelPx) + LABEL_GAP;

  const innerW = Math.max(1, W - padL - padR);
  const innerH = Math.max(1, H - padT - padB);

  const n = series.length;
  const x = (ts: number) => padL + ((ts - t0) / (t1 - t0 || 1)) * innerW;
  const y = (rate: number) => padT + innerH - (rate / maxRate) * innerH;

  // Two overlaid bands, each measured from the baseline — so the download line
  // is download and the upload line is upload (a stack would make the upper
  // line read as the total).
  const downPts = series.map((p) => [x(p.ts), y(p.down)] as const);
  const upPts = series.map((p) => [x(p.ts), y(p.up)] as const);

  const line = (pts: readonly (readonly [number, number])[]) =>
    pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");

  const baseY = y(0);
  const area = (pts: readonly (readonly [number, number])[]) =>
    pts.length < 2 ? "" : `${line(pts)} L${x(t1).toFixed(1)},${baseY} L${x(t0).toFixed(1)},${baseY} Z`;

  // ~5 evenly spaced time ticks (fewer when the chart is narrow).
  const xTickCount = Math.max(2, Math.min(5, Math.floor(innerW / 90)));
  const xTicks = Array.from({ length: xTickCount }, (_, i) => {
    const ts = t0 + ((t1 - t0) * i) / (xTickCount - 1);
    return { ts, x: x(ts) };
  });

  const hasData = series.some((p) => p.down + p.up > 0);

  const onMove = (e: React.MouseEvent) => {
    if (!ref.current || n < 2) return;
    const px = e.clientX - ref.current.getBoundingClientRect().left;
    const f = (px - padL) / innerW;
    setHover(Math.min(n - 1, Math.max(0, Math.round(f * (n - 1)))));
  };

  const hoverPt = hover != null ? series[hover] : null;
  const hoverX = hoverPt ? x(hoverPt.ts) : null;

  return (
    <div
      ref={ref}
      className="relative w-full"
      style={{ height: H }}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      <svg width={W} height={H} style={{ display: "block" }} role="img" aria-label="Network usage over time">
        {/* gridlines + y labels */}
        {yTicks.map(({ f, label }) => {
          const yy = padT + innerH - f * innerH;
          return (
            <g key={f}>
              <line
                x1={padL}
                x2={W - padR}
                y1={yy}
                y2={yy}
                stroke="var(--cds-alias-object-border-subtle)"
                strokeWidth={1}
                strokeDasharray={f === 0 ? undefined : "3 3"}
              />
              <text x={padL - LABEL_GAP} y={yy} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="var(--cds-alias-typography-color-200)">
                {label}
              </text>
            </g>
          );
        })}

        {/* x labels */}
        {xTicks.map(({ ts, x: xx }, i) => (
          <text
            key={i}
            x={xx}
            y={H - 7}
            textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
            fontSize={11}
            fill="var(--cds-alias-typography-color-200)"
          >
            {tickLabel(ts, windowSecs)}
          </text>
        ))}

        {hasData && n > 1 && (
          <>
            <path d={area(downPts)} fill={DOWN_COLOR} fillOpacity={0.14} />
            <path d={area(upPts)} fill={UP_COLOR} fillOpacity={0.14} />
            <path d={line(downPts)} fill="none" stroke={DOWN_COLOR} strokeWidth={1.5} strokeLinejoin="round" />
            <path d={line(upPts)} fill="none" stroke={UP_COLOR} strokeWidth={1.5} strokeLinejoin="round" />
          </>
        )}
        {!hasData && (
          <text x={padL + innerW / 2} y={padT + innerH / 2} textAnchor="middle" fontSize={12} fill="var(--cds-alias-typography-color-200)">
            No traffic in this window
          </text>
        )}

        {hoverPt && hoverX != null && hasData && (
          <>
            <line
              x1={hoverX}
              x2={hoverX}
              y1={padT}
              y2={baseY}
              stroke="var(--cds-alias-typography-color-200)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            <circle cx={hoverX} cy={y(hoverPt.down)} r={3} fill={DOWN_COLOR} />
            <circle cx={hoverX} cy={y(hoverPt.up)} r={3} fill={UP_COLOR} />
          </>
        )}
      </svg>

      {hoverPt && hoverX != null && hasData && (
        <ChartTooltip
          x={hoverX}
          width={W}
          title={hoverLabel(hoverPt.ts, windowSecs)}
          rows={[
            { label: "Download", value: formatRate(hoverPt.down), color: DOWN_COLOR },
            { label: "Upload", value: formatRate(hoverPt.up), color: UP_COLOR },
          ]}
        />
      )}
    </div>
  );
}
