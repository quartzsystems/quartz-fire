"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { Tabs } from "@/components/ui/Tabs";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import {
  LdpAdjacency,
  LdpBinding,
  LdpNeighbor,
  MplsRoute,
  MplsStatus,
  fetchMplsBindings,
  fetchMplsStatus,
  fetchMplsTable,
} from "@/lib/mpls-status";

const REFRESH_MS = 5000;

type View = "neighbors" | "discovery" | "bindings" | "table";

const dash = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === "" ? "—" : String(v);

const pillStyle = {
  fontFamily: "var(--qz-font-mono)",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
} as const;

function statePill(state: string | null) {
  if (state && state.toLowerCase() === "operational") return "label label-success";
  return "label";
}

const neighborCols: Column<LdpNeighbor>[] = [
  { key: "neighbor_id", header: "Neighbor", value: (r) => r.neighbor_id ?? "", render: (r) => dash(r.neighbor_id), mono: true, sortable: true },
  { key: "af", header: "AF", value: (r) => r.address_family ?? "", render: (r) => dash(r.address_family), mono: true, width: 90 },
  { key: "state", header: "State", value: (r) => r.state ?? "", render: (r) => <span className={statePill(r.state)} style={pillStyle}>{dash(r.state)}</span>, sortable: true, width: 150 },
  { key: "transport", header: "Transport", value: (r) => r.transport_address ?? "", render: (r) => dash(r.transport_address), mono: true, width: 160 },
  { key: "uptime", header: "Uptime", value: (r) => r.uptime ?? "", render: (r) => dash(r.uptime), mono: true, width: 120 },
];

const discoveryCols: Column<LdpAdjacency>[] = [
  { key: "af", header: "AF", value: (r) => r.address_family ?? "", render: (r) => dash(r.address_family), mono: true, width: 90 },
  { key: "interface", header: "Interface", value: (r) => r.interface ?? "", render: (r) => dash(r.interface), mono: true, sortable: true },
  { key: "neighbor_id", header: "Neighbor", value: (r) => r.neighbor_id ?? "", render: (r) => dash(r.neighbor_id), mono: true },
  { key: "source", header: "Source", value: (r) => r.source ?? "", render: (r) => dash(r.source), mono: true },
  { key: "hold_time", header: "Holdtime", value: (r) => r.hold_time ?? -1, render: (r) => dash(r.hold_time), mono: true, width: 110 },
];

const bindingCols: Column<LdpBinding>[] = [
  { key: "prefix", header: "Prefix (FEC)", value: (r) => r.prefix ?? "", render: (r) => dash(r.prefix), mono: true, sortable: true },
  { key: "local", header: "Local label", value: (r) => r.local_label ?? "", render: (r) => dash(r.local_label), mono: true, width: 120 },
  { key: "remote", header: "Remote label", value: (r) => r.remote_label ?? "", render: (r) => dash(r.remote_label), mono: true, width: 120 },
  { key: "neighbor_id", header: "Neighbor", value: (r) => r.neighbor_id ?? "", render: (r) => dash(r.neighbor_id), mono: true },
  { key: "in_use", header: "In use", value: (r) => (r.in_use ? "yes" : "no"), render: (r) => (r.in_use ? <span className="label label-success" style={pillStyle}>In use</span> : <span style={{ color: "var(--cds-alias-typography-color-200)" }}>—</span>), width: 100 },
];

const tableCols: Column<MplsRoute>[] = [
  { key: "in_label", header: "In label", value: (r) => Number(r.in_label) || 0, render: (r) => dash(r.in_label), mono: true, sortable: true, width: 110 },
  { key: "out_label", header: "Out label", value: (r) => r.out_label ?? "", render: (r) => dash(r.out_label), mono: true, width: 120 },
  { key: "nexthop", header: "Next hop", value: (r) => r.nexthop ?? "", render: (r) => dash(r.nexthop), mono: true, sortable: true },
  { key: "interface", header: "Interface", value: (r) => r.interface ?? "", render: (r) => dash(r.interface), mono: true, width: 130 },
  { key: "installed", header: "Installed", value: (r) => (r.installed ? "yes" : "no"), render: (r) => (r.installed ? <span className="label label-success" style={pillStyle}>Installed</span> : <span className="label" style={pillStyle}>Pending</span>), width: 120 },
];

export function MplsStatusPanel() {
  const [status, setStatus] = useState<MplsStatus | null>(null);
  const [bindings, setBindings] = useState<LdpBinding[]>([]);
  const [table, setTable] = useState<MplsRoute[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [view, setView] = useState<View>("neighbors");
  const busy = useRef(false);

  const load = useCallback(async (mode: "load" | "poll" = "load") => {
    if (busy.current) return;
    busy.current = true;
    if (mode === "load") setPhase("loading");
    try {
      const [s, b, t] = await Promise.all([
        fetchMplsStatus(),
        fetchMplsBindings().catch(() => []),
        fetchMplsTable().catch(() => []),
      ]);
      setStatus(s);
      setBindings(b);
      setTable(t);
      setLastUpdated(new Date());
      setPhase("ready");
    } catch (e) {
      if (mode === "load") {
        setErrorMsg(e instanceof Error ? e.message : "Failed to load MPLS status.");
        setPhase("error");
      }
    } finally {
      busy.current = false;
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

  if (phase === "loading") {
    return <div className="clr-secondary">Loading MPLS status…</div>;
  }
  if (phase === "error") {
    return (
      <div className="flex flex-col gap-3">
        <div className="alert alert-danger alert-sm">
          <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
          <div className="alert-text">{errorMsg}</div>
        </div>
        <div><Button kind="secondary" icon="refresh" onClick={() => load()}>Retry</Button></div>
      </div>
    );
  }

  if (!status?.ldp_running && bindings.length === 0 && table.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex justify-end">
          <Button kind="secondary" size="sm" icon="refresh" onClick={() => load("poll")}>Refresh</Button>
        </div>
        <div className="card" style={{ marginTop: 0 }}>
          <div className="card-block clr-secondary" style={{ padding: 24, textAlign: "center" }}>
            LDP is not running, and the MPLS forwarding table is empty. Enable MPLS/LDP in the Configuration tab.
          </div>
        </div>
      </div>
    );
  }

  const subTabs: [View, string, number][] = [
    ["neighbors", "LDP Neighbors", status?.neighbors.length ?? 0],
    ["discovery", "Discovery", status?.discovery.length ?? 0],
    ["bindings", "Label Bindings", bindings.length],
    ["table", "Forwarding", table.length],
  ];

  return (
    <div className="flex flex-col gap-4">
      <Tabs
        items={subTabs.map(([id, label, count]) => ({ value: id, label, count }))}
        value={view}
        onChange={(v) => setView(v as View)}
        trailing={
          <>
            {lastUpdated && <span className="clr-secondary">Updated {lastUpdated.toLocaleTimeString()}</span>}
            <Button kind="secondary" size="sm" icon="refresh" onClick={() => load("poll")}>Refresh</Button>
          </>
        }
      />

      {view === "neighbors" && (
        <DataTable rows={status?.neighbors ?? []} columns={neighborCols} rowId={(r) => `${r.neighbor_id}-${r.address_family}`} storageKey="routing-mpls-neighbors" searchPlaceholder="Search neighbors…" emptyMessage="No LDP neighbors." />
      )}
      {view === "discovery" && (
        <DataTable rows={status?.discovery ?? []} columns={discoveryCols} rowId={(r) => `${r.interface}-${r.neighbor_id}-${r.address_family}`} storageKey="routing-mpls-discovery" searchPlaceholder="Search adjacencies…" emptyMessage="No hello adjacencies." />
      )}
      {view === "bindings" && (
        <DataTable rows={bindings} columns={bindingCols} rowId={(r) => `${r.prefix}-${r.neighbor_id}-${r.local_label}-${r.remote_label}`} storageKey="routing-mpls-bindings" searchPlaceholder="Search prefixes…" emptyMessage="No label bindings." />
      )}
      {view === "table" && (
        <DataTable rows={table} columns={tableCols} rowId={(r) => `${r.in_label}-${r.nexthop}-${r.interface}`} storageKey="routing-mpls-table" searchPlaceholder="Search labels…" emptyMessage="No MPLS forwarding entries." />
      )}
    </div>
  );
}
