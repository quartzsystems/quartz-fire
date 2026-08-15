"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { StatePill } from "@/components/ui/Badge";
import { Column, DataTable, FilterDef } from "@/components/dashboard/DataTable";
import { MtuCell } from "@/components/dashboard/MtuCell";
import { RowActions } from "@/components/dashboard/RowActions";
import { effectiveMtu, fetchLoopback, LoopbackInterface } from "@/lib/interfaces";
import { useDashboard } from "@/lib/DashboardContext";
import { LoopbackFormModal } from "./LoopbackFormModal";

const columns: Column<LoopbackInterface>[] = [
  { key: "name", header: "Interface", value: (r) => r.name, mono: true, sortable: true, width: 130 },
  { key: "description", header: "Description", value: (r) => r.description ?? "", sortable: true },
  {
    key: "addresses",
    header: "IP Address",
    value: (r) => r.addresses.join(", "),
    render: (r) => (r.addresses.length ? r.addresses.join(", ") : "—"),
    mono: true,
  },
  { key: "mtu", header: "MTU", value: (r) => effectiveMtu(r.mtu, "loopback"), render: (r) => <MtuCell mtu={r.mtu} kind="loopback" />, mono: true, sortable: true, width: 80 },
  {
    key: "status",
    header: "Status",
    value: (r) => (r.enabled ? "enabled" : "disabled"),
    render: (r) => <StatePill enabled={r.enabled} />,
    sortable: true,
    width: 120,
  },
];

const filters: FilterDef<LoopbackInterface>[] = [
  {
    key: "status",
    label: "Status",
    options: [
      { value: "enabled", label: "Enabled" },
      { value: "disabled", label: "Disabled" },
    ],
    predicate: (r, v) => (v === "enabled" ? r.enabled : !r.enabled),
  },
];

export default function LoopbackPage() {
  const { setToast } = useDashboard();
  const [rows, setRows] = useState<LoopbackInterface[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  // null = closed; { lo: undefined } = configure `lo`; { lo } = edit.
  const [modal, setModal] = useState<{ lo?: LoopbackInterface } | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      setRows(await fetchLoopback());
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load loopback interfaces.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // VyOS supports exactly one loopback node, `lo` — offer to configure it only
  // when it's absent from the config.
  const loMissing = !rows.some((r) => r.name === "lo");

  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      <div>
        <h2>Loopback Interfaces</h2>
        <p className="clr-secondary" style={{ marginTop: 4 }}>Loopback interfaces for stable local addressing</p>
      </div>

      {status === "loading" && (
        <div className="clr-secondary">Loading loopback interfaces…</div>
      )}
      {status === "error" && (
        <div className="flex flex-col gap-3">
          <div className="alert alert-danger alert-sm">
            <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
            <div className="alert-text">{errorMsg}</div>
          </div>
          <div>
            <Button kind="secondary" icon="refresh" onClick={load}>Retry</Button>
          </div>
        </div>
      )}
      {status === "ready" && (
        <DataTable
          rows={rows}
          columns={columns}
          filters={filters}
          rowId={(r) => r.name}
          storageKey="interfaces-loopback"
          searchPlaceholder="Search loopback interfaces…"
          emptyMessage="Loopback lo is not in the config yet — configure it to add addresses."
          onRefresh={() => load("refresh")}
          onRowOpen={(row) => setModal({ lo: row })}
          toolbar={
            loMissing ? (
              <Button kind="primary" size="sm" icon="plus" onClick={() => setModal({})}>
                Configure lo
              </Button>
            ) : undefined
          }
          actions={(row) => (
            <RowActions label={row.name} onEdit={() => setModal({ lo: row })} />
          )}
        />
      )}

      {modal && (
        <LoopbackFormModal
          initial={modal.lo}
          onClose={() => setModal(null)}
          onSaved={(msg) => {
            setModal(null);
            setToast(msg);
            load("refresh");
          }}
        />
      )}
    </div>
  );
}
