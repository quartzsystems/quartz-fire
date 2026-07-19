"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Plus, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { RowActions } from "@/components/dashboard/RowActions";
import {
  L2tpConfig,
  L2tpPool,
  L2tpRadiusServer,
  L2tpUser,
  deleteL2tpPool,
  deleteL2tpRadius,
  deleteL2tpUser,
  fetchL2tp,
} from "@/lib/l2tp";
import { useDashboard } from "@/lib/DashboardContext";
import { GeneralPanel } from "./GeneralPanel";
import { UserFormModal } from "./UserFormModal";
import { PoolFormModal } from "./PoolFormModal";
import { RadiusFormModal } from "./RadiusFormModal";
import { L2tpStatusPanel } from "./L2tpStatusPanel";

type Tab = "general" | "users" | "pools" | "radius" | "status";

const dash = (v: string | null) => (v && v.length ? v : "—");

const userColumns: Column<L2tpUser>[] = [
  { key: "username", header: "Username", value: (r) => r.username, mono: true, sortable: true },
  { key: "static", header: "Static IP", value: (r) => r.static_ip ?? "", render: (r) => <span style={{ fontFamily: "var(--qz-font-mono)" }}>{dash(r.static_ip)}</span> },
  {
    key: "state",
    header: "State",
    value: (r) => (r.disabled ? "disabled" : "enabled"),
    render: (r) => <span className={r.disabled ? "badge badge-muted" : "badge badge-success"}>{r.disabled ? "Disabled" : "Enabled"}</span>,
    width: 120,
  },
];

const poolColumns: Column<L2tpPool>[] = [
  { key: "name", header: "Name", value: (r) => r.name, mono: true, sortable: true, width: 200 },
  { key: "range", header: "Range", value: (r) => r.range ?? "", render: (r) => <span style={{ fontFamily: "var(--qz-font-mono)" }}>{dash(r.range)}</span> },
];

const radiusColumns: Column<L2tpRadiusServer>[] = [
  { key: "address", header: "Address", value: (r) => r.address, mono: true, sortable: true, width: 200 },
  { key: "port", header: "Port", value: (r) => r.port ?? 1812, render: (r) => String(r.port ?? 1812), mono: true, width: 100 },
  {
    key: "state",
    header: "State",
    value: (r) => (r.disabled ? "disabled" : "enabled"),
    render: (r) => <span className={r.disabled ? "badge badge-muted" : "badge badge-success"}>{r.disabled ? "Disabled" : "Enabled"}</span>,
    width: 120,
  },
];

export default function L2tpPage() {
  const { setToast } = useDashboard();
  const [cfg, setCfg] = useState<L2tpConfig | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [tab, setTab] = useState<Tab>("general");

  const [userModal, setUserModal] = useState<{ user?: L2tpUser } | null>(null);
  const [poolModal, setPoolModal] = useState<{ pool?: L2tpPool } | null>(null);
  const [radiusModal, setRadiusModal] = useState<{ server?: L2tpRadiusServer } | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      setCfg(await fetchL2tp());
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load L2TP configuration.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const saved = (msg: string) => {
    setUserModal(null);
    setPoolModal(null);
    setRadiusModal(null);
    setToast(msg);
    load("refresh");
  };

  const removeUser = async (row: L2tpUser) => {
    try {
      await deleteL2tpUser(row.username);
      setToast(`Deleted user ${row.username}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete ${row.username}.`);
    }
  };
  const removePool = async (row: L2tpPool) => {
    try {
      await deleteL2tpPool(row.name);
      setToast(`Deleted pool ${row.name}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete ${row.name}.`);
    }
  };
  const removeRadius = async (row: L2tpRadiusServer) => {
    try {
      await deleteL2tpRadius(row.address);
      setToast(`Deleted RADIUS server ${row.address}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete ${row.address}.`);
    }
  };

  const tabs: [Tab, string, number | null][] = [
    ["general", "General", null],
    ["users", "Users", cfg?.users.length ?? 0],
    ["pools", "IP Pools", cfg?.pools.length ?? 0],
    ["radius", "RADIUS", cfg?.radius_servers.length ?? 0],
    ["status", "Status", null],
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          L2TP
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          L2TP/IPsec remote-access server — dial-in VPN for roaming clients
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && <div className="text-[13px] text-[var(--qz-fg-4)]">Loading L2TP configuration…</div>}
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
                const active = tab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTab(id)}
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

            {tab === "general" && (
              <GeneralPanel
                live={cfg.general}
                pools={cfg.pools.map((p) => p.name)}
                onSaved={(msg) => { setToast(msg); load("refresh"); }}
              />
            )}

            {tab === "users" && (
              <DataTable
                rows={cfg.users}
                columns={userColumns}
                rowId={(r) => r.username}
                storageKey="vpn-l2tp-users"
                searchPlaceholder="Search users…"
                emptyMessage="No L2TP users configured."
                onRefresh={() => load("refresh")}
                toolbar={<Button kind="primary" size="sm" icon={Plus} onClick={() => setUserModal({})}>Add user</Button>}
                actions={(row) => <RowActions label={`user ${row.username}`} onEdit={() => setUserModal({ user: row })} onDelete={() => removeUser(row)} />}
              />
            )}

            {tab === "pools" && (
              <DataTable
                rows={cfg.pools}
                columns={poolColumns}
                rowId={(r) => r.name}
                storageKey="vpn-l2tp-pools"
                searchPlaceholder="Search pools…"
                emptyMessage="No IP pools configured."
                onRefresh={() => load("refresh")}
                toolbar={<Button kind="primary" size="sm" icon={Plus} onClick={() => setPoolModal({})}>Add pool</Button>}
                actions={(row) => <RowActions label={`pool ${row.name}`} onEdit={() => setPoolModal({ pool: row })} onDelete={() => removePool(row)} />}
              />
            )}

            {tab === "radius" && (
              <DataTable
                rows={cfg.radius_servers}
                columns={radiusColumns}
                rowId={(r) => r.address}
                storageKey="vpn-l2tp-radius"
                searchPlaceholder="Search servers…"
                emptyMessage="No RADIUS servers configured."
                onRefresh={() => load("refresh")}
                toolbar={<Button kind="primary" size="sm" icon={Plus} onClick={() => setRadiusModal({})}>Add server</Button>}
                actions={(row) => <RowActions label={`RADIUS server ${row.address}`} onEdit={() => setRadiusModal({ server: row })} onDelete={() => removeRadius(row)} />}
              />
            )}

            {tab === "status" && <L2tpStatusPanel />}
          </div>
        )}
      </div>

      {userModal && cfg && (
        <UserFormModal initial={userModal.user} existingNames={cfg.users.map((u) => u.username)} onClose={() => setUserModal(null)} onSaved={saved} />
      )}
      {poolModal && cfg && (
        <PoolFormModal initial={poolModal.pool} existingNames={cfg.pools.map((p) => p.name)} onClose={() => setPoolModal(null)} onSaved={saved} />
      )}
      {radiusModal && cfg && (
        <RadiusFormModal initial={radiusModal.server} existingAddresses={cfg.radius_servers.map((s) => s.address)} onClose={() => setRadiusModal(null)} onSaved={saved} />
      )}
    </div>
  );
}
