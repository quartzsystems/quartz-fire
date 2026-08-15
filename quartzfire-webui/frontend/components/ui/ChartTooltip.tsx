"use client";

// Shared hover tooltip for the time-series charts — the dashboard's Network
// Usage tile, and Monitoring → Devices' usage and ping graphs. Keeping one
// component (and one pair of series colors) means a hover reads identically
// wherever it appears, instead of each chart drifting its own way.

export interface TooltipRow {
  label: string;
  /** Preformatted value — the chart owns its own units. */
  value: string;
  color: string;
}

/// Series colors for download vs upload. Shared so every usage chart agrees.
/// Clarity: traffic charts use greens only — blue is reserved for info states.
export const DOWN_COLOR = "#00d992"; // download / RX
export const UP_COLOR = "#7be8c4"; // upload / TX

const TIP_W = 150;

export function ChartTooltip({
  x,
  width,
  title,
  rows,
  top = 8,
}: {
  /** Cursor/anchor position in px within the chart wrapper. */
  x: number;
  /** Wrapper width in px, so the tip can flip before it overflows. */
  width: number;
  title: string;
  rows: TooltipRow[];
  top?: number;
}) {
  // Prefer the right of the anchor; flip left when that would run off the edge.
  const left = x + 10 + TIP_W > width ? Math.max(0, x - 10 - TIP_W) : x + 10;

  return (
    <div
      className="absolute pointer-events-none rounded-lg p-2 z-10 text-[11px]"
      style={{
        left,
        top,
        minWidth: TIP_W - 10,
        background: "var(--cds-alias-object-overlay-background)",
        border: "1px solid var(--cds-alias-object-border-color-shade)",
        boxShadow: "var(--cds-alias-object-shadow-200)",
      }}
    >
      <div className="text-[var(--cds-alias-typography-color-300)] mb-1" style={{ fontFamily: "var(--qz-font-mono)" }}>
        {title}
      </div>
      {rows.map((r, i) => (
        <div key={r.label} className="flex items-center justify-between gap-3" style={{ marginTop: i ? 3 : 0 }}>
          <span className="inline-flex items-center gap-[5px] text-[var(--cds-alias-typography-color-400)]">
            <span style={{ width: 7, height: 7, borderRadius: 999, background: r.color, flexShrink: 0 }} />
            {r.label}
          </span>
          <span className="text-[var(--cds-alias-typography-color-450)] font-semibold" style={{ fontFamily: "var(--qz-font-mono)" }}>
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}
