"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { RowActions } from "@/components/dashboard/RowActions";
import { useDashboard } from "@/lib/DashboardContext";
import { VirtualServer, deleteVirtualServer, fetchVirtualServers } from "@/lib/virtual-server";
import { VirtualServerFormModal } from "./VirtualServerFormModal";

const dash = (v: string | null) => (v && v.length ? v : "—");

function columns(): Column<VirtualServer>[] {
  return [
    { key: "id", header: "Virtual server", value: (r) => r.id, mono: true, sortable: true },
    { key: "port", header: "Port", value: (r) => r.port ?? "", render: (r) => dash(r.port?.toString() ?? null), mono: true, width: 90 },
    { key: "protocol", header: "Protocol", value: (r) => r.protocol ?? "", render: (r) => dash(r.protocol ? r.protocol.toUpperCase() : null), mono: true, width: 100 },
    { key: "algorithm", header: "Algorithm", value: (r) => r.algorithm ?? "", render: (r) => dash(r.algorithm), mono: true, width: 200 },
    { key: "forward", header: "Forward", value: (r) => r.forward_method ?? "", render: (r) => dash(r.forward_method ? r.forward_method.toUpperCase() : null), mono: true, width: 110 },
    {
      key: "reals",
      header: "Real servers",
      value: (r) => r.real_servers.length,
      mono: true,
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

  const headerBlock = (
    <div>
      <h2 className="m-0">Virtual Servers</h2>
      <p className="clr-secondary" style={{ marginTop: 4 }}>
        L4 load balancing (IPVS) — distribute a service VIP across a pool of real servers.
      </p>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      {status !== "ready" && headerBlock}

      {status === "loading" && <div className="clr-secondary">Loading virtual servers…</div>}
      {status === "error" && (
        <div className="alert alert-danger alert-sm">
          <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
          <div className="alert-text">{errorMsg}</div>
          <div className="alert-actions">
            <button type="button" className="alert-action" onClick={() => load()}>
              Retry
            </button>
          </div>
        </div>
      )}
      {status === "ready" && rows && (
        <DataTable searchable={false}
          rows={rows}
          columns={columns()}
          rowId={(r) => r.id}
          storageKey="ha-virtual-servers"
          searchPlaceholder="Search virtual servers…"
          emptyMessage="No virtual servers configured."
          onRefresh={() => load("refresh")}
          onRowOpen={(row) => setModal({ vs: row })}
          headerLeft={headerBlock}
          toolbar={
            <Button kind="primary" onClick={() => setModal({})}>
              Add Virtual Server
            </Button>
          }
          actions={(row) => (
            <RowActions label={`virtual server ${row.id}`} onEdit={() => setModal({ vs: row })} onDelete={() => remove(row)} />
          )}
        />
      )}

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
