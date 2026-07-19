"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Plus, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { RowActions } from "@/components/dashboard/RowActions";
import {
  EspGroup,
  IkeGroup,
  IpsecConfig,
  IpsecPeer,
  deleteEspGroup,
  deleteIkeGroup,
  deletePeer,
  fetchIpsec,
} from "@/lib/ipsec";
import { fetchInterfaceStats } from "@/lib/vyos";
import { useDashboard } from "@/lib/DashboardContext";
import { PeerFormModal } from "./PeerFormModal";
import { IkeGroupFormModal } from "./IkeGroupFormModal";
import { EspGroupFormModal } from "./EspGroupFormModal";
import { InterfacesPanel } from "./InterfacesPanel";
import { IpsecStatusPanel } from "./IpsecStatusPanel";

type Tab = "peers" | "ike" | "esp" | "interfaces" | "status";

const dash = (v: string | null) => (v && v.length ? v : "—");

function peerColumns(): Column<IpsecPeer>[] {
  return [
    { key: "name", header: "Peer", value: (r) => r.name, mono: true, sortable: true, width: 150 },
    { key: "remote", header: "Remote", value: (r) => r.remote_address ?? "", render: (r) => <span style={{ fontFamily: "var(--qz-font-mono)" }}>{dash(r.remote_address)}</span>, sortable: true },
    {
      key: "mode",
      header: "Mode",
      value: (r) => (r.vti_bind ? "route" : "policy"),
      render: (r) => <span className="badge badge-muted">{r.vti_bind ? `VTI ${r.vti_bind}` : `${r.tunnels.length} tunnel${r.tunnels.length === 1 ? "" : "s"}`}</span>,
      width: 140,
    },
    { key: "ike", header: "IKE / ESP", value: (r) => `${r.ike_group ?? ""}/${r.default_esp_group ?? ""}`, render: (r) => <span style={{ fontFamily: "var(--qz-font-mono)" }}>{dash(r.ike_group)} / {dash(r.default_esp_group)}</span> },
    {
      key: "auth",
      header: "Auth",
      value: (r) => r.auth_mode ?? "",
      render: (r) => (r.auth_mode ? <span className="badge badge-info">{r.auth_mode === "pre-shared-secret" ? "PSK" : "x509"}</span> : <span className="text-[var(--qz-fg-4)]">—</span>),
      width: 100,
    },
  ];
}

function ikeColumns(): Column<IkeGroup>[] {
  return [
    { key: "name", header: "Name", value: (r) => r.name, mono: true, sortable: true, width: 180 },
    { key: "ke", header: "Key Exchange", value: (r) => r.key_exchange ?? "", render: (r) => dash(r.key_exchange), mono: true, width: 140 },
    { key: "lifetime", header: "Lifetime", value: (r) => r.lifetime ?? -1, render: (r) => (r.lifetime == null ? "—" : `${r.lifetime}s`), mono: true, width: 120 },
    {
      key: "proposals",
      header: "Proposals",
      value: (r) => r.proposals.length,
      render: (r) => (r.proposals.length ? <span style={{ fontFamily: "var(--qz-font-mono)" }}>{r.proposals.map((p) => [p.encryption, p.hash, p.dh_group].filter(Boolean).join("/")).join(", ")}</span> : "—"),
    },
  ];
}

function espColumns(): Column<EspGroup>[] {
  return [
    { key: "name", header: "Name", value: (r) => r.name, mono: true, sortable: true, width: 180 },
    { key: "pfs", header: "PFS", value: (r) => r.pfs ?? "", render: (r) => dash(r.pfs), mono: true, width: 130 },
    { key: "mode", header: "Mode", value: (r) => r.mode ?? "", render: (r) => dash(r.mode), mono: true, width: 120 },
    { key: "lifetime", header: "Lifetime", value: (r) => r.lifetime ?? -1, render: (r) => (r.lifetime == null ? "—" : `${r.lifetime}s`), mono: true, width: 120 },
    {
      key: "proposals",
      header: "Proposals",
      value: (r) => r.proposals.length,
      render: (r) => (r.proposals.length ? <span style={{ fontFamily: "var(--qz-font-mono)" }}>{r.proposals.map((p) => [p.encryption, p.hash].filter(Boolean).join("/")).join(", ")}</span> : "—"),
    },
  ];
}

export default function IpsecPage() {
  const { setToast } = useDashboard();
  const [cfg, setCfg] = useState<IpsecConfig | null>(null);
  const [interfaces, setInterfaces] = useState<string[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [tab, setTab] = useState<Tab>("peers");

  const [peerModal, setPeerModal] = useState<{ peer?: IpsecPeer } | null>(null);
  const [ikeModal, setIkeModal] = useState<{ group?: IkeGroup } | null>(null);
  const [espModal, setEspModal] = useState<{ group?: EspGroup } | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      const [ipsec, ifs] = await Promise.all([fetchIpsec(), fetchInterfaceStats().catch(() => [])]);
      setCfg(ipsec);
      setInterfaces(ifs.map((i) => i.name).sort());
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load IPsec configuration.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const saved = (msg: string) => {
    setPeerModal(null);
    setIkeModal(null);
    setEspModal(null);
    setToast(msg);
    load("refresh");
  };

  const removePeer = async (row: IpsecPeer) => {
    try {
      await deletePeer(row.name);
      setToast(`Deleted IPsec peer ${row.name}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete ${row.name}.`);
    }
  };
  const removeIke = async (row: IkeGroup) => {
    try {
      await deleteIkeGroup(row.name);
      setToast(`Deleted IKE group ${row.name}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete ${row.name}.`);
    }
  };
  const removeEsp = async (row: EspGroup) => {
    try {
      await deleteEspGroup(row.name);
      setToast(`Deleted ESP group ${row.name}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete ${row.name}.`);
    }
  };

  const tabs: [Tab, string, number | null][] = [
    ["peers", "Peers", cfg?.peers.length ?? 0],
    ["ike", "IKE Groups", cfg?.ike_groups.length ?? 0],
    ["esp", "ESP Groups", cfg?.esp_groups.length ?? 0],
    ["interfaces", "Interfaces", cfg?.interfaces.length ?? 0],
    ["status", "Status", null],
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          IPsec
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Site-to-site IPsec — IKE/ESP proposals, policy- or route-based (VTI) tunnels
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && <div className="text-[13px] text-[var(--qz-fg-4)]">Loading IPsec configuration…</div>}
        {status === "error" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-[13px] text-[var(--qz-danger)]">
              <AlertTriangle size={15} />
              {errorMsg}
            </div>
            <div>
              <Button kind="secondary" icon={RotateCw} onClick={() => load()}>Retry</Button>
            </div>
          </div>
        )}
        {status === "ready" && cfg && (
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-1 border-b border-[var(--qz-border)]">
              {tabs.map(([id, label, count]) => {
                const active = tab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTab(id)}
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

            {tab === "peers" && (
              <DataTable
                rows={cfg.peers}
                columns={peerColumns()}
                rowId={(r) => r.name}
                storageKey="vpn-ipsec-peers"
                searchPlaceholder="Search peers…"
                emptyMessage="No IPsec peers configured."
                onRefresh={() => load("refresh")}
                toolbar={<Button kind="primary" size="sm" icon={Plus} onClick={() => setPeerModal({})}>Add peer</Button>}
                actions={(row) => <RowActions label={`peer ${row.name}`} onEdit={() => setPeerModal({ peer: row })} onDelete={() => removePeer(row)} />}
              />
            )}

            {tab === "ike" && (
              <DataTable
                rows={cfg.ike_groups}
                columns={ikeColumns()}
                rowId={(r) => r.name}
                storageKey="vpn-ipsec-ike"
                searchPlaceholder="Search IKE groups…"
                emptyMessage="No IKE groups configured."
                onRefresh={() => load("refresh")}
                toolbar={<Button kind="primary" size="sm" icon={Plus} onClick={() => setIkeModal({})}>Add IKE group</Button>}
                actions={(row) => <RowActions label={`IKE group ${row.name}`} onEdit={() => setIkeModal({ group: row })} onDelete={() => removeIke(row)} />}
              />
            )}

            {tab === "esp" && (
              <DataTable
                rows={cfg.esp_groups}
                columns={espColumns()}
                rowId={(r) => r.name}
                storageKey="vpn-ipsec-esp"
                searchPlaceholder="Search ESP groups…"
                emptyMessage="No ESP groups configured."
                onRefresh={() => load("refresh")}
                toolbar={<Button kind="primary" size="sm" icon={Plus} onClick={() => setEspModal({})}>Add ESP group</Button>}
                actions={(row) => <RowActions label={`ESP group ${row.name}`} onEdit={() => setEspModal({ group: row })} onDelete={() => removeEsp(row)} />}
              />
            )}

            {tab === "interfaces" && (
              <InterfacesPanel
                live={cfg.interfaces}
                interfaces={interfaces}
                onSaved={(msg) => { setToast(msg); load("refresh"); }}
              />
            )}

            {tab === "status" && <IpsecStatusPanel />}
          </div>
        )}
      </div>

      {peerModal && cfg && (
        <PeerFormModal
          initial={peerModal.peer}
          existingNames={cfg.peers.map((p) => p.name)}
          ikeGroups={cfg.ike_groups.map((g) => g.name)}
          espGroups={cfg.esp_groups.map((g) => g.name)}
          onClose={() => setPeerModal(null)}
          onSaved={saved}
        />
      )}
      {ikeModal && cfg && (
        <IkeGroupFormModal initial={ikeModal.group} existingNames={cfg.ike_groups.map((g) => g.name)} onClose={() => setIkeModal(null)} onSaved={saved} />
      )}
      {espModal && cfg && (
        <EspGroupFormModal initial={espModal.group} existingNames={cfg.esp_groups.map((g) => g.name)} onClose={() => setEspModal(null)} onSaved={saved} />
      )}
    </div>
  );
}
