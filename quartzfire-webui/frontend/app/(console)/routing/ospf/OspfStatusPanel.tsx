"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
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

const pillStyle = {
  fontFamily: "var(--qz-font-mono)",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
} as const;

/// State → pill. `Full` (adjacency complete) is healthy; the transient states
/// (Init, 2-Way, ExStart, Exchange, Loading) are "working on it"; Down is bad.
function statePill(state: string) {
  const s = state.toLowerCase();
  if (s.startsWith("full")) return "label label-success";
  if (s.startsWith("down")) return "label label-danger";
  return "label";
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card" style={{ marginTop: 0 }}>
      <div className="card-block flex flex-col gap-1">
        <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--cds-alias-typography-color-200)" }}>{label}</span>
        <span style={{ fontSize: 20, fontWeight: 600, fontFamily: "var(--qz-font-mono)", color: "var(--cds-alias-typography-color-450)" }}>{value}</span>
        {sub && <span className="clr-subtext" style={{ marginTop: 0 }}>{sub}</span>}
      </div>
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
      render: (r) => <span className={statePill(r.state)} style={pillStyle}>{r.state}</span>,
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
      render: (r) => (r.passive ? <span className="label" style={pillStyle}>passive</span> : <span style={{ color: "var(--cds-alias-typography-color-200)" }}>—</span>),
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
    return <div className="clr-secondary">Loading OSPF status…</div>;
  }
  if (status === "error") {
    return (
      <div className="flex flex-col gap-3">
        <div className="alert alert-danger alert-sm">
          <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
          <div className="alert-text">{errorMsg}</div>
        </div>
        <div>
          <Button kind="secondary" icon="refresh" onClick={() => load()}>Retry</Button>
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
          {lastUpdated && <span className="clr-secondary">Updated {lastUpdated.toLocaleTimeString()}</span>}
          <Button kind="secondary" size="sm" icon="refresh" onClick={() => load("poll")}>Refresh</Button>
        </div>
      </div>

      {!running ? (
        <div className="card" style={{ marginTop: 0 }}>
          <div className="card-block clr-secondary" style={{ padding: 24, textAlign: "center" }}>
            OSPF is not running (ospfd reports no router-id).
          </div>
        </div>
      ) : (
        <>
          {summary!.areas.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {summary!.areas.map((a) => (
                <div key={a.area} className="card" style={{ marginTop: 0 }}>
                  <div className="card-block flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span style={{ fontSize: 13, fontWeight: 600, fontFamily: "var(--qz-font-mono)", color: "var(--cds-alias-typography-color-450)" }}>{a.area}</span>
                      {a.backbone && <span className="label label-info" style={pillStyle}>backbone</span>}
                    </div>
                    <span className="clr-subtext" style={{ marginTop: 0 }}>
                      {dash(a.interfaces_active)}/{dash(a.interfaces_total)} interfaces active · {dash(a.neighbors_full)} full
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <h3 className="clr-section" style={{ margin: 0, color: "var(--cds-alias-typography-color-450)" }}>Neighbors</h3>
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
            <h3 className="clr-section" style={{ margin: 0, color: "var(--cds-alias-typography-color-450)" }}>Interfaces</h3>
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
