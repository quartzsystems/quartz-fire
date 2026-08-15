"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { Tabs } from "@/components/ui/Tabs";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { RowActions } from "@/components/dashboard/RowActions";
import { deleteStaticRoute, fetchStaticRoutes, RouteFamily, StaticRoute } from "@/lib/routing";
import { fetchInterfaceDescriptions } from "@/lib/interfaces";
import { fetchInterfaceStats } from "@/lib/vyos";
import { useDashboard } from "@/lib/DashboardContext";
import { StaticRouteFormModal } from "./StaticRouteFormModal";

const KIND_LABEL: Record<StaticRoute["kind"], string> = {
  gateway: "Gateway",
  interface: "Interface",
  blackhole: "Blackhole",
};

const KIND_BADGE: Record<StaticRoute["kind"], string> = {
  gateway: "badge-ok",
  interface: "badge-info",
  blackhole: "badge-muted",
};

const dash = (v: string | null) => (v && v.length ? v : "—");

const columns: Column<StaticRoute>[] = [
  { key: "destination", header: "Destination", value: (r) => r.destination, mono: true, sortable: true },
  {
    key: "kind",
    header: "Type",
    value: (r) => r.kind,
    render: (r) => <span className={`badge ${KIND_BADGE[r.kind]}`}>{KIND_LABEL[r.kind]}</span>,
    sortable: true,
    width: 110,
  },
  {
    key: "via",
    header: "Next hop",
    value: (r) => r.via ?? "",
    render: (r) =>
      r.kind === "blackhole" ? (
        <span style={{ color: "var(--cds-alias-typography-color-200)" }}>drop</span>
      ) : (
        dash(r.via)
      ),
    mono: true,
    sortable: true,
  },
  { key: "interface", header: "Interface", value: (r) => r.interface ?? "", render: (r) => dash(r.interface), mono: true, width: 110 },
  { key: "distance", header: "Distance", value: (r) => r.distance ?? 1, mono: true, sortable: true, width: 100 },
  { key: "description", header: "Description", value: (r) => r.description ?? "", render: (r) => dash(r.description), sortable: true },
  {
    key: "status",
    header: "Status",
    value: (r) => (r.enabled ? "enabled" : "disabled"),
    render: (r) => (
      <span className={r.enabled ? "badge badge-ok" : "badge badge-muted"}>{r.enabled ? "Enabled" : "Disabled"}</span>
    ),
    sortable: true,
    width: 110,
  },
];

export default function StaticRoutesPage() {
  const { setToast } = useDashboard();
  const [routes, setRoutes] = useState<StaticRoute[]>([]);
  const [interfaces, setInterfaces] = useState<string[]>([]);
  const [ifaceDescriptions, setIfaceDescriptions] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [tab, setTab] = useState<RouteFamily>("ipv4");

  // null = closed; { route: undefined } = create; { route } = edit.
  const [modal, setModal] = useState<{ route?: StaticRoute } | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      // Interface names populate the route form's pickers; tolerate their
      // failure so a routing read still renders.
      const [rts, ifs, descs] = await Promise.all([
        fetchStaticRoutes(),
        fetchInterfaceStats().catch(() => []),
        fetchInterfaceDescriptions().catch(() => ({})),
      ]);
      setRoutes(rts);
      setInterfaces(ifs.map((i) => i.name).sort());
      setIfaceDescriptions(descs);
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load static routes.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(() => routes.filter((r) => r.family === tab), [routes, tab]);

  const remove = async (row: StaticRoute) => {
    try {
      await deleteStaticRoute(routes, row);
      setToast(`Deleted route ${row.destination}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete route ${row.destination}.`);
    }
  };

  const tabs: [RouteFamily, string, number][] = [
    ["ipv4", "IPv4", routes.filter((r) => r.family === "ipv4").length],
    ["ipv6", "IPv6", routes.filter((r) => r.family === "ipv6").length],
  ];

  const headerBlock = (
    <div>
      <h2 className="m-0">Static Routes</h2>
      <p className="clr-secondary" style={{ marginTop: 4 }}>
        Manually configured routes via a gateway, an interface, or a blackhole.
      </p>
    </div>
  );

  return (
    <div className="flex flex-col" style={{ gap: 12 }}>
      {status !== "ready" && headerBlock}

      {status === "loading" && (
        <div className="clr-secondary">Loading static routes…</div>
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
          rowId={(r) => `${r.destination}|${r.kind}|${r.via ?? ""}`}
          storageKey={`routing-static-${tab}`}
          searchPlaceholder="Search routes…"
          emptyMessage={`No ${tab === "ipv4" ? "IPv4" : "IPv6"} static routes configured.`}
          onRefresh={() => load("refresh")}
          onRowOpen={(row) => setModal({ route: row })}
          headerLeft={headerBlock}
          subHeader={
            <Tabs
              items={tabs.map(([id, label, count]) => ({ value: id, label, count }))}
              value={tab}
              onChange={(v) => setTab(v as RouteFamily)}
            />
          }
          toolbar={
            <Button kind="primary" onClick={() => setModal({})}>
              Create Route
            </Button>
          }
          actions={(row) => (
            <RowActions
              label={`route ${row.destination}`}
              onEdit={() => setModal({ route: row })}
              onDelete={() => remove(row)}
            />
          )}
        />
      )}

      {modal && (
        <StaticRouteFormModal
          family={tab}
          initial={modal.route}
          interfaces={interfaces}
          descriptions={ifaceDescriptions}
          existing={routes}
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
