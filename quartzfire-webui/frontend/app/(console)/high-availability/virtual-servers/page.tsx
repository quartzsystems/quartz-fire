"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Plus, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { RowActions } from "@/components/dashboard/RowActions";
import { useDashboard } from "@/lib/DashboardContext";
import { VirtualServer, deleteVirtualServer, fetchVirtualServers } from "@/lib/virtual-server";
import { VirtualServerFormModal } from "./VirtualServerFormModal";

const dash = (v: string | null) => (v && v.length ? v : "—");

function columns(): Column<VirtualServer>[] {
  return [
    { key: "id", header: "Virtual Server", value: (r) => r.id, mono: true, sortable: true },
    { key: "port", header: "Port", value: (r) => r.port ?? "", render: (r) => dash(r.port?.toString() ?? null), mono: true, width: 90 },
    { key: "protocol", header: "Protocol", value: (r) => r.protocol ?? "", render: (r) => dash(r.protocol ? r.protocol.toUpperCase() : null), width: 100 },
    { key: "algorithm", header: "Algorithm", value: (r) => r.algorithm ?? "", render: (r) => dash(r.algorithm), width: 200 },
    { key: "forward", header: "Forward", value: (r) => r.forward_method ?? "", render: (r) => dash(r.forward_method ? r.forward_method.toUpperCase() : null), width: 110 },
    {
      key: "reals",
      header: "Real Servers",
      value: (r) => r.real_servers.length,
      render: (r) => <span className="badge badge-info">{r.real_servers.length}</span>,
      width: 120,
    },
  ];
}

export default function VirtualServersPage() {
  const { setToast } = useDashboard();
  const [rows, setRows] = useState<VirtualServer[] | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [modal, setModal] = useState<{ vs?: VirtualServer } | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      setRows(await fetchVirtualServers());
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load virtual servers.");
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

  const remove = async (row: VirtualServer) => {
    try {
      await deleteVirtualServer(row.id);
      setToast(`Deleted virtual server ${row.id}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete ${row.id}.`);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          Virtual Servers
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          L4 load balancing (IPVS) — distribute a service VIP across a pool of real servers
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && <div className="text-[13px] text-[var(--qz-fg-4)]">Loading virtual servers…</div>}
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
        {status === "ready" && rows && (
          <DataTable
            rows={rows}
            columns={columns()}
            rowId={(r) => r.id}
            storageKey="ha-virtual-servers"
            searchPlaceholder="Search virtual servers…"
            emptyMessage="No virtual servers configured."
            onRefresh={() => load("refresh")}
            toolbar={
              <Button kind="primary" size="sm" icon={Plus} onClick={() => setModal({})}>
                Add virtual server
              </Button>
            }
            actions={(row) => (
              <RowActions label={`virtual server ${row.id}`} onEdit={() => setModal({ vs: row })} onDelete={() => remove(row)} />
            )}
          />
        )}
      </div>

      {modal && rows && (
        <VirtualServerFormModal
          initial={modal.vs}
          existingIds={rows.map((r) => r.id)}
          onClose={() => setModal(null)}
          onSaved={saved}
        />
      )}
    </div>
  );
}
