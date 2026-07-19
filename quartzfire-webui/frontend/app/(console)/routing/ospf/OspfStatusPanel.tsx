"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { formatUptime } from "@/lib/bgp-status";
import {
  OspfInterfaceState,
  OspfNeighborState,
  OspfSummary,
  fetchOspfSummary,
} from "@/lib/ospf-status";

const REFRESH_MS = 5000;

const dash = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === "" ? "—" : String(v);

/// State → badge. `Full` (adjacency complete) is healthy; the transient states
/// (Init, 2-Way, ExStart, Exchange, Loading) are "working on it"; Down is bad.
function stateBadge(state: string) {
  const s = state.toLowerCase();
  if (s.startsWith("full")) return "badge badge-ok";
  if (s.startsWith("down")) return "badge badge-crit";
  return "badge badge-muted";
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg p-4 flex flex-col gap-1" style={{ background: "var(--qz-surface)", border: "1px solid var(--qz-border)" }}>
      <span className="text-[11px] uppercase tracking-wider text-[var(--qz-fg-4)]">{label}</span>
      <span className="text-[20px] font-semibold text-[var(--qz-fg-1)]" style={{ fontFamily: "var(--qz-font-mono)" }}>{value}</span>
      {sub && <span className="text-[11px] text-[var(--qz-fg-4)]">{sub}</span>}
    </div>
  );
}

function neighborColumns(): Column<OspfNeighborState>[] {
  return [
    { key: "neighbor_id", header: "Router ID", value: (r) => r.neighbor_id, mono: true, sortable: true, width: 130 },
    { key: "address", header: "Address", value: (r) => r.address ?? "", render: (r) => dash(r.address), mono: true, width: 130 },
    { key: "interface", header: "Interface", value: (r) => r.interface ?? "", render: (r) => dash(r.interface), mono: true, sortable: true },
    {
      key: "state",
      header: "State",
      value: (r) => r.state,
      render: (r) => <span className={stateBadge(r.state)}>{r.state}</span>,
      sortable: true,
      width: 140,
    },
    { key: "priority", header: "Priority", value: (r) => r.priority ?? -1, render: (r) => dash(r.priority), mono: true, width: 90 },
    { key: "dead", header: "Dead", value: (r) => r.dead_time_secs ?? -1, render: (r) => (r.dead_time_secs == null ? "—" : `${r.dead_time_secs}s`), mono: true, width: 90 },
    { key: "uptime", header: "Uptime", value: (r) => r.uptime_secs ?? 0, render: (r) => formatUptime(r.uptime_secs), mono: true, sortable: true, width: 100 },
  ];
}

function interfaceColumns(): Column<OspfInterfaceState>[] {
  return [
    { key: "name", header: "Interface", value: (r) => r.name, mono: true, sortable: true, width: 130 },
    { key: "area", header: "Area", value: (r) => r.area ?? "", render: (r) => dash(r.area), mono: true, width: 110 },
    { key: "state", header: "State", value: (r) => r.state ?? "", render: (r) => dash(r.state), mono: true, sortable: true, width: 120 },
    { key: "cost", header: "Cost", value: (r) => r.cost ?? -1, render: (r) => dash(r.cost), mono: true, width: 80 },
    { key: "network_type", header: "Network", value: (r) => r.network_type ?? "", render: (r) => dash(r.network_type), mono: true, width: 130 },
    { key: "nbrs", header: "Neighbors", value: (r) => r.neighbor_count ?? -1, render: (r) => dash(r.neighbor_count), mono: true, width: 100 },
    {
      key: "passive",
      header: "Passive",
      value: (r) => (r.passive ? "yes" : "no"),
      render: (r) => (r.passive ? <span className="badge badge-muted">passive</span> : <span className="text-[var(--qz-fg-4)]">—</span>),
      width: 100,
    },
  ];
}

export function OspfStatusPanel() {
  const [summary, setSummary] = useState<OspfSummary | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const refreshing = useRef(false);

  const load = useCallback(async (mode: "load" | "poll" = "load") => {
    if (refreshing.current) return;
    refreshing.current = true;
    if (mode === "load") setStatus("loading");
    try {
      const s = await fetchOspfSummary();
      setSummary(s);
      setLastUpdated(new Date());
      setStatus("ready");
    } catch (e) {
      if (mode === "load") {
        setErrorMsg(e instanceof Error ? e.message : "Failed to load OSPF status.");
        setStatus("error");
      }
    } finally {
      refreshing.current = false;
    }
  }, []);

  useEffect(() => {
    load();
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      load("poll");
    };
    const id = window.setInterval(tick, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);

  if (status === "loading") {
    return <div className="text-[13px] text-[var(--qz-fg-4)]">Loading OSPF status…</div>;
  }
  if (status === "error") {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-[13px] text-[var(--qz-danger)]">
          <AlertTriangle size={15} /> {errorMsg}
        </div>
        <div>
          <Button kind="secondary" icon={RotateCw} onClick={() => load()}>Retry</Button>
        </div>
      </div>
    );
  }

  const fullNeighbors = summary?.neighbors.filter((n) => n.is_up).length ?? 0;
  const totalNeighbors = summary?.neighbors.length ?? 0;
  const running = summary?.running ?? false;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 flex-1 min-w-[280px]">
          <StatTile label="Router ID" value={dash(summary?.router_id)} sub="operational value" />
          <StatTile label="Areas" value={String(summary?.areas.length ?? 0)} />
          <StatTile label="Adjacencies" value={`${fullNeighbors}/${totalNeighbors}`} sub="full / total" />
        </div>
        <div className="flex flex-col items-end gap-2">
          {lastUpdated && <span className="text-[12px] text-[var(--qz-fg-4)]">Updated {lastUpdated.toLocaleTimeString()}</span>}
          <Button kind="secondary" size="sm" icon={RotateCw} onClick={() => load("poll")}>Refresh</Button>
        </div>
      </div>

      {!running ? (
        <div className="rounded-lg p-6 text-center text-[13px] text-[var(--qz-fg-4)]" style={{ background: "var(--qz-surface)", border: "1px solid var(--qz-border)" }}>
          OSPF is not running (ospfd reports no router-id).
        </div>
      ) : (
        <>
          {summary!.areas.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {summary!.areas.map((a) => (
                <div key={a.area} className="rounded-lg p-4 flex flex-col gap-1" style={{ background: "var(--qz-surface)", border: "1px solid var(--qz-border)" }}>
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-[var(--qz-fg-1)]" style={{ fontFamily: "var(--qz-font-mono)" }}>{a.area}</span>
                    {a.backbone && <span className="badge badge-info">backbone</span>}
                  </div>
                  <span className="text-[11px] text-[var(--qz-fg-4)]">
                    {dash(a.interfaces_active)}/{dash(a.interfaces_total)} interfaces active · {dash(a.neighbors_full)} full
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <h3 className="text-[14px] font-semibold text-[var(--qz-fg-1)] m-0">Neighbors</h3>
            <DataTable
              rows={summary!.neighbors}
              columns={neighborColumns()}
              rowId={(r) => `${r.neighbor_id}-${r.interface ?? ""}`}
              storageKey="routing-ospf-status-neighbors"
              searchPlaceholder="Search neighbors…"
              emptyMessage="No OSPF adjacencies."
            />
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-[14px] font-semibold text-[var(--qz-fg-1)] m-0">Interfaces</h3>
            <DataTable
              rows={summary!.interfaces}
              columns={interfaceColumns()}
              rowId={(r) => r.name}
              storageKey="routing-ospf-status-interfaces"
              searchPlaceholder="Search interfaces…"
              emptyMessage="No OSPF interfaces."
            />
          </div>
        </>
      )}
    </div>
  );
}
