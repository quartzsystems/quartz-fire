"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Plus, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { RowActions } from "@/components/dashboard/RowActions";
import {
  ADDRESS_FAMILIES,
  AddressFamily,
  BgpConfig,
  BgpPeer,
  deleteBgpNeighbor,
  deleteBgpPeerGroup,
  fetchBgp,
} from "@/lib/bgp";
import { fetchInterfaceStats } from "@/lib/vyos";
import { fetchRouteMapNames } from "@/lib/routing-policy";
import { useDashboard } from "@/lib/DashboardContext";
import { BgpGlobalPanel } from "./BgpGlobalPanel";
import { PeerFormModal } from "./PeerFormModal";

type Section = "global" | "neighbors" | "peer-groups";

const AF_SHORT: Record<AddressFamily, string> = {
  "ipv4-unicast": "v4",
  "ipv6-unicast": "v6",
  "l2vpn-evpn": "EVPN",
};

const dash = (v: string | null) => (v && v.length ? v : "—");

function AfBadges({ peer }: { peer: BgpPeer }) {
  const active = ADDRESS_FAMILIES.filter((af) => peer.afi[af].enabled);
  if (active.length === 0) return <span className="text-[var(--qz-fg-4)]">—</span>;
  return (
    <span className="inline-flex gap-1">
      {active.map((af) => (
        <span key={af} className="badge badge-info">{AF_SHORT[af]}</span>
      ))}
    </span>
  );
}

function peerColumns(showPeerGroup: boolean): Column<BgpPeer>[] {
  const cols: Column<BgpPeer>[] = [
    {
      key: "name",
      header: showPeerGroup ? "Neighbor" : "Peer Group",
      value: (r) => r.name,
      render: (r) => (
        <span>
          {r.name}
          {r.is_interface && <span className="ml-[6px] badge badge-muted">unnumbered</span>}
        </span>
      ),
      mono: true,
      sortable: true,
    },
    { key: "remote_as", header: "Remote AS", value: (r) => r.remote_as ?? "", render: (r) => dash(r.remote_as), mono: true, sortable: true, width: 120 },
  ];
  if (showPeerGroup) {
    cols.push({ key: "peer_group", header: "Peer Group", value: (r) => r.peer_group ?? "", render: (r) => dash(r.peer_group), mono: true, sortable: true, width: 130 });
  }
  cols.push(
    { key: "update_source", header: "Update Source", value: (r) => r.update_source ?? "", render: (r) => dash(r.update_source), mono: true, width: 130 },
    { key: "afi", header: "Address Families", value: (r) => ADDRESS_FAMILIES.filter((af) => r.afi[af].enabled).join(","), render: (r) => <AfBadges peer={r} />, width: 160 },
    {
      key: "status",
      header: "Status",
      value: (r) => (r.enabled ? "enabled" : "shutdown"),
      render: (r) => <span className={r.enabled ? "badge badge-ok" : "badge badge-muted"}>{r.enabled ? "Enabled" : "Shutdown"}</span>,
      sortable: true,
      width: 110,
    },
  );
  return cols;
}

export default function BgpPage() {
  const { setToast } = useDashboard();
  const [cfg, setCfg] = useState<BgpConfig | null>(null);
  const [interfaces, setInterfaces] = useState<string[]>([]);
  const [routeMaps, setRouteMaps] = useState<string[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [section, setSection] = useState<Section>("global");

  // null = closed; { peer: undefined } = create; { peer } = edit.
  const [neighborModal, setNeighborModal] = useState<{ peer?: BgpPeer } | null>(null);
  const [groupModal, setGroupModal] = useState<{ peer?: BgpPeer } | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      const [bgp, ifs, rms] = await Promise.all([
        fetchBgp(),
        fetchInterfaceStats().catch(() => []),
        fetchRouteMapNames(),
      ]);
      setCfg(bgp);
      setInterfaces(ifs.map((i) => i.name).sort());
      setRouteMaps(rms);
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load BGP configuration.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const peerGroupNames = useMemo(() => (cfg?.peerGroups ?? []).map((g) => g.name), [cfg]);

  const saved = (msg: string) => {
    setNeighborModal(null);
    setGroupModal(null);
    setToast(msg);
    load("refresh");
  };

  const removeNeighbor = async (row: BgpPeer) => {
    try {
      await deleteBgpNeighbor(row.name);
      setToast(`Deleted neighbor ${row.name}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete neighbor ${row.name}.`);
    }
  };
  const removeGroup = async (row: BgpPeer) => {
    try {
      await deleteBgpPeerGroup(row.name);
      setToast(`Deleted peer-group ${row.name}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete peer-group ${row.name}.`);
    }
  };

  const tabs: [Section, string, number | null][] = [
    ["global", "Global", null],
    ["neighbors", "Neighbors", cfg?.neighbors.length ?? 0],
    ["peer-groups", "Peer Groups", cfg?.peerGroups.length ?? 0],
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          BGP
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Border Gateway Protocol — underlay peering and the L2VPN-EVPN overlay for a spine/leaf fabric
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && <div className="text-[13px] text-[var(--qz-fg-4)]">Loading BGP configuration…</div>}
        {status === "error" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-[13px] text-[var(--qz-danger)]">
              <AlertTriangle size={15} />
              {errorMsg}
            </div>
            <div>
              <Button kind="secondary" icon={RotateCw} onClick={load}>Retry</Button>
            </div>
          </div>
        )}
        {status === "ready" && cfg && (
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-1 border-b border-[var(--qz-border)]">
              {tabs.map(([id, label, count]) => {
                const active = section === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setSection(id)}
                    className={[
                      "px-3 py-2 text-[13px] font-medium border-b-2 -mb-px transition-colors cursor-pointer",
                      active ? "text-[var(--qz-accent)] border-[var(--qz-accent)]" : "text-[var(--qz-fg-3)] border-transparent hover:text-[var(--qz-fg-1)]",
                    ].join(" ")}
                  >
                    {label}
                    {count !== null && <span className="ml-[6px] text-[12px] text-[var(--qz-fg-4)]">{count}</span>}
                  </button>
                );
              })}
            </div>

            {section === "global" && (
              <BgpGlobalPanel live={cfg.global} onSaved={(msg) => { setToast(msg); load("refresh"); }} />
            )}

            {section === "neighbors" && (
              <DataTable
                rows={cfg.neighbors}
                columns={peerColumns(true)}
                rowId={(r) => r.name}
                storageKey="routing-bgp-neighbors"
                searchPlaceholder="Search neighbors…"
                emptyMessage="No BGP neighbors configured."
                onRefresh={() => load("refresh")}
                toolbar={
                  <Button kind="primary" size="sm" icon={Plus} onClick={() => setNeighborModal({})}>
                    Add neighbor
                  </Button>
                }
                actions={(row) => (
                  <RowActions label={`neighbor ${row.name}`} onEdit={() => setNeighborModal({ peer: row })} onDelete={() => removeNeighbor(row)} />
                )}
              />
            )}

            {section === "peer-groups" && (
              <DataTable
                rows={cfg.peerGroups}
                columns={peerColumns(false)}
                rowId={(r) => r.name}
                storageKey="routing-bgp-peer-groups"
                searchPlaceholder="Search peer-groups…"
                emptyMessage="No BGP peer-groups configured."
                onRefresh={() => load("refresh")}
                toolbar={
                  <Button kind="primary" size="sm" icon={Plus} onClick={() => setGroupModal({})}>
                    Add peer-group
                  </Button>
                }
                actions={(row) => (
                  <RowActions label={`peer-group ${row.name}`} onEdit={() => setGroupModal({ peer: row })} onDelete={() => removeGroup(row)} />
                )}
              />
            )}
          </div>
        )}
      </div>

      {neighborModal && cfg && (
        <PeerFormModal
          kind="neighbor"
          initial={neighborModal.peer}
          existingNames={cfg.neighbors.map((n) => n.name)}
          peerGroups={peerGroupNames}
          interfaces={interfaces}
          routeMaps={routeMaps}
          onClose={() => setNeighborModal(null)}
          onSaved={saved}
        />
      )}
      {groupModal && cfg && (
        <PeerFormModal
          kind="peer-group"
          initial={groupModal.peer}
          existingNames={cfg.peerGroups.map((g) => g.name)}
          peerGroups={peerGroupNames}
          interfaces={interfaces}
          routeMaps={routeMaps}
          onClose={() => setGroupModal(null)}
          onSaved={saved}
        />
      )}
    </div>
  );
}
