"use client";

// Throughput-over-time chart used by Monitoring → Devices, both for the
// all-clients header graph and each client's detail panel. It renders the same
// 5-minute usage buckets the backend already sums, as a stacked area (download
// + upload) with a rate y-axis and time x-axis — a richer take on the bare
// Sparkline. Self-contained inline SVG, theme-token colored.

import { useMemo } from "react";
import { formatRate } from "@/lib/format";

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
  bucketSecs?: number;
  height?: number;
}

const DOWN = "var(--qz-accent)";
const UP = "var(--qz-info)";

/** Nice time tick label for the given window. */
function tickLabel(ts: number, windowSecs: number): string {
  const d = new Date(ts * 1000);
  if (windowSecs <= 24 * 3600) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function UsageChart({
  points,
  windowSecs,
  bucketSecs = 300,
  height = 200,
}: UsageChartProps) {
  const W = 820;
  const H = height;
  const padL = 58;
  const padR = 10;
  const padT = 10;
  const padB = 24;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const { series, maxRate, t0, t1 } = useMemo(() => {
    // Densify to a continuous timeline over the full window so gaps read as
    // zero (buckets with no traffic are simply absent from `points`).
    const now = Math.floor(Date.now() / 1000);
    const end = now - (now % bucketSecs);
    const start = end - Math.ceil(windowSecs / bucketSecs) * bucketSecs;
    const byTs = new Map(points.map((p) => [p.ts - (p.ts % bucketSecs), p]));
    const out: UsagePoint[] = [];
    let max = 0;
    for (let ts = start; ts <= end; ts += bucketSecs) {
      const p = byTs.get(ts);
      const bin = p?.bytes_in ?? 0;
      const bout = p?.bytes_out ?? 0;
      out.push({ ts, bytes_in: bin, bytes_out: bout });
      max = Math.max(max, (bin + bout) / bucketSecs);
    }
    return { series: out, maxRate: max || 1, t0: start, t1: end };
  }, [points, windowSecs, bucketSecs]);

  const n = series.length;
  const x = (ts: number) => padL + ((ts - t0) / (t1 - t0 || 1)) * innerW;
  const y = (rate: number) => padT + innerH - (rate / maxRate) * innerH;

  // Two stacked bands: download from baseline, upload stacked above it.
  const downTop = series.map((p) => [x(p.ts), y(p.bytes_in / bucketSecs)] as const);
  const total = series.map(
    (p) => [x(p.ts), y((p.bytes_in + p.bytes_out) / bucketSecs)] as const,
  );

  const line = (pts: readonly (readonly [number, number])[]) =>
    pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");

  const baseY = y(0);
  const downArea = `${line(downTop)} L${x(t1).toFixed(1)},${baseY} L${x(t0).toFixed(1)},${baseY} Z`;
  const upArea = `${line(total)} ${downTop
    .slice()
    .reverse()
    .map(([px, py]) => `L${px.toFixed(1)},${py.toFixed(1)}`)
    .join("")} Z`;

  // 4 horizontal gridlines with rate labels.
  const yTicks = [0, 1 / 3, 2 / 3, 1].map((f) => ({ f, rate: maxRate * f }));
  // ~5 evenly spaced time ticks.
  const xTickCount = 5;
  const xTicks = Array.from({ length: xTickCount }, (_, i) => {
    const ts = t0 + ((t1 - t0) * i) / (xTickCount - 1);
    return { ts, x: x(ts) };
  });

  const hasData = maxRate > 1 || series.some((p) => p.bytes_in + p.bytes_out > 0);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full block" style={{ height: H }} role="img">
      {/* gridlines + y labels */}
      {yTicks.map(({ f, rate }) => {
        const yy = padT + innerH - f * innerH;
        return (
          <g key={f}>
            <line
              x1={padL}
              x2={W - padR}
              y1={yy}
              y2={yy}
              stroke="var(--qz-border)"
              strokeWidth={1}
              strokeDasharray={f === 0 ? undefined : "3 3"}
            />
            <text
              x={padL - 8}
              y={yy}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={11}
              fill="var(--qz-fg-4)"
            >
              {f === 0 ? "0" : formatRate(rate)}
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
          fill="var(--qz-fg-4)"
        >
          {tickLabel(ts, windowSecs)}
        </text>
      ))}

      {hasData && n > 1 && (
        <>
          <path d={upArea} fill={UP} fillOpacity={0.16} />
          <path d={downArea} fill={DOWN} fillOpacity={0.18} />
          <path d={line(total)} fill="none" stroke={UP} strokeWidth={1.3} strokeOpacity={0.7} />
          <path d={line(downTop)} fill="none" stroke={DOWN} strokeWidth={1.5} />
        </>
      )}
      {!hasData && (
        <text
          x={padL + innerW / 2}
          y={padT + innerH / 2}
          textAnchor="middle"
          fontSize={12}
          fill="var(--qz-fg-4)"
        >
          No traffic in this window
        </text>
      )}
    </svg>
  );
}
