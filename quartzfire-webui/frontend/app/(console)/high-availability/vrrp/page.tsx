"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { Tabs } from "@/components/ui/Tabs";
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
          <span style={{ color: "var(--cds-alias-typography-color-200)" }}>—</span>
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
          <span className="font-mono text-[12px]">{r.members.join(", ")}</span>
        ) : (
          <span style={{ color: "var(--cds-alias-typography-color-200)" }}>—</span>
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

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2>VRRP</h2>
        <p className="clr-secondary" style={{ marginTop: 4 }}>
          Virtual Router Redundancy Protocol — a floating gateway that fails over between routers
        </p>
      </div>

      {status === "loading" && <div className="clr-secondary">Loading VRRP configuration…</div>}
      {status === "error" && (
        <div className="alert alert-danger alert-sm">
          <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
          <div className="alert-text">{errorMsg}</div>
          <div className="alert-actions">
            <button type="button" className="alert-action" onClick={() => load()}>
              Retry
            </button>
          </div>
        </div>
      )}
      {status === "ready" && cfg && (
        <div className="flex flex-col gap-5">
          <Tabs
            items={[
              { value: "groups", label: "Groups", count: cfg.groups.length },
              { value: "sync-groups", label: "Sync Groups", count: cfg.syncGroups.length },
              { value: "global", label: "Global" },
            ]}
            value={section}
            onChange={(v) => setSection(v as Section)}
          />

          {section === "groups" && (
            <DataTable
              rows={cfg.groups}
              columns={groupColumns()}
              rowId={(r) => r.name}
              storageKey="ha-vrrp-groups"
              searchPlaceholder="Search groups…"
              emptyMessage="No VRRP groups configured."
              onRefresh={() => load("refresh")}
              onRowOpen={(row) => setGroupModal({ group: row })}
              toolbar={
                <Button kind="primary" size="sm" icon="plus" onClick={() => setGroupModal({})}>
                  Add Group
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
              onRowOpen={(row) => setSyncModal({ group: row })}
              toolbar={
                <Button kind="primary" size="sm" icon="plus" onClick={() => setSyncModal({})}>
                  Add Sync Group
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
