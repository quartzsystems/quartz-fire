"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { Tabs } from "@/components/ui/Tabs";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { RowActions } from "@/components/dashboard/RowActions";
import {
  OspfArea,
  OspfConfig,
  OspfInterface,
  deleteOspfArea,
  deleteOspfInterface,
  fetchOspf,
} from "@/lib/ospf";
import { fetchInterfaceStats } from "@/lib/vyos";
import { useDashboard } from "@/lib/DashboardContext";
import { OspfGlobalPanel } from "./OspfGlobalPanel";
import { OspfStatusPanel } from "./OspfStatusPanel";
import { AreaFormModal } from "./AreaFormModal";
import { InterfaceFormModal } from "./InterfaceFormModal";

type Section = "global" | "areas" | "interfaces" | "status";

const dash = (v: string | null) => (v && v.length ? v : "—");

const AREA_TYPE_LABEL: Record<OspfArea["area_type"], string> = {
  normal: "Normal",
  stub: "Stub",
  nssa: "NSSA",
};

function areaColumns(): Column<OspfArea>[] {
  return [
    { key: "area", header: "Area", value: (r) => r.area, mono: true, sortable: true, width: 140 },
    {
      key: "type",
      header: "Type",
      value: (r) => r.area_type,
      render: (r) => (
        <span className={r.area_type === "normal" ? "badge badge-muted" : "badge badge-info"}>
          {AREA_TYPE_LABEL[r.area_type]}
          {r.no_summary && r.area_type !== "normal" ? " · no-summary" : ""}
        </span>
      ),
      sortable: true,
      width: 170,
    },
    {
      key: "networks",
      header: "Networks",
      value: (r) => r.networks.join(","),
      render: (r) => (r.networks.length ? <span style={{ fontFamily: "var(--qz-font-mono)" }}>{r.networks.join(", ")}</span> : "—"),
    },
    {
      key: "ranges",
      header: "Ranges",
      value: (r) => r.ranges.join(","),
      render: (r) => (r.ranges.length ? <span style={{ fontFamily: "var(--qz-font-mono)" }}>{r.ranges.join(", ")}</span> : "—"),
      width: 180,
    },
  ];
}

function interfaceColumns(): Column<OspfInterface>[] {
  return [
    { key: "name", header: "Interface", value: (r) => r.name, mono: true, sortable: true, width: 130 },
    { key: "area", header: "Area", value: (r) => r.area ?? "", render: (r) => dash(r.area), mono: true, sortable: true, width: 120 },
    { key: "cost", header: "Cost", value: (r) => r.cost ?? -1, render: (r) => (r.cost == null ? "—" : String(r.cost)), mono: true, width: 90 },
    { key: "network", header: "Network type", value: (r) => r.network_type ?? "", render: (r) => dash(r.network_type), mono: true, width: 160 },
    {
      key: "timers",
      header: "Hello / dead",
      value: (r) => `${r.hello_interval ?? ""}/${r.dead_interval ?? ""}`,
      render: (r) => (r.hello_interval == null && r.dead_interval == null ? "—" : `${r.hello_interval ?? "—"} / ${r.dead_interval ?? "—"}`),
      mono: true,
      width: 130,
    },
    {
      key: "flags",
      header: "Flags",
      value: (r) => [r.passive && "passive", r.bfd && "bfd", r.mtu_ignore && "mtu-ignore", r.auth_password && "auth"].filter(Boolean).join(","),
      render: (r) => {
        const flags = [r.passive && "passive", r.bfd && "BFD", r.mtu_ignore && "mtu-ignore", r.auth_password && "auth"].filter(Boolean) as string[];
        return flags.length ? (
          <span className="inline-flex gap-1 flex-wrap">
            {flags.map((f) => <span key={f} className="badge badge-muted">{f}</span>)}
          </span>
        ) : <span style={{ color: "var(--cds-alias-typography-color-200)" }}>—</span>;
      },
      width: 200,
    },
  ];
}

export default function OspfPage() {
  const { setToast } = useDashboard();
  const [cfg, setCfg] = useState<OspfConfig | null>(null);
  const [interfaces, setInterfaces] = useState<string[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [section, setSection] = useState<Section>("global");
  const [refreshing, setRefreshing] = useState(false);

  const [areaModal, setAreaModal] = useState<{ area?: OspfArea } | null>(null);
  const [ifaceModal, setIfaceModal] = useState<{ iface?: OspfInterface } | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      const [ospf, ifs] = await Promise.all([fetchOspf(), fetchInterfaceStats().catch(() => [])]);
      setCfg(ospf);
      setInterfaces(ifs.map((i) => i.name).sort());
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load OSPF configuration.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await load("refresh");
    } finally {
      setRefreshing(false);
    }
  };

  const saved = (msg: string) => {
    setAreaModal(null);
    setIfaceModal(null);
    setToast(msg);
    load("refresh");
  };

  const removeArea = async (row: OspfArea) => {
    try {
      await deleteOspfArea(row.area);
      setToast(`Deleted area ${row.area}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete area ${row.area}.`);
    }
  };
  const removeIface = async (row: OspfInterface) => {
    try {
      await deleteOspfInterface(row.name);
      setToast(`Deleted OSPF interface ${row.name}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete interface ${row.name}.`);
    }
  };

  const tabs: [Section, string, number | null][] = [
    ["global", "Global", null],
    ["areas", "Areas", cfg?.areas.length ?? 0],
    ["interfaces", "Interfaces", cfg?.interfaces.length ?? 0],
    ["status", "Status", null],
  ];

  // Header "Add" control follows the active tab (DC pattern: one primary
  // button in the page-header row whose label tracks the tab).
  const addAction =
    section === "areas"
      ? { label: "Add Area", onClick: () => setAreaModal({}) }
      : { label: "Add Interface", onClick: () => setIfaceModal({}) };

  return (
    <div className="flex flex-col" style={{ gap: 12 }}>
      <div className="flex items-start gap-2">
        <div className="mr-auto">
          <h2 className="m-0">OSPF</h2>
          <p className="clr-secondary" style={{ marginTop: 4 }}>
            Open Shortest Path First (OSPFv2) — link-state IGP for the IPv4 underlay.
          </p>
        </div>
        {status === "ready" && (
          <>
            <Button kind="outline" onClick={refresh} disabled={refreshing}>
              {refreshing ? "Refreshing…" : "Refresh"}
            </Button>
            <Button kind="primary" onClick={addAction.onClick}>{addAction.label}</Button>
          </>
        )}
      </div>

      {status === "loading" && <div className="clr-secondary">Loading OSPF configuration…</div>}
      {status === "error" && (
        <div className="flex flex-col gap-3">
          <div className="alert alert-danger alert-sm">
            <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
            <div className="alert-text">{errorMsg}</div>
          </div>
          <div>
            <Button kind="secondary" icon="refresh" onClick={() => load()}>Retry</Button>
          </div>
        </div>
      )}
      {status === "ready" && cfg && (
        <>
          <Tabs
            items={tabs.map(([id, label, count]) => ({ value: id, label, count: count ?? undefined }))}
            value={section}
            onChange={(v) => setSection(v as Section)}
          />

          {section === "global" && (
            <OspfGlobalPanel live={cfg.global} onSaved={(msg) => { setToast(msg); load("refresh"); }} />
          )}

          {section === "status" && <OspfStatusPanel />}

          {section === "areas" && (
            <DataTable searchable={false}
              rows={cfg.areas}
              columns={areaColumns()}
              rowId={(r) => r.area}
              storageKey="routing-ospf-areas"
              searchPlaceholder="Search areas…"
              emptyMessage="No OSPF areas configured."
              onRowOpen={(row) => setAreaModal({ area: row })}
              actions={(row) => (
                <RowActions label={`area ${row.area}`} onEdit={() => setAreaModal({ area: row })} onDelete={() => removeArea(row)} />
              )}
            />
          )}

          {section === "interfaces" && (
            <DataTable searchable={false}
              rows={cfg.interfaces}
              columns={interfaceColumns()}
              rowId={(r) => r.name}
              storageKey="routing-ospf-interfaces"
              searchPlaceholder="Search interfaces…"
              emptyMessage="No OSPF interfaces configured."
              onRowOpen={(row) => setIfaceModal({ iface: row })}
              actions={(row) => (
                <RowActions label={`interface ${row.name}`} onEdit={() => setIfaceModal({ iface: row })} onDelete={() => removeIface(row)} />
              )}
            />
          )}
        </>
      )}

      {areaModal && cfg && (
        <AreaFormModal
          initial={areaModal.area}
          existingAreas={cfg.areas.map((a) => a.area)}
          onClose={() => setAreaModal(null)}
          onSaved={saved}
        />
      )}
      {ifaceModal && cfg && (
        <InterfaceFormModal
          initial={ifaceModal.iface}
          existingNames={cfg.interfaces.map((i) => i.name)}
          areas={cfg.areas.map((a) => a.area)}
          interfaces={interfaces}
          onClose={() => setIfaceModal(null)}
          onSaved={saved}
        />
      )}
    </div>
  );
}
