"use client";

import { useMemo } from "react";
import { formatBytes } from "@/lib/format";
import { useInterfaceStats } from "./useInterfaceStats";

// Clarity: traffic charts use greens only — download/RX solid, upload/TX light.
const RX_COLOR = "#00d992";
const TX_COLOR = "#7be8c4";

/// Short interface-type label derived from the name prefix.
function ifaceType(name: string): string {
  const n = name.toLowerCase();
  if (n.includes(".")) return "VLAN";
  if (n.startsWith("eth")) return "ETH";
  if (n.startsWith("lo")) return "LO";
  if (n.startsWith("wg")) return "WG";
  if (n.startsWith("bond")) return "BOND";
  if (n.startsWith("br")) return "BR";
  if (n.startsWith("vxlan")) return "VXLAN";
  if (n.startsWith("vtun") || n.startsWith("tun")) return "TUN";
  if (n.startsWith("vti")) return "VTI";
  if (n.startsWith("wlan")) return "WLAN";
  if (n.startsWith("pppoe") || n.startsWith("ppp")) return "PPP";
  if (n.startsWith("gre")) return "GRE";
  return "IF";
}

function Bar({ value, max, color, up }: { value: number; max: number; color: string; up: boolean }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      {/* Raw ↓/↑ glyphs per the DC reference. */}
      <span className="shrink-0 text-[10px]" style={{ color }}>
        {up ? "↑" : "↓"}
      </span>
      <div
        className="flex-1 h-[5px] overflow-hidden min-w-0"
        style={{ background: "var(--cds-alias-object-container-background-shade)" }}
      >
        <div className="h-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span
        className="w-[72px] text-right text-[12px] text-[var(--cds-alias-typography-color-300)]"
        style={{ fontFamily: "var(--qz-font-mono)" }}
      >
        {formatBytes(value)}
      </span>
    </div>
  );
}

export function InterfaceStatsTile() {
  const { stats, error } = useInterfaceStats(5_000, true);

  const max = useMemo(
    () => (stats ? Math.max(1, ...stats.flatMap((s) => [s.rx_bytes ?? 0, s.tx_bytes ?? 0])) : 0),
    [stats],
  );

  // DC anatomy: a plain name-sorted list — no filter, sort, or pause controls.
  const rows = useMemo(
    () => (stats ? [...stats].sort((a, b) => a.name.localeCompare(b.name)) : []),
    [stats],
  );

  return (
    <>
      <div className="card-header flex-shrink-0">
        Interface Statistics
        <span
          className="ml-auto text-[12px]"
          style={{ fontWeight: 400, color: "var(--cds-alias-typography-color-200)" }}
        >
          totals since boot
        </span>
      </div>

      <div className="card-block flex-1 min-h-0 flex flex-col">
        {!stats && !error && (
          <div className="text-[13px] text-[var(--cds-alias-typography-color-200)]">Loading interface statistics…</div>
        )}
        {error && !stats && (
          <div className="text-[13px]" style={{ color: "var(--cds-alias-status-danger)" }}>
            {error}
          </div>
        )}

        {stats && (
          <div className="flex-1 overflow-auto">
            {rows.map((s) => {
              const type = ifaceType(s.name);
              return (
                <div
                  key={s.name}
                  className="flex items-center gap-[10px] py-[7px]"
                  style={{ borderTop: "1px solid var(--cds-alias-object-border-subtle)" }}
                >
                  <div
                    className="w-[52px] shrink-0 text-[12px] font-semibold text-[var(--cds-alias-typography-color-450)]"
                    style={{ fontFamily: "var(--qz-font-mono)" }}
                  >
                    {s.name}
                  </div>
                  <span className="label shrink-0" style={{ fontFamily: "var(--qz-font-mono)", fontSize: 10 }}>
                    {type}
                  </span>
                  <div className="flex-1 flex flex-col gap-[4px] min-w-0">
                    <Bar value={s.rx_bytes ?? 0} max={max} color={RX_COLOR} up={false} />
                    <Bar value={s.tx_bytes ?? 0} max={max} color={TX_COLOR} up />
                  </div>
                </div>
              );
            })}
            {rows.length === 0 && (
              <div className="py-3 text-[12px] text-[var(--cds-alias-typography-color-200)]">No interfaces match.</div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
