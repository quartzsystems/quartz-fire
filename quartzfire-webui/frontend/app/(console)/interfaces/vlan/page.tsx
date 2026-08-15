"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { StatePill } from "@/components/ui/Badge";
import { Column, DataTable, FilterDef } from "@/components/dashboard/DataTable";
import { MtuCell } from "@/components/dashboard/MtuCell";
import { RowActions } from "@/components/dashboard/RowActions";
import { deleteVlan, effectiveMtu, fetchEthernet, fetchVlans, VlanInterface } from "@/lib/interfaces";
import { useDashboard } from "@/lib/DashboardContext";
import { VlanFormModal } from "./VlanFormModal";

const columns: Column<VlanInterface>[] = [
  { key: "name", header: "Interface", value: (r) => r.name, mono: true, sortable: true, width: 140 },
  { key: "vlan_id", header: "VLAN ID", value: (r) => r.vlan_id, mono: true, sortable: true, width: 90 },
  { key: "parent", header: "Parent", value: (r) => r.parent, mono: true, sortable: true, width: 110 },
  { key: "description", header: "Description", value: (r) => r.description ?? "", sortable: true },
  {
    key: "addresses",
    header: "IP Address",
    value: (r) => r.addresses.join(", "),
    render: (r) => (r.addresses.length ? r.addresses.join(", ") : "—"),
    mono: true,
  },
  { key: "mtu", header: "MTU", value: (r) => effectiveMtu(r.mtu, "vlan"), render: (r) => <MtuCell mtu={r.mtu} kind="vlan" />, mono: true, sortable: true, width: 80 },
  {
    key: "status",
    header: "Status",
    value: (r) => (r.enabled ? "enabled" : "disabled"),
    render: (r) => <StatePill enabled={r.enabled} />,
    sortable: true,
    width: 120,
  },
];

export default function VlanPage() {
  const { setToast } = useDashboard();
  const [rows, setRows] = useState<VlanInterface[]>([]);
  const [parents, setParents] = useState<string[]>([]);
  const [parentDescriptions, setParentDescriptions] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  // null = closed; { vlan: undefined } = create; { vlan } = edit.
  const [modal, setModal] = useState<{ vlan?: VlanInterface } | null>(null);

  const fetchData = useCallback(async () => {
    const [vlans, eths] = await Promise.all([fetchVlans(), fetchEthernet()]);
    setRows(vlans);
    setParents(eths.map((e) => e.name).sort());
    setParentDescriptions(
      Object.fromEntries(eths.filter((e) => e.description).map((e) => [e.name, e.description!])),
    );
  }, []);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      await fetchData();
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load VLAN interfaces.");
      setStatus("error");
    }
  }, [fetchData]);

  useEffect(() => {
    load();
  }, [load]);

  const removeVlan = async (row: VlanInterface) => {
    try {
      await deleteVlan(row.parent, row.vlan_id);
      setToast(`Deleted ${row.name}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete ${row.name}.`);
    }
  };

  // Parent filter options are derived from the data.
  const filters: FilterDef<VlanInterface>[] = useMemo(() => {
    const fromRows = Array.from(new Set(rows.map((r) => r.parent)));
    return [
      {
        key: "status",
        label: "Status",
        options: [
          { value: "enabled", label: "Enabled" },
          { value: "disabled", label: "Disabled" },
        ],
        predicate: (r, v) => (v === "enabled" ? r.enabled : !r.enabled),
      },
      {
        key: "parent",
        label: "Parent",
        options: fromRows.sort().map((p) => ({ value: p, label: p })),
        predicate: (r, v) => r.parent === v,
      },
    ];
  }, [rows]);

  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      <div>
        <h2>VLAN Interfaces</h2>
        <p className="clr-secondary" style={{ marginTop: 4 }}>802.1Q VLAN sub-interfaces</p>
      </div>

      {status === "loading" && (
        <div className="clr-secondary">Loading VLAN interfaces…</div>
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
          storageKey="interfaces-vlan"
          searchPlaceholder="Search VLANs…"
          emptyMessage="No VLAN interfaces configured."
          onRefresh={() => load("refresh")}
          onRowOpen={(row) => setModal({ vlan: row })}
          toolbar={
            <Button kind="primary" size="sm" icon="plus" onClick={() => setModal({})}>
              Create VLAN
            </Button>
          }
          actions={(row) => (
            <RowActions
              label={row.name}
              onEdit={() => setModal({ vlan: row })}
              onDelete={() => removeVlan(row)}
            />
          )}
        />
      )}

      {modal && (
        <VlanFormModal
          initial={modal.vlan}
          parents={parents}
          descriptions={parentDescriptions}
          existing={rows}
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
