"use client";

// Live latency chart for the Monitoring → Devices ping tool. Plots one point
// per echo request as it streams back (see backend ping_stream): replies join
// into a latency line, lost packets show as a marker on the baseline. The x
// domain is fixed to the full burst (1…count) so the axis doesn't jump around
// while points arrive one at a time. Hovering a packet reveals its exact
// round-trip. Self-contained inline SVG, theme-token colored — matches
// UsageChart's conventions.

import { useState } from "react";

export interface PingPoint {
  seq: number;
  /** Round-trip in ms, or null for a lost packet. */
  ms: number | null;
}

const LINE = "var(--qz-accent)";
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

export function PingChart({
  points,
  count,
  height = 190,
}: {
  points: PingPoint[];
  /** Total packets in the burst — fixes the x-axis span. */
  count: number;
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const W = 820;
  const H = height;
  const padL = 56;
  const padR = 14;
  const padT = 12;
  const padB = 40;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

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
  // X ticks: every packet when the burst is short, else a thinned-out set.
  const xStep = count <= 12 ? 1 : Math.ceil(count / 10);
  const xTicks: number[] = [];
  for (let s = 1; s <= count; s += xStep) xTicks.push(s);
  if (xTicks[xTicks.length - 1] !== count) xTicks.push(count);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full block"
      style={{ height: H }}
      role="img"
      aria-label="Ping latency by packet"
      onMouseLeave={() => setHover(null)}
    >
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
              {f === 0 ? "0" : ms.toFixed(ms < 10 ? 1 : 0)}
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
      {hover != null && (
        <line x1={x(hover)} x2={x(hover)} y1={padT} y2={baseY} stroke="var(--qz-fg-4)" strokeWidth={1} strokeDasharray="3 3" />
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

      {/* invisible per-packet hit columns for hover */}
      {Array.from({ length: count }, (_, i) => i + 1).map((s) => {
        const half = innerW / denom / 2 || innerW / 2;
        const left = Math.max(padL, x(s) - half);
        const right = Math.min(W - padR, x(s) + half);
        return (
          <rect
            key={s}
            x={left}
            y={padT}
            width={Math.max(right - left, 1)}
            height={innerH + padB - padT}
            fill="transparent"
            onMouseEnter={() => setHover(s)}
          />
        );
      })}

      {/* tooltip */}
      {hoverPt && (
        <g transform={`translate(${x(hoverPt.seq)} ${hoverPt.ms != null ? y(hoverPt.ms) : baseY})`}>
          <g transform="translate(0 -12)">
            <rect x={-46} y={-16} width={92} height={20} rx={4} fill="var(--qz-ink-8, #0b0d12)" stroke="var(--qz-border)" strokeWidth={1} />
            <text x={0} y={-2} textAnchor="middle" fontSize={11} fill="var(--qz-fg-1)">
              {hoverPt.ms != null ? `#${hoverPt.seq} · ${hoverPt.ms.toFixed(2)} ms` : `#${hoverPt.seq} · timeout`}
            </text>
          </g>
        </g>
      )}
    </svg>
  );
}
