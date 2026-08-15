"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { Tabs } from "@/components/ui/Tabs";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { RowActions } from "@/components/dashboard/RowActions";
import {
  deletePrefixList,
  deleteRouteMap,
  fetchPrefixLists,
  fetchRouteMaps,
  PrefixList,
  RouteMap,
} from "@/lib/routing-policy";
import { useDashboard } from "@/lib/DashboardContext";
import { PrefixListFormModal } from "./PrefixListFormModal";
import { RouteMapFormModal } from "./RouteMapFormModal";

type Tab = "prefix-lists" | "route-maps";

const prefixColumns: Column<PrefixList>[] = [
  { key: "name", header: "Name", value: (r) => r.name, mono: true, sortable: true },
  {
    key: "family",
    header: "Family",
    value: (r) => r.family,
    render: (r) => <span className="badge badge-info">{r.family === "ipv4" ? "IPv4" : "IPv6"}</span>,
    sortable: true,
    width: 100,
  },
  { key: "rules", header: "Rules", value: (r) => r.rules.length, mono: true, sortable: true, width: 90 },
  {
    key: "summary",
    header: "Summary",
    value: (r) => r.rules.map((x) => x.prefix).join(", "),
    render: (r) => (r.rules.length ? r.rules.map((x) => x.prefix).filter(Boolean).slice(0, 3).join(", ") + (r.rules.length > 3 ? " …" : "") : "—"),
    mono: true,
  },
];

const routeMapColumns: Column<RouteMap>[] = [
  { key: "name", header: "Name", value: (r) => r.name, mono: true, sortable: true },
  { key: "rules", header: "Rules", value: (r) => r.rules.length, mono: true, sortable: true, width: 90 },
  {
    key: "summary",
    header: "Summary",
    value: (r) => r.rules.map((x) => `${x.seq} ${x.action}`).join(", "),
    render: (r) => (r.rules.length ? r.rules.map((x) => `${x.seq}:${x.action}`).slice(0, 4).join("  ") : "—"),
    mono: true,
  },
];

export default function RoutingPolicyPage() {
  const { setToast } = useDashboard();
  const [prefixLists, setPrefixLists] = useState<PrefixList[]>([]);
  const [routeMaps, setRouteMaps] = useState<RouteMap[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [tab, setTab] = useState<Tab>("prefix-lists");

  const [prefixModal, setPrefixModal] = useState<{ list?: PrefixList } | null>(null);
  const [routeMapModal, setRouteMapModal] = useState<{ map?: RouteMap } | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      const [pls, rms] = await Promise.all([fetchPrefixLists(), fetchRouteMaps()]);
      setPrefixLists(pls);
      setRouteMaps(rms);
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load routing policy.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const saved = (msg: string) => {
    setPrefixModal(null);
    setRouteMapModal(null);
    setToast(msg);
    load("refresh");
  };

  const removePrefix = async (row: PrefixList) => {
    try {
      await deletePrefixList(row.family, row.name);
      setToast(`Deleted prefix-list ${row.name}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete ${row.name}.`);
    }
  };
  const removeRouteMap = async (row: RouteMap) => {
    try {
      await deleteRouteMap(row.name);
      setToast(`Deleted route-map ${row.name}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete ${row.name}.`);
    }
  };

  const tabs: [Tab, string, number][] = [
    ["prefix-lists", "Prefix Lists", prefixLists.length],
    ["route-maps", "Route Maps", routeMaps.length],
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h2 style={{ margin: 0 }}>Routing Policy</h2>
        <p className="clr-secondary" style={{ marginTop: 4 }}>
          Prefix-lists and route-maps for filtering and shaping routes — referenced by BGP.
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && <div className="clr-secondary">Loading routing policy…</div>}
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
          <div className="flex flex-col gap-5">
            <Tabs
              items={tabs.map(([id, label, count]) => ({ value: id, label, count }))}
              value={tab}
              onChange={(v) => setTab(v as Tab)}
            />

            {tab === "prefix-lists" && (
              <DataTable
                rows={prefixLists}
                columns={prefixColumns}
                rowId={(r) => `${r.family}|${r.name}`}
                storageKey="routing-policy-prefix-lists"
                searchPlaceholder="Search prefix-lists…"
                emptyMessage="No prefix-lists configured."
                onRefresh={() => load("refresh")}
                onRowOpen={(row) => setPrefixModal({ list: row })}
                toolbar={
                  <Button kind="primary" size="sm" onClick={() => setPrefixModal({})}>
                    Create Prefix-List
                  </Button>
                }
                actions={(row) => (
                  <RowActions label={`prefix-list ${row.name}`} onEdit={() => setPrefixModal({ list: row })} onDelete={() => removePrefix(row)} />
                )}
              />
            )}

            {tab === "route-maps" && (
              <DataTable
                rows={routeMaps}
                columns={routeMapColumns}
                rowId={(r) => r.name}
                storageKey="routing-policy-route-maps"
                searchPlaceholder="Search route-maps…"
                emptyMessage="No route-maps configured."
                onRefresh={() => load("refresh")}
                onRowOpen={(row) => setRouteMapModal({ map: row })}
                toolbar={
                  <Button kind="primary" size="sm" onClick={() => setRouteMapModal({})}>
                    Create Route-Map
                  </Button>
                }
                actions={(row) => (
                  <RowActions label={`route-map ${row.name}`} onEdit={() => setRouteMapModal({ map: row })} onDelete={() => removeRouteMap(row)} />
                )}
              />
            )}
          </div>
        )}
      </div>

      {prefixModal && (
        <PrefixListFormModal
          initial={prefixModal.list}
          existing={prefixLists}
          onClose={() => setPrefixModal(null)}
          onSaved={saved}
        />
      )}
      {routeMapModal && (
        <RouteMapFormModal
          initial={routeMapModal.map}
          existingNames={routeMaps.map((r) => r.name)}
          onClose={() => setRouteMapModal(null)}
          onSaved={saved}
        />
      )}
    </div>
  );
}
