"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { Column, DataTable, FilterDef } from "@/components/dashboard/DataTable";
import { MtuCell } from "@/components/dashboard/MtuCell";
import { RowActions } from "@/components/dashboard/RowActions";
import {
  EthernetInterface,
  LinkState,
  PhyInfo,
  effectiveMtu,
  fetchEthernet,
  fetchEthernetPhy,
  fetchPhysicalEthernet,
  formatSpeed,
} from "@/lib/interfaces";
import { useDashboard } from "@/lib/DashboardContext";
import { EthernetFormModal } from "./EthernetFormModal";

/// Configured interface plus its operational link (carrier) state and
/// negotiated speed.
type EthRow = EthernetInterface & { link: LinkState; phy: PhyInfo | null };

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

function LinkPill({ link }: { link: LinkState }) {
  if (link === "unknown") return <span className="label" style={pillStyle}>UNKNOWN</span>;
  return (
    <span className={link === "up" ? "label label-success" : "label label-danger"} style={pillStyle}>
      {link === "up" ? "UP" : "DOWN"}
    </span>
  );
}

const columns: Column<EthRow>[] = [
  { key: "name", header: "Interface", value: (r) => r.name, mono: true, sortable: true, width: 130 },
  {
    key: "description",
    header: "Description",
    value: (r) => r.description ?? "",
    render: (r) => r.description || dim("—"),
    sortable: true,
  },
  {
    key: "addresses",
    header: "IP address",
    value: (r) => r.addresses.join(", "),
    render: (r) => (r.addresses.length ? r.addresses.join(", ") : dim("—")),
    mono: true,
  },
  { key: "mtu", header: "MTU", value: (r) => effectiveMtu(r.mtu, "ethernet"), render: (r) => <MtuCell mtu={r.mtu} kind="ethernet" />, mono: true, sortable: true, width: 80 },
  { key: "hw_id", header: "MAC", value: (r) => r.hw_id ?? "", mono: true, width: 150 },
  { key: "vlan_count", header: "VLANs", value: (r) => r.vlan_count, mono: true, sortable: true, width: 80 },
  {
    key: "link",
    header: "Link",
    value: (r) => r.link,
    render: (r) => <LinkPill link={r.link} />,
    sortable: true,
    width: 100,
  },
  {
    key: "speed",
    header: "Speed",
    value: (r) => r.phy?.speed_mbps ?? 0,
    render: (r) => {
      const s = formatSpeed(r.phy?.speed_mbps ?? null);
      if (!s) return dim("—");
      return <span title={r.phy?.duplex ? `${r.phy.duplex} duplex` : undefined}>{s}</span>;
    },
    mono: true,
    sortable: true,
    width: 100,
  },
  {
    key: "status",
    header: "Status",
    value: (r) => (r.enabled ? "enabled" : "disabled"),
    render: (r) => <StatusPill enabled={r.enabled} />,
    sortable: true,
    width: 120,
  },
];

const filters: FilterDef<EthRow>[] = [
  {
    key: "link",
    label: "Link",
    options: [
      { value: "up", label: "Up" },
      { value: "down", label: "Down" },
    ],
    predicate: (r, v) => r.link === v,
  },
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

export default function EthernetPage() {
  const { setToast } = useDashboard();
  const [rows, setRows] = useState<EthRow[]>([]);
  const [physical, setPhysical] = useState<string[]>([]);
  const [phyByName, setPhyByName] = useState<Record<string, PhyInfo>>({});
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  // null = closed; { eth: undefined } = add; { eth } = edit.
  const [modal, setModal] = useState<{ eth?: EthernetInterface } | null>(null);

  const fetchData = useCallback(async () => {
    const [eths, phys, phyInfos] = await Promise.all([
      fetchEthernet(),
      fetchPhysicalEthernet(),
      // Best-effort: without phy data the Speed column shows — and the
      // editor offers every speed.
      fetchEthernetPhy().catch(() => [] as PhyInfo[]),
    ]);
    const phy = Object.fromEntries(phyInfos.map((p) => [p.name, p]));
    setRows(
      eths.map((e) => ({
        ...e,
        link: phys.find((p) => p.name === e.name)?.link ?? "unknown",
        phy: phy[e.name] ?? null,
      })),
    );
    setPhysical(phys.map((p) => p.name));
    setPhyByName(phy);
  }, []);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      await fetchData();
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load interfaces.");
      setStatus("error");
    }
  }, [fetchData]);

  useEffect(() => {
    load();
  }, [load]);

  // Physical NICs that have no configured interface yet — the only ones addable.
  const freeNames = useMemo(
    () => physical.filter((p) => !rows.some((r) => r.name === p)),
    [physical, rows],
  );

  const headerBlock = (
    <div>
      <h2 className="m-0">Ethernet</h2>
      <p className="clr-secondary" style={{ marginTop: 4 }}>
        Physical ethernet interfaces — link state and negotiated speed are read live.
      </p>
    </div>
  );

  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      {status !== "ready" && headerBlock}

      {status === "loading" && (
        <div className="clr-secondary">Loading interfaces…</div>
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
          storageKey="interfaces-ethernet"
          searchPlaceholder="Search interfaces…"
          emptyMessage="No ethernet interfaces configured."
          onRefresh={() => load("refresh")}
          onRowOpen={(row) => setModal({ eth: row })}
          headerLeft={headerBlock}
          toolbar={
            <span title={freeNames.length === 0 ? "No free physical interfaces available" : undefined}>
              <Button
                kind="primary"
                onClick={() => setModal({})}
                disabled={freeNames.length === 0}
              >
                Add Interface
              </Button>
            </span>
          }
          actions={(row) => (
            <RowActions label={row.name} onEdit={() => setModal({ eth: row })} />
          )}
        />
      )}

      {modal && (
        <EthernetFormModal
          initial={modal.eth}
          freeNames={freeNames}
          phyByName={phyByName}
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
