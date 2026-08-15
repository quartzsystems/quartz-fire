"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { Tabs } from "@/components/ui/Tabs";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { RowActions } from "@/components/dashboard/RowActions";
import { IsisConfig, IsisInterface, deleteIsisInterface, fetchIsis } from "@/lib/isis";
import { fetchInterfaceStats } from "@/lib/vyos";
import { useDashboard } from "@/lib/DashboardContext";
import { IsisGlobalPanel } from "./IsisGlobalPanel";
import { IsisStatusPanel } from "./IsisStatusPanel";
import { InterfaceFormModal } from "./InterfaceFormModal";

type Section = "global" | "interfaces" | "status";

const dash = (v: string | null) => (v && v.length ? v : "—");

function interfaceColumns(): Column<IsisInterface>[] {
  return [
    { key: "name", header: "Interface", value: (r) => r.name, mono: true, sortable: true, width: 140 },
    { key: "circuit_type", header: "Circuit type", value: (r) => r.circuit_type ?? "", render: (r) => dash(r.circuit_type), mono: true, sortable: true, width: 150 },
    { key: "metric", header: "Metric", value: (r) => r.metric ?? -1, render: (r) => (r.metric == null ? "—" : String(r.metric)), mono: true, width: 100 },
    {
      key: "timers",
      header: "Hello / Mult",
      value: (r) => `${r.hello_interval ?? ""}/${r.hello_multiplier ?? ""}`,
      render: (r) => (r.hello_interval == null && r.hello_multiplier == null ? "—" : `${r.hello_interval ?? "—"} / ${r.hello_multiplier ?? "—"}`),
      mono: true,
      width: 130,
    },
    {
      key: "flags",
      header: "Flags",
      value: (r) => [r.point_to_point && "p2p", r.passive && "passive", r.bfd && "bfd", r.password && "auth"].filter(Boolean).join(","),
      render: (r) => {
        const flags = [r.point_to_point && "p2p", r.passive && "passive", r.bfd && "BFD", r.password && "auth"].filter(Boolean) as string[];
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

export default function IsisPage() {
  const { setToast } = useDashboard();
  const [cfg, setCfg] = useState<IsisConfig | null>(null);
  const [interfaces, setInterfaces] = useState<string[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [section, setSection] = useState<Section>("global");

  const [ifaceModal, setIfaceModal] = useState<{ iface?: IsisInterface } | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      const [isis, ifs] = await Promise.all([fetchIsis(), fetchInterfaceStats().catch(() => [])]);
      setCfg(isis);
      setInterfaces(ifs.map((i) => i.name).sort());
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load IS-IS configuration.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const saved = (msg: string) => {
    setIfaceModal(null);
    setToast(msg);
    load("refresh");
  };

  const removeIface = async (row: IsisInterface) => {
    try {
      await deleteIsisInterface(row.name);
      setToast(`Deleted IS-IS interface ${row.name}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete interface ${row.name}.`);
    }
  };

  const tabs: [Section, string, number | null][] = [
    ["global", "Global", null],
    ["interfaces", "Interfaces", cfg?.interfaces.length ?? 0],
    ["status", "Status", null],
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h2 style={{ margin: 0 }}>IS-IS</h2>
        <p className="clr-secondary" style={{ marginTop: 4 }}>
          Intermediate System to Intermediate System — link-state IGP for the underlay.
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && <div className="clr-secondary">Loading IS-IS configuration…</div>}
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
          <div className="flex flex-col gap-5">
            <Tabs
              items={tabs.map(([id, label, count]) => ({ value: id, label, count: count ?? undefined }))}
              value={section}
              onChange={(v) => setSection(v as Section)}
            />

            {section === "global" && (
              <IsisGlobalPanel live={cfg.global} onSaved={(msg) => { setToast(msg); load("refresh"); }} />
            )}

            {section === "status" && <IsisStatusPanel />}

            {section === "interfaces" && (
              <DataTable
                rows={cfg.interfaces}
                columns={interfaceColumns()}
                rowId={(r) => r.name}
                storageKey="routing-isis-interfaces"
                searchPlaceholder="Search interfaces…"
                emptyMessage="No IS-IS interfaces configured."
                onRefresh={() => load("refresh")}
                onRowOpen={(row) => setIfaceModal({ iface: row })}
                toolbar={
                  <Button kind="primary" size="sm" onClick={() => setIfaceModal({})}>
                    Add Interface
                  </Button>
                }
                actions={(row) => (
                  <RowActions label={`interface ${row.name}`} onEdit={() => setIfaceModal({ iface: row })} onDelete={() => removeIface(row)} />
                )}
              />
            )}
          </div>
        )}
      </div>

      {ifaceModal && cfg && (
        <InterfaceFormModal
          initial={ifaceModal.iface}
          existingNames={cfg.interfaces.map((i) => i.name)}
          interfaces={interfaces}
          onClose={() => setIfaceModal(null)}
          onSaved={saved}
        />
      )}
    </div>
  );
}
