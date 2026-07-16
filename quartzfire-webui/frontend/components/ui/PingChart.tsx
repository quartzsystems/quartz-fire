"use client";

// Live latency chart for the Monitoring → Devices ping tool. Plots one point
// per echo request as it streams back (see backend ping_stream): replies join
// into a latency line, lost packets show as a marker on the baseline. The x
// domain is fixed to the full burst (1…count) so the axis doesn't jump around
// while points arrive one at a time. Hovering a packet reveals its exact
// round-trip. Self-contained inline SVG drawn at measured pixel size, sharing
// UsageChart's hover.

import { useState } from "react";
import { ChartTooltip, DOWN_COLOR } from "./ChartTooltip";
import { useChartSize } from "./useChartSize";

export interface PingPoint {
  seq: number;
  /** Round-trip in ms, or null for a lost packet. */
  ms: number | null;
}

const LINE = DOWN_COLOR;
const MISS = "var(--qz-danger)";

/** A "nice" upper bound for the y-axis: round the max latency up so the top
 *  gridline is a clean number and the line never touches the ceiling. */
function niceMax(v: number): number {
  if (v <= 0) return 10;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

/** Enough decimals that adjacent ticks never collapse to the same label — a
 *  sub-millisecond LAN ping otherwise renders as "0.2, 0.2, 0.1, 0.1, 0". */
function tickDecimals(step: number): number {
  if (step >= 10) return 0;
  if (step >= 1) return step % 1 === 0 ? 0 : 1;
  return Math.min(3, Math.max(1, Math.ceil(-Math.log10(step)) + 1));
}

export function PingChart({
  points,
  count,
  height = 240,
}: {
  points: PingPoint[];
  /** Total packets in the burst — fixes the x-axis span. */
  count: number;
  height?: number;
}) {
  const { ref, width } = useChartSize(640);
  const [hover, setHover] = useState<number | null>(null);

  const W = width;
  const H = height;
  const padL = 56;
  const padR = 14;
  const padT = 12;
  const padB = 40;
  const innerW = Math.max(1, W - padL - padR);
  const innerH = Math.max(1, H - padT - padB);

  const replies = points.filter((p): p is { seq: number; ms: number } => p.ms != null);
  const maxMs = niceMax(replies.reduce((m, p) => Math.max(m, p.ms), 0) || 10);

  // A single packet would divide by zero; keep it centered instead.
  const denom = Math.max(count - 1, 1);
  const x = (seq: number) => padL + ((seq - 1) / denom) * innerW;
  const y = (ms: number) => padT + innerH - (ms / maxMs) * innerH;
  const baseY = padT + innerH;

  const bySeq = new Map(points.map((p) => [p.seq, p]));
  const hoverPt = hover != null ? bySeq.get(hover) ?? null : null;

  // Connect consecutive replies; a lost packet breaks the line into segments.
  const segments: { seq: number; ms: number }[][] = [];
  let cur: { seq: number; ms: number }[] = [];
  for (let s = 1; s <= count; s++) {
    const p = bySeq.get(s);
    if (p && p.ms != null) cur.push({ seq: s, ms: p.ms });
    else if (cur.length) {
      segments.push(cur);
      cur = [];
    }
  }
  if (cur.length) segments.push(cur);

  const path = (seg: { seq: number; ms: number }[]) =>
    seg.map((p, i) => `${i ? "L" : "M"}${x(p.seq).toFixed(1)},${y(p.ms).toFixed(1)}`).join("");

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ f, ms: maxMs * f }));
  const yDecimals = tickDecimals(maxMs / 4);
  // X ticks: every packet when the burst is short, else a thinned-out set that
  // also respects how much room the chart actually has.
  const maxLabels = Math.max(2, Math.floor(innerW / 26));
  const xStep = Math.max(1, Math.ceil(count / Math.min(count, maxLabels)));
  const xTicks: number[] = [];
  for (let s = 1; s <= count; s += xStep) xTicks.push(s);
  if (xTicks[xTicks.length - 1] !== count) xTicks.push(count);

  const onMove = (e: React.MouseEvent) => {
    if (!ref.current || count < 1) return;
    const px = e.clientX - ref.current.getBoundingClientRect().left;
    const f = (px - padL) / innerW;
    setHover(Math.min(count, Math.max(1, Math.round(f * denom) + 1)));
  };

  const hoverX = hover != null ? x(hover) : null;

  return (
    <div
      ref={ref}
      className="relative w-full"
      style={{ height: H }}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      <svg width={W} height={H} style={{ display: "block" }} role="img" aria-label="Ping latency by packet">
        {/* y gridlines + labels */}
        {yTicks.map(({ f, ms }) => {
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
              <text x={padL - 8} y={yy} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="var(--qz-fg-4)">
                {f === 0 ? "0" : ms.toFixed(yDecimals)}
              </text>
            </g>
          );
        })}

        {/* y-axis title */}
        <text
          transform={`translate(14 ${padT + innerH / 2}) rotate(-90)`}
          textAnchor="middle"
          fontSize={11}
          fill="var(--qz-fg-3)"
        >
          Latency (ms)
        </text>

        {/* x ticks + labels */}
        {xTicks.map((s) => (
          <text key={s} x={x(s)} y={H - padB + 16} textAnchor="middle" fontSize={11} fill="var(--qz-fg-4)">
            {s}
          </text>
        ))}
        {/* x-axis title */}
        <text x={padL + innerW / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--qz-fg-3)">
          Packet
        </text>

        {/* hover guide */}
        {hoverX != null && (
          <line x1={hoverX} x2={hoverX} y1={padT} y2={baseY} stroke="var(--qz-fg-4)" strokeWidth={1} strokeDasharray="3 3" />
        )}

        {/* latency line */}
        {segments.map((seg, i) => (
          <path key={i} d={path(seg)} fill="none" stroke={LINE} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
        ))}

        {/* per-packet marks */}
        {points.map((p) =>
          p.ms == null ? (
            // lost packet — an ✕ on the baseline
            <g key={p.seq} stroke={MISS} strokeWidth={1.6}>
              <line x1={x(p.seq) - 3.5} y1={baseY - 3.5} x2={x(p.seq) + 3.5} y2={baseY + 3.5} />
              <line x1={x(p.seq) - 3.5} y1={baseY + 3.5} x2={x(p.seq) + 3.5} y2={baseY - 3.5} />
            </g>
          ) : (
            <circle
              key={p.seq}
              cx={x(p.seq)}
              cy={y(p.ms)}
              r={hover === p.seq ? 4 : 2.6}
              fill={LINE}
              stroke="var(--qz-surface)"
              strokeWidth={1}
            />
          ),
        )}
      </svg>

      {hoverPt && hoverX != null && (
        <ChartTooltip
          x={hoverX}
          width={W}
          title={`Packet ${hoverPt.seq}`}
          rows={[
            hoverPt.ms != null
              ? { label: "Latency", value: `${hoverPt.ms.toFixed(2)} ms`, color: LINE }
              : { label: "Timeout", value: "no reply", color: MISS },
          ]}
        />
      )}
    </div>
  );
}
