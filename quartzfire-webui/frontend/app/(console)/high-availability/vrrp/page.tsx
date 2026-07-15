"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Plus, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { RowActions } from "@/components/dashboard/RowActions";
import { useDashboard } from "@/lib/DashboardContext";
import { fetchInterfaceStats } from "@/lib/vyos";
import { bridgeVifInterfaceNames, fetchBridges } from "@/lib/interfaces";
import {
  VrrpConfig,
  VrrpGroup,
  VrrpSyncGroup,
  deleteGroup,
  deleteSyncGroup,
  fetchVrrp,
} from "@/lib/vrrp";
import { GroupFormModal } from "./GroupFormModal";
import { SyncGroupFormModal } from "./SyncGroupFormModal";
import { GlobalParametersPanel } from "./GlobalParametersPanel";

type Section = "groups" | "sync-groups" | "global";

const dash = (v: string | null) => (v && v.length ? v : "—");

function groupColumns(): Column<VrrpGroup>[] {
  return [
    { key: "name", header: "Name", value: (r) => r.name, mono: true, sortable: true },
    { key: "interface", header: "Interface", value: (r) => r.interface ?? "", render: (r) => dash(r.interface), mono: true, sortable: true, width: 120 },
    { key: "vrid", header: "VRID", value: (r) => r.vrid ?? 0, mono: true, sortable: true, width: 80 },
    { key: "priority", header: "Priority", value: (r) => r.priority ?? 100, mono: true, sortable: true, width: 90 },
    {
      key: "addresses",
      header: "Virtual Addresses",
      value: (r) => r.addresses.map((a) => a.address).join(", "),
      render: (r) =>
        r.addresses.length ? (
          <span className="font-mono text-[12px]">{r.addresses.map((a) => a.address).join(", ")}</span>
        ) : (
          <span className="text-[var(--qz-fg-4)]">—</span>
        ),
      width: 220,
    },
    {
      key: "status",
      header: "Status",
      value: (r) => (r.enabled ? "enabled" : "disabled"),
      render: (r) => <span className={r.enabled ? "badge badge-ok" : "badge badge-muted"}>{r.enabled ? "Enabled" : "Disabled"}</span>,
      sortable: true,
      width: 110,
    },
  ];
}

function syncColumns(): Column<VrrpSyncGroup>[] {
  return [
    { key: "name", header: "Name", value: (r) => r.name, mono: true, sortable: true },
    {
      key: "members",
      header: "Members",
      value: (r) => r.members.join(", "),
      render: (r) =>
        r.members.length ? (
          <span className="inline-flex gap-1 flex-wrap">
            {r.members.map((m) => (
              <span key={m} className="badge badge-info">{m}</span>
            ))}
          </span>
        ) : (
          <span className="text-[var(--qz-fg-4)]">—</span>
        ),
    },
  ];
}

export default function VrrpPage() {
  const { setToast } = useDashboard();
  const [cfg, setCfg] = useState<VrrpConfig | null>(null);
  const [interfaces, setInterfaces] = useState<string[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [section, setSection] = useState<Section>("groups");

  const [groupModal, setGroupModal] = useState<{ group?: VrrpGroup } | null>(null);
  const [syncModal, setSyncModal] = useState<{ group?: VrrpSyncGroup } | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      const [vrrp, ifs, bridges] = await Promise.all([
        fetchVrrp(),
        fetchInterfaceStats().catch(() => []),
        fetchBridges().catch(() => []),
      ]);
      setCfg(vrrp);
      // Merge operational interface names with config-derived bridge VIFs
      // (e.g. br0.10) so a VRRP group can bind to one right after it's created.
      const names = new Set(ifs.map((i) => i.name));
      for (const n of bridgeVifInterfaceNames(bridges)) names.add(n);
      setInterfaces([...names].sort((a, b) => a.localeCompare(b)));
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load VRRP configuration.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const groupNames = useMemo(() => (cfg?.groups ?? []).map((g) => g.name), [cfg]);

  const saved = (msg: string) => {
    setGroupModal(null);
    setSyncModal(null);
    setToast(msg);
    load("refresh");
  };

  const removeGroup = async (row: VrrpGroup) => {
    try {
      await deleteGroup(row.name);
      setToast(`Deleted VRRP group ${row.name}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete group ${row.name}.`);
    }
  };
  const removeSync = async (row: VrrpSyncGroup) => {
    try {
      await deleteSyncGroup(row.name);
      setToast(`Deleted sync-group ${row.name}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete sync-group ${row.name}.`);
    }
  };

  const tabs: [Section, string, number | null][] = [
    ["groups", "Groups", cfg?.groups.length ?? 0],
    ["sync-groups", "Sync Groups", cfg?.syncGroups.length ?? 0],
    ["global", "Global", null],
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          VRRP
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Virtual Router Redundancy Protocol — a floating gateway that fails over between routers
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && <div className="text-[13px] text-[var(--qz-fg-4)]">Loading VRRP configuration…</div>}
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

            {section === "groups" && (
              <DataTable
                rows={cfg.groups}
                columns={groupColumns()}
                rowId={(r) => r.name}
                storageKey="ha-vrrp-groups"
                searchPlaceholder="Search groups…"
                emptyMessage="No VRRP groups configured."
                onRefresh={() => load("refresh")}
                toolbar={
                  <Button kind="primary" size="sm" icon={Plus} onClick={() => setGroupModal({})}>
                    Add group
                  </Button>
                }
                actions={(row) => (
                  <RowActions label={`group ${row.name}`} onEdit={() => setGroupModal({ group: row })} onDelete={() => removeGroup(row)} />
                )}
              />
            )}

            {section === "sync-groups" && (
              <DataTable
                rows={cfg.syncGroups}
                columns={syncColumns()}
                rowId={(r) => r.name}
                storageKey="ha-vrrp-sync-groups"
                searchPlaceholder="Search sync-groups…"
                emptyMessage="No VRRP sync-groups configured."
                onRefresh={() => load("refresh")}
                toolbar={
                  <Button kind="primary" size="sm" icon={Plus} onClick={() => setSyncModal({})}>
                    Add sync-group
                  </Button>
                }
                actions={(row) => (
                  <RowActions label={`sync-group ${row.name}`} onEdit={() => setSyncModal({ group: row })} onDelete={() => removeSync(row)} />
                )}
              />
            )}

            {section === "global" && (
              <GlobalParametersPanel live={cfg.global} onSaved={(msg) => { setToast(msg); load("refresh"); }} />
            )}
          </div>
        )}
      </div>

      {groupModal && cfg && (
        <GroupFormModal
          initial={groupModal.group}
          existingNames={groupNames}
          interfaces={interfaces}
          onClose={() => setGroupModal(null)}
          onSaved={saved}
        />
      )}
      {syncModal && cfg && (
        <SyncGroupFormModal
          initial={syncModal.group}
          existingNames={cfg.syncGroups.map((s) => s.name)}
          groupNames={groupNames}
          onClose={() => setSyncModal(null)}
          onSaved={saved}
        />
      )}
    </div>
  );
}
