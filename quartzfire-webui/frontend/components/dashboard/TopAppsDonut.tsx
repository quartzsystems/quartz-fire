"use client";

// Shared application-mix donut — the visual behind the dashboard's "Top
// Applications" tile and the Monitoring → Devices "Applications" panels. Kept
// in one place so every surface renders identically: same palette, same stable
// per-app color slotting, same hover + center readout + legend.
//
// Fed a generic slice list so callers can drive it from either App Control's
// live `top_apps` snapshot (dashboard + devices overall) or the windowed,
// per-client usage aggregation (a device's detail panel).

import { useEffect, useMemo, useRef, useState } from "react";
import { arcPath } from "@/lib/donut";
import { formatBytes } from "@/lib/format";

export interface AppSliceInput {
  /** Stable identity for color slotting (app_id, or the app name when that's
   *  all the source has). */
  id: string | number;
  name: string;
  bytes: number;
  /** Flow count for the legend tooltip, when the source provides it. */
  flows?: number | null;
}

/** Slices shown individually; the rest fold into "Other". */
const MAX_SLICES = 5;

// Categorical palette validated for the qz dark surface (#161920) — all-pairs
// CVD check passes with the 2px surface gaps + legend (see dataviz skill).
// Assigned per application in fixed order, never cycled.
const SLICE_COLORS = ["#3987e5", "#199e70", "#c98500", "#e66767", "#008300"];
const OTHER_COLOR = "var(--qz-ink-7)";

interface Slice {
  key: string;
  name: string;
  bytes: number;
  flows: number | null;
  pct: number;
  color: string;
}

/// Keep each application's color stable across refreshes: survivors keep their
/// slot, newcomers take the lowest freed slot (color follows the entity, not
/// its current rank).
function assignSlots(prev: Map<string, number>, apps: AppSliceInput[]): Map<string, number> {
  const next = new Map<string, number>();
  for (const a of apps) {
    const slot = prev.get(String(a.id));
    if (slot != null) next.set(String(a.id), slot);
  }
  const used = new Set(next.values());
  let free = 0;
  for (const a of apps) {
    if (next.has(String(a.id))) continue;
    while (used.has(free)) free++;
    next.set(String(a.id), free);
    used.add(free);
  }
  return next;
}

function Donut({
  slices,
  totalBytes,
  centerSub,
  hover,
  onHover,
}: {
  slices: Slice[];
  totalBytes: number;
  centerSub: string;
  hover: string | null;
  onHover: (key: string | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(160);

  // Scale the SVG to whatever column it lands in.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 0 && r.height > 0) setSize(Math.min(r.width, r.height));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const c = size / 2;
  const rOut = c - 2;
  const rIn = rOut * 0.62;

  let angle = 0;
  const segs = slices.map((s) => {
    const a0 = angle;
    angle += (s.bytes / totalBytes) * Math.PI * 2;
    return { s, a0, a1: angle };
  });

  const hovered = hover ? slices.find((s) => s.key === hover) : null;

  return (
    <div ref={wrapRef} className="relative h-full w-full grid place-items-center">
      <svg width={size} height={size} style={{ display: "block" }} role="img" aria-label="Applications by bytes">
        {segs.map(({ s, a0, a1 }) => (
          <path
            key={s.key}
            d={arcPath(c, c, rOut, rIn, a0, a1)}
            fill={s.color}
            opacity={hover == null || hover === s.key ? 1 : 0.45}
            stroke="var(--qz-surface)"
            strokeWidth={2}
            strokeLinejoin="round"
            onMouseEnter={() => onHover(s.key)}
            onMouseLeave={() => onHover(null)}
          >
            <title>{`${s.name} — ${formatBytes(s.bytes)} (${s.pct.toFixed(1)}%)`}</title>
          </path>
        ))}
      </svg>
      {/* Center readout: hovered slice, or the total. */}
      <div className="absolute inset-0 grid place-items-center pointer-events-none">
        <div className="text-center" style={{ maxWidth: rIn * 1.7 }}>
          <div className="text-[15px] font-bold text-[var(--qz-fg-1)] truncate" style={{ fontFamily: "var(--qz-font-mono)" }}>
            {hovered ? `${hovered.pct.toFixed(1)}%` : formatBytes(totalBytes)}
          </div>
          <div className="text-[10px] text-[var(--qz-fg-4)] truncate">{hovered ? hovered.name : centerSub}</div>
        </div>
      </div>
    </div>
  );
}

/// The full donut + legend. Callers pass the classified apps and (optionally)
/// the authoritative total; render their own header and empty states.
export function TopAppsDonut({
  apps,
  totalBytes,
  centerSub = "classified",
  minDonut = 130,
  maxDonut = 168,
}: {
  apps: AppSliceInput[];
  /** Authoritative total (e.g. App Control's `total_app_bytes`); defaults to
   *  the sum of `apps`. Drives the "Other" remainder and center figure. */
  totalBytes?: number;
  /** Sub-label under the center total when nothing is hovered. */
  centerSub?: string;
  /** Minimum donut size in px (the legend takes the rest / wraps). */
  minDonut?: number;
  /** Upper bound in px. Without one the donut is pure `flex-1` and swells to
   *  fill whatever column it lands in — compact in the page header's narrow
   *  sidebar, ballooned (with the legend stranded far right) in a device's
   *  full-width detail panel. Capping it keeps every instance the same size. */
  maxDonut?: number;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const slots = useRef(new Map<string, number>());

  const { slices, total } = useMemo(() => {
    const nonzero = apps.filter((a) => a.bytes > 0);
    const sum = nonzero.reduce((n, a) => n + a.bytes, 0);
    const total = totalBytes != null && totalBytes > 0 ? totalBytes : sum;
    if (!nonzero.length || total <= 0) return { slices: [] as Slice[], total: 0 };

    const shown = [...nonzero].sort((a, b) => b.bytes - a.bytes || String(a.id).localeCompare(String(b.id))).slice(0, MAX_SLICES);
    slots.current = assignSlots(slots.current, shown);
    const out: Slice[] = shown.map((a) => ({
      key: `app-${a.id}`,
      name: a.name,
      bytes: a.bytes,
      flows: a.flows ?? null,
      pct: (a.bytes / total) * 100,
      color: SLICE_COLORS[slots.current.get(String(a.id)) ?? 0],
    }));
    const rest = total - shown.reduce((n, a) => n + a.bytes, 0);
    if (rest > 0) {
      out.push({ key: "other", name: "Other", bytes: rest, flows: null, pct: (rest / total) * 100, color: OTHER_COLOR });
    }
    return { slices: out, total };
  }, [apps, totalBytes]);

  if (slices.length === 0) return null;

  return (
    <div className="flex flex-wrap items-stretch gap-4 min-h-0">
      <div className="flex-1" style={{ minWidth: minDonut, minHeight: minDonut, maxWidth: maxDonut, maxHeight: maxDonut }}>
        <Donut slices={slices} totalBytes={total} centerSub={centerSub} hover={hover} onHover={setHover} />
      </div>
      <div className="flex-1 min-w-[150px] flex flex-col justify-center gap-[6px] overflow-y-auto">
        {slices.map((s) => (
          <div
            key={s.key}
            className="flex items-center gap-[7px] text-[12px] rounded-md px-1"
            style={{ background: hover === s.key ? "color-mix(in oklab, white 5%, transparent)" : undefined }}
            onMouseEnter={() => setHover(s.key)}
            onMouseLeave={() => setHover(null)}
          >
            <span className="flex-shrink-0" style={{ width: 8, height: 8, borderRadius: 999, background: s.color }} />
            <span className="text-[var(--qz-fg-2)] truncate flex-1" title={s.flows != null ? `${s.name} — ${s.flows} flows` : s.name}>
              {s.name}
            </span>
            <span className="text-[var(--qz-fg-1)] font-semibold flex-shrink-0" style={{ fontFamily: "var(--qz-font-mono)" }}>
              {s.pct.toFixed(1)}%
            </span>
            <span className="text-[var(--qz-fg-4)] flex-shrink-0 w-[62px] text-right" style={{ fontFamily: "var(--qz-font-mono)" }}>
              {formatBytes(s.bytes)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
