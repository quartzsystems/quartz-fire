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

/// State → pill. Operational is healthy; a down/torn-down session
/// (NONEXISTENT) is trouble; anything else stays neutral.
function statePill(state: string | null) {
  const s = (state ?? "").toLowerCase();
  if (s === "operational") return "label label-success";
  if (s === "nonexistent" || s === "down") return "label label-danger";
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
  { key: "local", header: "Local Label", value: (r) => r.local_label ?? "", render: (r) => dash(r.local_label), mono: true, width: 120 },
  { key: "remote", header: "Remote Label", value: (r) => r.remote_label ?? "", render: (r) => dash(r.remote_label), mono: true, width: 120 },
  { key: "neighbor_id", header: "Neighbor", value: (r) => r.neighbor_id ?? "", render: (r) => dash(r.neighbor_id), mono: true },
  { key: "in_use", header: "In Use", value: (r) => (r.in_use ? "yes" : "no"), render: (r) => (r.in_use ? <span className="label label-success" style={pillStyle}>In use</span> : <span style={{ color: "var(--cds-alias-typography-color-200)" }}>—</span>), width: 100 },
];

const tableCols: Column<MplsRoute>[] = [
  { key: "in_label", header: "In Label", value: (r) => Number(r.in_label) || 0, render: (r) => dash(r.in_label), mono: true, sortable: true, width: 110 },
  { key: "out_label", header: "Out Label", value: (r) => r.out_label ?? "", render: (r) => dash(r.out_label), mono: true, width: 120 },
  { key: "nexthop", header: "Next Hop", value: (r) => r.nexthop ?? "", render: (r) => dash(r.nexthop), mono: true, sortable: true },
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
            LDP is not running, and the MPLS forwarding table is empty. Enable MPLS/LDP in the Global tab.
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

  const operationalNeighbors = status?.neighbors.filter((n) => n.is_up).length ?? 0;
  const totalNeighbors = status?.neighbors.length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 flex-1 min-w-[280px]">
          <StatTile label="LDP Neighbors" value={`${operationalNeighbors}/${totalNeighbors}`} sub="operational / total" />
          <StatTile label="Label Bindings" value={String(bindings.length)} />
          <StatTile label="Forwarding Entries" value={String(table.length)} />
        </div>
        <div className="flex flex-col items-end gap-2">
          {lastUpdated && <span className="clr-secondary">Updated {lastUpdated.toLocaleTimeString()}</span>}
          <Button kind="secondary" size="sm" icon="refresh" onClick={() => load("poll")}>Refresh</Button>
        </div>
      </div>

      <Tabs
        items={subTabs.map(([id, label, count]) => ({ value: id, label, count }))}
        value={view}
        onChange={(v) => setView(v as View)}
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
