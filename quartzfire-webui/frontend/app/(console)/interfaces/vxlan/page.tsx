"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Plus, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Column, DataTable, FilterDef } from "@/components/dashboard/DataTable";
import { RowActions } from "@/components/dashboard/RowActions";
import { MtuCell } from "@/components/dashboard/MtuCell";
import { deleteVxlan, effectiveMtu, fetchBridges, fetchVxlan, VxlanInterface } from "@/lib/interfaces";
import { fetchInterfaceStats } from "@/lib/vyos";
import { useDashboard } from "@/lib/DashboardContext";
import { VxlanFormModal } from "./VxlanFormModal";

/// Which control plane a VTEP uses, inferred from the fields it has set.
type Plane = "EVPN" | "Static" | "Multicast" | "—";
function plane(r: VxlanInterface): Plane {
  if (r.external) return "EVPN";
  if (r.remotes.length) return "Static";
  if (r.group) return "Multicast";
  return "—";
}

const PLANE_BADGE: Record<Plane, string> = {
  EVPN: "badge-ok",
  Static: "badge-info",
  Multicast: "badge-info",
  "—": "badge-muted",
};

const dash = (v: string | null) => (v && v.length ? v : "—");

const columns: Column<VxlanInterface>[] = [
  { key: "name", header: "Interface", value: (r) => r.name, mono: true, sortable: true, width: 120 },
  {
    key: "vni",
    header: "VNIs",
    value: (r) => r.vnis.map((m) => m.vni).join(", "),
    render: (r) => {
      if (r.vnis.length === 0) return <span className="text-[var(--qz-fg-4)]">—</span>;
      const first = r.vnis[0];
      const label = first.vlan != null ? `${first.vni}→v${first.vlan}` : String(first.vni);
      return (
        <span className="font-mono text-[12px]">
          {label}
          {r.vnis.length > 1 && <span className="text-[var(--qz-fg-4)]"> +{r.vnis.length - 1}</span>}
        </span>
      );
    },
    sortable: true,
    width: 130,
  },
  {
    key: "plane",
    header: "Control Plane",
    value: (r) => plane(r),
    render: (r) => <span className={`badge ${PLANE_BADGE[plane(r)]}`}>{plane(r)}</span>,
    sortable: true,
    width: 130,
  },
  {
    key: "source",
    header: "VTEP Source",
    value: (r) => r.source_address ?? r.source_interface ?? "",
    render: (r) => dash(r.source_address ?? r.source_interface),
    mono: true,
  },
  {
    key: "peers",
    header: "Remotes / Group",
    value: (r) => [...r.remotes, r.group ?? ""].join(", "),
    render: (r) => (r.remotes.length ? r.remotes.join(", ") : dash(r.group)),
    mono: true,
  },
  { key: "port", header: "Port", value: (r) => r.port ?? 8472, mono: true, width: 80 },
  { key: "mtu", header: "MTU", value: (r) => effectiveMtu(r.mtu, "vxlan"), render: (r) => <MtuCell mtu={r.mtu} kind="vxlan" />, mono: true, sortable: true, width: 80 },
  {
    key: "status",
    header: "Status",
    value: (r) => (r.enabled ? "enabled" : "disabled"),
    render: (r) => (
      <span className={r.enabled ? "badge badge-ok" : "badge badge-muted"}>{r.enabled ? "Enabled" : "Disabled"}</span>
    ),
    sortable: true,
    width: 110,
  },
];

const filters: FilterDef<VxlanInterface>[] = [
  {
    key: "plane",
    label: "Control Plane",
    options: [
      { value: "EVPN", label: "EVPN" },
      { value: "Static", label: "Static" },
      { value: "Multicast", label: "Multicast" },
    ],
    predicate: (r, v) => plane(r) === v,
  },
];

export default function VxlanPage() {
  const { setToast } = useDashboard();
  const [rows, setRows] = useState<VxlanInterface[]>([]);
  const [interfaces, setInterfaces] = useState<string[]>([]);
  const [bridges, setBridges] = useState<string[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  // null = closed; { vxlan: undefined } = create; { vxlan } = edit.
  const [modal, setModal] = useState<{ vxlan?: VxlanInterface } | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      // Interface + bridge names feed the source-interface / bridge pickers;
      // tolerate their failure.
      const [vx, ifs, brs] = await Promise.all([
        fetchVxlan(),
        fetchInterfaceStats().catch(() => []),
        fetchBridges().catch(() => []),
      ]);
      setRows(vx);
      setInterfaces(ifs.map((i) => i.name).filter((n) => !n.startsWith("vxlan")).sort());
      setBridges(brs.map((b) => b.name).sort());
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load VXLAN interfaces.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async (row: VxlanInterface) => {
    try {
      await deleteVxlan(row.name);
      setToast(`Deleted ${row.name}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete ${row.name}.`);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          VXLAN Interfaces
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Layer 2/3 overlay tunnel endpoints (VTEPs) — EVPN fabric, static unicast, or multicast
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && (
          <div className="text-[13px] text-[var(--qz-fg-4)]">Loading VXLAN interfaces…</div>
        )}
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
        {status === "ready" && (
          <DataTable
            rows={rows}
            columns={columns}
            filters={filters}
            rowId={(r) => r.name}
            storageKey="interfaces-vxlan"
            searchPlaceholder="Search VXLAN…"
            emptyMessage="No VXLAN interfaces configured."
            onRefresh={() => load("refresh")}
            toolbar={
              <Button kind="primary" size="sm" icon={Plus} onClick={() => setModal({})}>
                Create VXLAN
              </Button>
            }
            actions={(row) => (
              <RowActions
                label={row.name}
                onEdit={() => setModal({ vxlan: row })}
                onDelete={() => remove(row)}
              />
            )}
          />
        )}
      </div>

      {modal && (
        <VxlanFormModal
          initial={modal.vxlan}
          interfaces={interfaces}
          bridges={bridges}
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
