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
  deleteBond,
  effectiveMtu,
  fetchBonds,
  fetchBridges,
  fetchEthernet,
  fetchPhysicalEthernet,
} from "@/lib/interfaces";
import { useDashboard } from "@/lib/DashboardContext";
import { BondFormModal } from "./BondFormModal";

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

const columns: Column<BondInterface>[] = [
  { key: "name", header: "Interface", value: (r) => r.name, mono: true, sortable: true, width: 120 },
  { key: "description", header: "Description", value: (r) => r.description ?? "", sortable: true },
  { key: "mode", header: "Mode", value: (r) => r.mode ?? "802.3ad", mono: true, sortable: true, width: 140 },
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
  { key: "mtu", header: "MTU", value: (r) => effectiveMtu(r.mtu, "bonding"), render: (r) => <MtuCell mtu={r.mtu} kind="bonding" />, mono: true, sortable: true, width: 80 },
  {
    key: "status",
    header: "Status",
    value: (r) => (r.enabled ? "enabled" : "disabled"),
    render: (r) => <StatusPill enabled={r.enabled} />,
    sortable: true,
    width: 120,
  },
];

const filters: FilterDef<BondInterface>[] = [
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

export default function BondingPage() {
  const { setToast } = useDashboard();
  const [rows, setRows] = useState<BondInterface[]>([]);
  const [bridges, setBridges] = useState<BridgeInterface[]>([]);
  const [ethNames, setEthNames] = useState<string[]>([]);
  const [addressedEth, setAddressedEth] = useState<string[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  // null = closed; { bond: undefined } = create; { bond } = edit.
  const [modal, setModal] = useState<{ bond?: BondInterface; candidates: string[] } | null>(null);

  const fetchData = useCallback(async () => {
    const [bonds, brs, physical, eths] = await Promise.all([
      fetchBonds(),
      fetchBridges(),
      fetchPhysicalEthernet(),
      fetchEthernet(),
    ]);
    setRows(bonds);
    setBridges(brs);
    setEthNames([...new Set([...physical.map((p) => p.name), ...eths.map((e) => e.name)])].sort());
    setAddressedEth(eths.filter((e) => e.addresses.length > 0).map((e) => e.name));
  }, []);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      await fetchData();
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load bond interfaces.");
      setStatus("error");
    }
  }, [fetchData]);

  useEffect(() => {
    load();
  }, [load]);

  /// Ethernet interfaces free to enslave: not addressed, not in a bridge, not
  /// in another bond (the bond being edited keeps its own members selectable).
  const openModal = (bond?: BondInterface) => {
    const taken = new Set<string>([
      ...addressedEth,
      ...bridges.flatMap((b) => b.members),
      ...rows.filter((b) => b.name !== bond?.name).flatMap((b) => b.members),
    ]);
    setModal({ bond, candidates: ethNames.filter((n) => !taken.has(n)) });
  };

  const removeBond = async (row: BondInterface) => {
    try {
      await deleteBond(row.name);
      setToast(`Deleted ${row.name}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete ${row.name}.`);
    }
  };

  const headerBlock = (
    <div>
      <h2 className="m-0">Bonding</h2>
      <p className="clr-secondary" style={{ marginTop: 4 }}>
        Link-aggregation interfaces — members must carry no addresses and belong to no bridge.
      </p>
    </div>
  );

  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      {status !== "ready" && headerBlock}

      {status === "loading" && (
        <div className="clr-secondary">Loading bond interfaces…</div>
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
          storageKey="interfaces-bonding"
          searchPlaceholder="Search bonds…"
          emptyMessage="No bond interfaces configured."
          onRefresh={() => load("refresh")}
          onRowOpen={(row) => openModal(row)}
          headerLeft={headerBlock}
          toolbar={
            <Button kind="primary" onClick={() => openModal()}>
              Create Bond
            </Button>
          }
          actions={(row) => (
            <RowActions
              label={row.name}
              onEdit={() => openModal(row)}
              onDelete={() => removeBond(row)}
            />
          )}
        />
      )}

      {modal && (
        <BondFormModal
          initial={modal.bond}
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
