"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Plus, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
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
          <span className="text-[var(--qz-fg-4)]">—</span>
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
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          WireGuard
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Fast, modern point-to-point tunnels — one interface per endpoint, one peer per remote
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && <div className="text-[13px] text-[var(--qz-fg-4)]">Loading WireGuard configuration…</div>}
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
        {status === "ready" && (
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-1 border-b border-[var(--qz-border)]">
              {([["config", "Configuration"], ["status", "Status"]] as [Tab, string][]).map(([id, label]) => {
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
                  </button>
                );
              })}
            </div>

            {tab === "config" && (
              <DataTable
                rows={rows}
                columns={columns()}
                rowId={(r) => r.name}
                storageKey="vpn-wireguard"
                searchPlaceholder="Search interfaces…"
                emptyMessage="No WireGuard interfaces configured."
                onRefresh={() => load("refresh")}
                toolbar={
                  <Button kind="primary" size="sm" icon={Plus} onClick={() => setModal({})}>
                    Add interface
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
      </div>

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
