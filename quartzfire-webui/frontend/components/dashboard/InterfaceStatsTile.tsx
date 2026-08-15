"use client";

import { useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { formatBytes } from "@/lib/format";
import { useInterfaceStats } from "./useInterfaceStats";
import { LiveButton } from "./LiveButton";

type SortKey = "name" | "rx" | "tx";

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
      <Icon shape="arrow" dir={up ? "up" : "down"} size={12} style={{ color }} className="shrink-0" />
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
  const [paused, setPaused] = useState(false);
  const { stats, error } = useInterfaceStats(5_000, !paused);
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [asc, setAsc] = useState(true);

  const max = useMemo(
    () => (stats ? Math.max(1, ...stats.flatMap((s) => [s.rx_bytes ?? 0, s.tx_bytes ?? 0])) : 0),
    [stats],
  );

  const rows = useMemo(() => {
    if (!stats) return [];
    const f = filter.trim().toLowerCase();
    const filtered = f ? stats.filter((s) => s.name.toLowerCase().includes(f)) : stats.slice();
    filtered.sort((a, b) => {
      const r =
        sortKey === "name"
          ? a.name.localeCompare(b.name)
          : sortKey === "rx"
            ? (a.rx_bytes ?? 0) - (b.rx_bytes ?? 0)
            : (a.tx_bytes ?? 0) - (b.tx_bytes ?? 0);
      return asc ? r : -r;
    });
    return filtered;
  }, [stats, filter, sortKey, asc]);

  // Switching key uses a sensible default direction (name ↑, RX/TX ↓); same key toggles.
  const setSort = (k: SortKey) => {
    if (sortKey === k) setAsc((a) => !a);
    else {
      setSortKey(k);
      setAsc(k === "name");
    }
  };
  const arrow = (k: SortKey) => (sortKey === k ? (asc ? "↑" : "↓") : "");

  return (
    <>
      <div className="card-header flex-shrink-0">
        Interface Statistics
        <span className="ml-auto flex items-center gap-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="clr-input"
            style={{ width: 96, height: 24, fontSize: 12, fontWeight: 400 }}
          />
          <LiveButton paused={paused} onToggle={() => setPaused((p) => !p)} />
        </span>
      </div>

      <div className="card-block flex-1 min-h-0 flex flex-col">
        <div className="flex items-center justify-between mb-2 flex-shrink-0">
          <div className="flex items-center gap-1 text-[11px]">
            <span className="text-[var(--cds-alias-typography-color-200)] mr-1">Sort:</span>
            {(["name", "rx", "tx"] as SortKey[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setSort(k)}
                className="px-2 py-[3px] rounded-md cursor-pointer font-medium transition-colors"
                style={
                  sortKey === k
                    ? { background: "var(--cds-alias-interaction-action)", color: "var(--qz-fg-on-accent)" }
                    : { background: "transparent", color: "var(--cds-alias-typography-color-300)" }
                }
              >
                {k === "name" ? "Name" : k.toUpperCase()} {arrow(k)}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-[var(--cds-alias-typography-color-200)]">
            {rows.length} interface{rows.length === 1 ? "" : "s"}
          </span>
        </div>

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
