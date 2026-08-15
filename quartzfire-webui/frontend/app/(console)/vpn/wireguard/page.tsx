"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Tabs } from "@/components/ui/Tabs";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { RowActions } from "@/components/dashboard/RowActions";
import { WireguardInterface, deleteWireguard, fetchWireguard } from "@/lib/wireguard";
import { fetchInterfaceStats } from "@/lib/vyos";
import { useDashboard } from "@/lib/DashboardContext";
import { WireguardFormModal } from "./WireguardFormModal";
import { WireguardStatusPanel } from "./WireguardStatusPanel";

type Tab = "config" | "status";

const dash = (v: string | null) => (v && v.length ? v : "—");

function columns(): Column<WireguardInterface>[] {
  return [
    { key: "name", header: "Interface", value: (r) => r.name, mono: true, sortable: true, width: 120 },
    {
      key: "addresses",
      header: "Addresses",
      value: (r) => r.addresses.join(","),
      render: (r) =>
        r.addresses.length ? (
          <span style={{ fontFamily: "var(--qz-font-mono)" }}>{r.addresses.join(", ")}</span>
        ) : (
          <span style={{ color: "var(--cds-alias-typography-color-200)" }}>—</span>
        ),
    },
    { key: "port", header: "Listen Port", value: (r) => r.port ?? -1, render: (r) => (r.port == null ? "—" : String(r.port)), mono: true, width: 120 },
    { key: "peers", header: "Peers", value: (r) => r.peers.length, mono: true, sortable: true, width: 90 },
    {
      key: "state",
      header: "State",
      value: (r) => (r.enabled ? "enabled" : "disabled"),
      render: (r) => (
        <span className={r.enabled ? "badge badge-success" : "badge badge-muted"}>{r.enabled ? "Enabled" : "Disabled"}</span>
      ),
      width: 120,
    },
  ];
}

export default function WireguardPage() {
  const { setToast } = useDashboard();
  const [rows, setRows] = useState<WireguardInterface[]>([]);
  const [interfaces, setInterfaces] = useState<string[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [tab, setTab] = useState<Tab>("config");
  const [modal, setModal] = useState<{ iface?: WireguardInterface } | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      const [wg, ifs] = await Promise.all([fetchWireguard(), fetchInterfaceStats().catch(() => [])]);
      setRows(wg);
      setInterfaces(ifs.map((i) => i.name).sort());
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load WireGuard configuration.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const saved = (msg: string) => {
    setModal(null);
    setToast(msg);
    load("refresh");
  };

  const remove = async (row: WireguardInterface) => {
    try {
      await deleteWireguard(row.name);
      setToast(`Deleted WireGuard interface ${row.name}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete ${row.name}.`);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2>WireGuard</h2>
        <p className="clr-secondary" style={{ marginTop: 4 }}>
          Fast, modern point-to-point tunnels — one interface per endpoint, one peer per remote
        </p>
      </div>

      {status === "loading" && <div className="text-[13px]" style={{ color: "var(--cds-alias-typography-color-300)" }}>Loading WireGuard configuration…</div>}
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
      {status === "ready" && (
        <div className="flex flex-col gap-5">
          <Tabs
            items={[
              { value: "config", label: "Configuration" },
              { value: "status", label: "Status" },
            ]}
            value={tab}
            onChange={(v) => setTab(v as Tab)}
          />

          {tab === "config" && (
            <DataTable
              rows={rows}
              columns={columns()}
              rowId={(r) => r.name}
              storageKey="vpn-wireguard"
              searchPlaceholder="Search interfaces…"
              emptyMessage="No WireGuard interfaces configured."
              onRefresh={() => load("refresh")}
              onRowOpen={(row) => setModal({ iface: row })}
              toolbar={
                <Button kind="primary" size="sm" icon="plus" onClick={() => setModal({})}>
                  Add Interface
                </Button>
              }
              actions={(row) => (
                <RowActions label={`WireGuard ${row.name}`} onEdit={() => setModal({ iface: row })} onDelete={() => remove(row)} />
              )}
            />
          )}

          {tab === "status" && <WireguardStatusPanel />}
        </div>
      )}

      {modal && (
        <WireguardFormModal
          initial={modal.iface}
          existingNames={rows.map((r) => r.name)}
          interfaces={interfaces}
          onClose={() => setModal(null)}
          onSaved={saved}
        />
      )}
    </div>
  );
}
