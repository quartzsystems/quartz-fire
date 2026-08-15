"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Tabs } from "@/components/ui/Tabs";
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
      render: (r) => (r.auth_mode ? <span className="badge badge-info">{r.auth_mode === "pre-shared-secret" ? "PSK" : "x509"}</span> : <span style={{ color: "var(--cds-alias-typography-color-200)" }}>—</span>),
      width: 100,
    },
  ];
}

function ikeColumns(): Column<IkeGroup>[] {
  return [
    { key: "name", header: "Name", value: (r) => r.name, mono: true, sortable: true, width: 180 },
    { key: "ke", header: "Key exchange", value: (r) => r.key_exchange ?? "", render: (r) => dash(r.key_exchange), mono: true, width: 140 },
    { key: "lifetime", header: "Lifetime", value: (r) => r.lifetime ?? -1, render: (r) => (r.lifetime == null ? "—" : `${r.lifetime} s`), mono: true, width: 120 },
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
    { key: "lifetime", header: "Lifetime", value: (r) => r.lifetime ?? -1, render: (r) => (r.lifetime == null ? "—" : `${r.lifetime} s`), mono: true, width: 120 },
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

  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await load("refresh");
    } finally {
      setRefreshing(false);
    }
  };

  // Header "Add" control follows the active tab (DC pattern: one primary
  // button in the page-header row whose label tracks the tab; every other tab
  // falls back to "Add Peer", as in the mock's ipsecAddLabel).
  const addAction: { label: string; onClick: () => void } =
    tab === "ike"
      ? { label: "Add IKE Group", onClick: () => setIkeModal({}) }
      : tab === "esp"
        ? { label: "Add ESP Group", onClick: () => setEspModal({}) }
        : { label: "Add Peer", onClick: () => setPeerModal({}) };

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

  const headerBlock = (
    <div>
      <h2 className="m-0">IPsec</h2>
      <p className="clr-secondary" style={{ marginTop: 4 }}>
        Site-to-site IPsec — IKE/ESP proposals, policy- or route-based (VTI) tunnels.
      </p>
    </div>
  );

  const tabStrip = cfg && (
    <Tabs
      items={[
        { value: "peers", label: "Peers", count: cfg.peers.length },
        { value: "ike", label: "IKE Groups", count: cfg.ike_groups.length },
        { value: "esp", label: "ESP Groups", count: cfg.esp_groups.length },
        { value: "interfaces", label: "Interfaces", count: cfg.interfaces.length },
        { value: "status", label: "Status" },
      ]}
      value={tab}
      onChange={(v) => setTab(v as Tab)}
    />
  );

  const addButton = <Button kind="primary" onClick={addAction.onClick}>{addAction.label}</Button>;

  return (
    <div className="flex flex-col" style={{ gap: 12 }}>
      {status !== "ready" && headerBlock}

      {status === "loading" && <div className="clr-secondary">Loading IPsec configuration…</div>}
      {status === "error" && (
        <div className="alert alert-danger alert-sm">
          <Icon shape="exclamation-circle" size={14} className="alert-icon" />
          <span className="alert-text">{errorMsg}</span>
          <div className="alert-actions">
            <button type="button" className="alert-action" onClick={() => load()}>
              Retry
            </button>
          </div>
        </div>
      )}
      {status === "ready" && cfg && (
        <>
          {tab === "peers" && (
            <DataTable searchable={false}
              rows={cfg.peers}
              columns={peerColumns()}
              rowId={(r) => r.name}
              storageKey="vpn-ipsec-peers"
              searchPlaceholder="Search peers…"
              emptyMessage="No IPsec peers configured."
              onRefresh={() => load("refresh")}
              onRowOpen={(row) => setPeerModal({ peer: row })}
              headerLeft={headerBlock}
              subHeader={tabStrip}
              toolbar={addButton}
              actions={(row) => <RowActions label={`peer ${row.name}`} onEdit={() => setPeerModal({ peer: row })} onDelete={() => removePeer(row)} />}
            />
          )}

          {tab === "ike" && (
            <DataTable searchable={false}
              rows={cfg.ike_groups}
              columns={ikeColumns()}
              rowId={(r) => r.name}
              storageKey="vpn-ipsec-ike"
              searchPlaceholder="Search IKE groups…"
              emptyMessage="No IKE groups configured."
              onRefresh={() => load("refresh")}
              onRowOpen={(row) => setIkeModal({ group: row })}
              headerLeft={headerBlock}
              subHeader={tabStrip}
              toolbar={addButton}
              actions={(row) => <RowActions label={`IKE group ${row.name}`} onEdit={() => setIkeModal({ group: row })} onDelete={() => removeIke(row)} />}
            />
          )}

          {tab === "esp" && (
            <DataTable searchable={false}
              rows={cfg.esp_groups}
              columns={espColumns()}
              rowId={(r) => r.name}
              storageKey="vpn-ipsec-esp"
              searchPlaceholder="Search ESP groups…"
              emptyMessage="No ESP groups configured."
              onRefresh={() => load("refresh")}
              onRowOpen={(row) => setEspModal({ group: row })}
              headerLeft={headerBlock}
              subHeader={tabStrip}
              toolbar={addButton}
              actions={(row) => <RowActions label={`ESP group ${row.name}`} onEdit={() => setEspModal({ group: row })} onDelete={() => removeEsp(row)} />}
            />
          )}

          {(tab === "interfaces" || tab === "status") && (
            <>
              <div className="flex items-start gap-2 flex-wrap">
                <div className="mr-auto">{headerBlock}</div>
                <div className="flex items-center gap-2">
                  <Button kind="outline" onClick={refresh} disabled={refreshing}>
                    {refreshing ? "Refreshing…" : "Refresh"}
                  </Button>
                  {addButton}
                </div>
              </div>
              {tabStrip}
              {tab === "interfaces" ? (
                <InterfacesPanel
                  live={cfg.interfaces}
                  interfaces={interfaces}
                  onSaved={(msg) => { setToast(msg); load("refresh"); }}
                />
              ) : (
                <IpsecStatusPanel />
              )}
            </>
          )}
        </>
      )}

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
