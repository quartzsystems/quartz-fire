"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Plus, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
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
    { key: "circuit_type", header: "Circuit Type", value: (r) => r.circuit_type ?? "", render: (r) => dash(r.circuit_type), mono: true, sortable: true, width: 150 },
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
        ) : <span className="text-[var(--qz-fg-4)]">—</span>;
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
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          IS-IS
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Intermediate System to Intermediate System — link-state IGP for the underlay
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && <div className="text-[13px] text-[var(--qz-fg-4)]">Loading IS-IS configuration…</div>}
        {status === "error" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-[13px] text-[var(--qz-danger)]">
              <AlertTriangle size={15} />
              {errorMsg}
            </div>
            <div>
              <Button kind="secondary" icon={RotateCw} onClick={() => load()}>Retry</Button>
            </div>
          </div>
        )}
        {status === "ready" && cfg && (
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-1 border-b border-[var(--qz-border)]">
              {tabs.map(([id, label, count]) => {
                const active = section === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setSection(id)}
                    className={[
                      "px-3 py-2 text-[13px] font-medium border-b-2 -mb-px transition-colors cursor-pointer",
                      active ? "text-[var(--qz-accent)] border-[var(--qz-accent)]" : "text-[var(--qz-fg-3)] border-transparent hover:text-[var(--qz-fg-1)]",
                    ].join(" ")}
                  >
                    {label}
                    {count !== null && <span className="ml-[6px] text-[12px] text-[var(--qz-fg-4)]">{count}</span>}
                  </button>
                );
              })}
            </div>

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
                toolbar={
                  <Button kind="primary" size="sm" icon={Plus} onClick={() => setIfaceModal({})}>
                    Add interface
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
