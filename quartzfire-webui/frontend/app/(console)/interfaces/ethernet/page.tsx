"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { Column, DataTable, FilterDef } from "@/components/dashboard/DataTable";
import { MtuCell } from "@/components/dashboard/MtuCell";
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

function StatePill({ enabled }: { enabled: boolean }) {
  return <span className={enabled ? "badge badge-ok" : "badge badge-muted"}>{enabled ? "Enabled" : "Disabled"}</span>;
}

function LinkPill({ link }: { link: LinkState }) {
  if (link === "unknown") return <span className="badge badge-muted">Unknown</span>;
  return <span className={link === "up" ? "badge badge-ok" : "badge badge-crit"}>{link === "up" ? "Up" : "Down"}</span>;
}

const columns: Column<EthRow>[] = [
  { key: "name", header: "Interface", value: (r) => r.name, mono: true, sortable: true, width: 130 },
  { key: "description", header: "Description", value: (r) => r.description ?? "", sortable: true },
  {
    key: "addresses",
    header: "IP Address",
    value: (r) => r.addresses.join(", "),
    render: (r) => (r.addresses.length ? r.addresses.join(", ") : "—"),
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
      if (!s) return <span style={{ color: "var(--cds-alias-typography-color-200)" }}>—</span>;
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
    render: (r) => <StatePill enabled={r.enabled} />,
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

  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      <div>
        <h2>Ethernet Interfaces</h2>
        <p className="clr-secondary" style={{ marginTop: 4 }}>Physical ethernet interfaces</p>
      </div>

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
          toolbar={
            <span title={freeNames.length === 0 ? "No free physical interfaces available" : undefined}>
              <Button
                kind="primary"
                size="sm"
                icon="plus"
                onClick={() => setModal({})}
                disabled={freeNames.length === 0}
              >
                Add Interface
              </Button>
            </span>
          }
          actions={(row) => (
            <div className="inline-flex items-center justify-end">
              <button
                type="button"
                title={`Edit ${row.name}`}
                aria-label="Edit"
                onClick={() => setModal({ eth: row })}
                className="btn btn-sm btn-link-neutral btn-icon"
              >
                <Icon shape="pencil" size={14} />
              </button>
            </div>
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
