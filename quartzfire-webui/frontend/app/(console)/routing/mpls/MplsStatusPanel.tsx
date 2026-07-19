"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
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

function stateBadge(state: string | null) {
  if (state && state.toLowerCase() === "operational") return "badge badge-ok";
  return "badge badge-muted";
}

const neighborCols: Column<LdpNeighbor>[] = [
  { key: "neighbor_id", header: "Neighbor", value: (r) => r.neighbor_id ?? "", render: (r) => dash(r.neighbor_id), mono: true, sortable: true },
  { key: "af", header: "AF", value: (r) => r.address_family ?? "", render: (r) => dash(r.address_family), mono: true, width: 90 },
  { key: "state", header: "State", value: (r) => r.state ?? "", render: (r) => <span className={stateBadge(r.state)}>{dash(r.state)}</span>, sortable: true, width: 150 },
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
  { key: "in_use", header: "In use", value: (r) => (r.in_use ? "yes" : "no"), render: (r) => (r.in_use ? <span className="badge badge-ok">In use</span> : <span className="text-[var(--qz-fg-4)]">—</span>), width: 100 },
];

const tableCols: Column<MplsRoute>[] = [
  { key: "in_label", header: "In label", value: (r) => Number(r.in_label) || 0, render: (r) => dash(r.in_label), mono: true, sortable: true, width: 110 },
  { key: "out_label", header: "Out label", value: (r) => r.out_label ?? "", render: (r) => dash(r.out_label), mono: true, width: 120 },
  { key: "nexthop", header: "Next hop", value: (r) => r.nexthop ?? "", render: (r) => dash(r.nexthop), mono: true, sortable: true },
  { key: "interface", header: "Interface", value: (r) => r.interface ?? "", render: (r) => dash(r.interface), mono: true, width: 130 },
  { key: "installed", header: "Installed", value: (r) => (r.installed ? "yes" : "no"), render: (r) => (r.installed ? <span className="badge badge-ok">Installed</span> : <span className="badge badge-muted">Pending</span>), width: 120 },
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
    return <div className="text-[13px] text-[var(--qz-fg-4)]">Loading MPLS status…</div>;
  }
  if (phase === "error") {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-[13px] text-[var(--qz-danger)]">
          <AlertTriangle size={15} /> {errorMsg}
        </div>
        <div><Button kind="secondary" icon={RotateCw} onClick={() => load()}>Retry</Button></div>
      </div>
    );
  }

  if (!status?.ldp_running && bindings.length === 0 && table.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex justify-end">
          <Button kind="secondary" size="sm" icon={RotateCw} onClick={() => load("poll")}>Refresh</Button>
        </div>
        <div className="rounded-lg p-6 text-center text-[13px] text-[var(--qz-fg-4)]" style={{ background: "var(--qz-surface)", border: "1px solid var(--qz-border)" }}>
          LDP is not running, and the MPLS forwarding table is empty. Enable MPLS/LDP in the Configuration tab.
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
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-1">
          {subTabs.map(([id, label, count]) => {
            const active = view === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setView(id)}
                className={[
                  "px-3 py-[6px] text-[13px] rounded-md transition-colors cursor-pointer border-0",
                  active ? "text-[var(--qz-fg-on-accent)]" : "text-[var(--qz-fg-3)] hover:text-[var(--qz-fg-1)] bg-transparent",
                ].join(" ")}
                style={active ? { background: "var(--qz-accent)" } : undefined}
              >
                {label}
                <span className={active ? "ml-[6px] opacity-80" : "ml-[6px] text-[var(--qz-fg-4)]"}>{count}</span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-col items-end gap-2">
          {lastUpdated && <span className="text-[12px] text-[var(--qz-fg-4)]">Updated {lastUpdated.toLocaleTimeString()}</span>}
          <Button kind="secondary" size="sm" icon={RotateCw} onClick={() => load("poll")}>Refresh</Button>
        </div>
      </div>

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
