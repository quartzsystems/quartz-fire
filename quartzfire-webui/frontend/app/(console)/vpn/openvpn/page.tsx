"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Plus, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { RowActions } from "@/components/dashboard/RowActions";
import { OpenvpnInterface, deleteOpenvpn, fetchOpenvpn } from "@/lib/openvpn";
import { useDashboard } from "@/lib/DashboardContext";
import { OpenvpnFormModal } from "./OpenvpnFormModal";
import { OpenvpnStatusPanel } from "./OpenvpnStatusPanel";

type Tab = "config" | "status";

const MODE_LABEL: Record<OpenvpnInterface["mode"], string> = {
  "site-to-site": "Site-to-site",
  client: "Client",
  server: "Server",
};

/// A short "where does this tunnel point" summary per mode.
function endpointSummary(r: OpenvpnInterface): string {
  if (r.mode === "server") return r.server_subnet ?? "—";
  if (r.mode === "client") return r.remote_host ? `${r.remote_host}${r.remote_port ? `:${r.remote_port}` : ""}` : "—";
  return r.remote_host ?? r.remote_address ?? "—";
}

function columns(): Column<OpenvpnInterface>[] {
  return [
    { key: "name", header: "Interface", value: (r) => r.name, mono: true, sortable: true, width: 120 },
    {
      key: "mode",
      header: "Mode",
      value: (r) => r.mode,
      render: (r) => <span className="badge badge-info">{MODE_LABEL[r.mode]}</span>,
      sortable: true,
      width: 140,
    },
    { key: "protocol", header: "Protocol", value: (r) => r.protocol ?? "udp", render: (r) => r.protocol ?? "udp", mono: true, width: 120 },
    {
      key: "endpoint",
      header: "Endpoint / Subnet",
      value: (r) => endpointSummary(r),
      render: (r) => <span style={{ fontFamily: "var(--qz-font-mono)" }}>{endpointSummary(r)}</span>,
    },
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

export default function OpenvpnPage() {
  const { setToast } = useDashboard();
  const [rows, setRows] = useState<OpenvpnInterface[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [tab, setTab] = useState<Tab>("config");
  const [modal, setModal] = useState<{ iface?: OpenvpnInterface } | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      setRows(await fetchOpenvpn());
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load OpenVPN configuration.");
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

  const remove = async (row: OpenvpnInterface) => {
    try {
      await deleteOpenvpn(row.name);
      setToast(`Deleted OpenVPN interface ${row.name}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete ${row.name}.`);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          OpenVPN
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          TLS-based tunnels — site-to-site links, remote-access servers, and outbound clients
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && <div className="text-[13px] text-[var(--qz-fg-4)]">Loading OpenVPN configuration…</div>}
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
                storageKey="vpn-openvpn"
                searchPlaceholder="Search interfaces…"
                emptyMessage="No OpenVPN interfaces configured."
                onRefresh={() => load("refresh")}
                toolbar={
                  <Button kind="primary" size="sm" icon={Plus} onClick={() => setModal({})}>
                    Add interface
                  </Button>
                }
                actions={(row) => (
                  <RowActions label={`OpenVPN ${row.name}`} onEdit={() => setModal({ iface: row })} onDelete={() => remove(row)} />
                )}
              />
            )}

            {tab === "status" && <OpenvpnStatusPanel />}
          </div>
        )}
      </div>

      {modal && (
        <OpenvpnFormModal
          initial={modal.iface}
          existingNames={rows.map((r) => r.name)}
          onClose={() => setModal(null)}
          onSaved={saved}
        />
      )}
    </div>
  );
}
