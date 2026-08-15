"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { Column, DataTable, FilterDef } from "@/components/dashboard/DataTable";
import { MtuCell } from "@/components/dashboard/MtuCell";
import { RowActions } from "@/components/dashboard/RowActions";
import {
  BondInterface,
  BridgeInterface,
  deleteBridge,
  effectiveMtu,
  fetchBonds,
  fetchBridges,
  fetchEthernet,
  fetchPhysicalEthernet,
} from "@/lib/interfaces";
import { useDashboard } from "@/lib/DashboardContext";
import { BridgeFormModal } from "./BridgeFormModal";

/// Clarity status pill (mono uppercase), per the design reference.
const pillStyle = { fontFamily: "var(--qz-font-mono)", letterSpacing: "0.06em" } as const;
const dim = (t: string) => <span style={{ color: "var(--cds-alias-typography-color-200)" }}>{t}</span>;

function StatusPill({ enabled }: { enabled: boolean }) {
  return (
    <span className={`label${enabled ? " label-success" : ""}`} style={pillStyle}>
      {enabled ? "ENABLED" : "DISABLED"}
    </span>
  );
}

const columns: Column<BridgeInterface>[] = [
  { key: "name", header: "Interface", value: (r) => r.name, mono: true, sortable: true, width: 120 },
  { key: "description", header: "Description", value: (r) => r.description ?? "", sortable: true },
  {
    key: "members",
    header: "Members",
    value: (r) => r.members.join(", "),
    render: (r) => (r.members.length ? r.members.join(", ") : dim("—")),
    mono: true,
  },
  {
    key: "addresses",
    header: "IP address",
    value: (r) => r.addresses.join(", "),
    render: (r) => (r.addresses.length ? r.addresses.join(", ") : dim("—")),
    mono: true,
  },
  {
    key: "vlan",
    header: "VLAN-aware",
    value: (r) => (r.vlan_aware ? "yes" : "no"),
    render: (r) =>
      r.vlan_aware ? (
        <span className="label label-info" style={pillStyle}>
          {r.vifs.length ? `AWARE · ${r.vifs.length} VIF${r.vifs.length === 1 ? "" : "s"}` : "AWARE"}
        </span>
      ) : (
        dim("—")
      ),
    sortable: true,
    width: 130,
  },
  { key: "mtu", header: "MTU", value: (r) => effectiveMtu(r.mtu, "bridge"), render: (r) => <MtuCell mtu={r.mtu} kind="bridge" />, mono: true, sortable: true, width: 80 },
  {
    key: "status",
    header: "Status",
    value: (r) => (r.enabled ? "enabled" : "disabled"),
    render: (r) => <StatusPill enabled={r.enabled} />,
    sortable: true,
    width: 120,
  },
];

const filters: FilterDef<BridgeInterface>[] = [
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

export default function BridgePage() {
  const { setToast } = useDashboard();
  const [rows, setRows] = useState<BridgeInterface[]>([]);
  const [bonds, setBonds] = useState<BondInterface[]>([]);
  const [ethNames, setEthNames] = useState<string[]>([]);
  const [addressedEth, setAddressedEth] = useState<string[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  // null = closed; { bridge: undefined } = create; { bridge } = edit.
  const [modal, setModal] = useState<{ bridge?: BridgeInterface; candidates: string[] } | null>(null);

  const fetchData = useCallback(async () => {
    const [brs, bds, physical, eths] = await Promise.all([
      fetchBridges(),
      fetchBonds(),
      fetchPhysicalEthernet(),
      fetchEthernet(),
    ]);
    setRows(brs);
    setBonds(bds);
    setEthNames([...new Set([...physical.map((p) => p.name), ...eths.map((e) => e.name)])].sort());
    setAddressedEth(eths.filter((e) => e.addresses.length > 0).map((e) => e.name));
  }, []);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      await fetchData();
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load bridge interfaces.");
      setStatus("error");
    }
  }, [fetchData]);

  useEffect(() => {
    load();
  }, [load]);

  /// Interfaces free to attach: ethernet NICs and bonds that carry no
  /// addresses, aren't enslaved to a bond, and aren't in another bridge (the
  /// bridge being edited keeps its own members selectable).
  const openModal = (bridge?: BridgeInterface) => {
    const taken = new Set<string>([
      ...addressedEth,
      ...bonds.flatMap((b) => b.members),
      ...bonds.filter((b) => b.addresses.length > 0).map((b) => b.name),
      ...rows.filter((b) => b.name !== bridge?.name).flatMap((b) => b.members),
    ]);
    const pool = [...ethNames, ...bonds.map((b) => b.name)];
    setModal({ bridge, candidates: pool.filter((n) => !taken.has(n)) });
  };

  const removeBridge = async (row: BridgeInterface) => {
    try {
      await deleteBridge(row.name);
      setToast(`Deleted ${row.name}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete ${row.name}.`);
    }
  };

  const headerBlock = (
    <div>
      <h2 className="m-0">Bridge</h2>
      <p className="clr-secondary" style={{ marginTop: 4 }}>
        Layer 2 bridges — VLAN-aware bridges can carry VLAN sub-interfaces and VXLAN VNI mappings.
      </p>
    </div>
  );

  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      {status !== "ready" && headerBlock}

      {status === "loading" && (
        <div className="clr-secondary">Loading bridge interfaces…</div>
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
          storageKey="interfaces-bridge"
          searchPlaceholder="Search bridges…"
          emptyMessage="No bridge interfaces configured."
          onRefresh={() => load("refresh")}
          onRowOpen={(row) => openModal(row)}
          headerLeft={headerBlock}
          toolbar={
            <Button kind="primary" onClick={() => openModal()}>
              Create Bridge
            </Button>
          }
          actions={(row) => (
            <RowActions
              label={row.name}
              onEdit={() => openModal(row)}
              onDelete={() => removeBridge(row)}
            />
          )}
        />
      )}

      {modal && (
        <BridgeFormModal
          initial={modal.bridge}
          candidates={modal.candidates}
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
