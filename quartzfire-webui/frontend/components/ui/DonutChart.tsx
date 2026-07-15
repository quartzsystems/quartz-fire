"use client";

// Application-usage donut for Monitoring → Devices (combined at the top of the
// page and per-client in the detail panel). Fed by App Control's decision
// events, so it shows an explicit empty state when nothing is reporting rather
// than a blank circle. Self-contained inline SVG + a compact legend.

import { useMemo } from "react";
import { formatBytes } from "@/lib/format";

export interface DonutSlice {
  label: string;
  value: number;
  sub?: string;
}

interface DonutChartProps {
  slices: DonutSlice[];
  /** False → App Control isn't reporting; render the empty state. */
  available: boolean;
  /** Empty-state copy when there's simply no data yet. */
  emptyLabel?: string;
  size?: number;
  /** Collapse everything past this many slices into "Other". */
  maxSlices?: number;
}

// Categorical palette — distinct hues that hold up in light and dark themes.
const PALETTE = [
  "#22c55e",
  "#3b82f6",
  "#f59e0b",
  "#a855f7",
  "#ef4444",
  "#14b8a6",
  "#ec4899",
  "#84cc16",
];
const OTHER_COLOR = "var(--qz-fg-4)";

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

export function DonutChart({
  slices,
  available,
  emptyLabel = "No application data in this window.",
  size = 150,
  maxSlices = 7,
}: DonutChartProps) {
  const { arcs, total, legend } = useMemo(() => {
    const sorted = [...slices].filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
    const head = sorted.slice(0, maxSlices);
    const rest = sorted.slice(maxSlices);
    const restTotal = rest.reduce((n, s) => n + s.value, 0);
    const shown: (DonutSlice & { color: string })[] = head.map((s, i) => ({
      ...s,
      color: PALETTE[i % PALETTE.length],
    }));
    if (restTotal > 0) {
      shown.push({ label: "Other", value: restTotal, color: OTHER_COLOR });
    }
    const sum = shown.reduce((n, s) => n + s.value, 0);
    return { arcs: shown, total: sum, legend: shown };
  }, [slices, maxSlices]);

  if (!available || total === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center text-center px-3"
        style={{ minHeight: size }}
      >
        <div
          className="rounded-full mb-3"
          style={{
            width: size * 0.5,
            height: size * 0.5,
            border: "6px solid var(--qz-border)",
          }}
        />
        <p className="text-[12px] text-[var(--qz-fg-4)] m-0 max-w-[200px]">
          {available ? emptyLabel : "App Control isn’t reporting yet."}
        </p>
      </div>
    );
  }

  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 2;
  const ir = r * 0.58;

  let angle = 0;
  const segments = arcs.map((s) => {
    const frac = s.value / total;
    const start = angle * 360;
    const end = (angle + frac) * 360;
    angle += frac;
    // A single full-circle slice can't be drawn as one arc; nudge it.
    const sweep = end - start >= 360 ? 359.999 : end - start;
    const [x0o, y0o] = polar(cx, cy, r, start);
    const [x1o, y1o] = polar(cx, cy, r, start + sweep);
    const [x1i, y1i] = polar(cx, cy, ir, start + sweep);
    const [x0i, y0i] = polar(cx, cy, ir, start);
    const large = sweep > 180 ? 1 : 0;
    const d = `M${x0o},${y0o} A${r},${r} 0 ${large} 1 ${x1o},${y1o} L${x1i},${y1i} A${ir},${ir} 0 ${large} 0 ${x0i},${y0i} Z`;
    return { d, color: s.color, label: s.label };
  });

  return (
    <div className="flex items-center gap-4 flex-wrap">
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" className="flex-shrink-0">
        {segments.map((seg, i) => (
          <path key={i} d={seg.d} fill={seg.color} stroke="var(--qz-bg)" strokeWidth={1}>
            <title>{seg.label}</title>
          </path>
        ))}
      </svg>
      <ul className="m-0 p-0 list-none flex flex-col gap-[6px] min-w-[150px] flex-1">
        {legend.map((s) => (
          <li key={s.label} className="flex items-center gap-2 text-[12px]">
            <span
              className="inline-block rounded-[2px] flex-shrink-0"
              style={{ width: 10, height: 10, background: s.color }}
            />
            <span className="text-[var(--qz-fg-2)] truncate flex-1" title={s.label}>
              {s.label}
            </span>
            <span className="text-[var(--qz-fg-4)] tabular-nums">{formatBytes(s.value)}</span>
            <span className="text-[var(--qz-fg-4)] tabular-nums w-[38px] text-right">
              {((s.value / total) * 100).toFixed(0)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
