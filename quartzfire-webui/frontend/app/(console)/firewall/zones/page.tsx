"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { Column, DataTable, FilterDef } from "@/components/dashboard/DataTable";
import {
  deleteZone,
  emptyFirewallConfig,
  fetchFirewall,
  FirewallConfig,
  FirewallZone,
  zoneUsage,
} from "@/lib/firewall";
import { bridgeVifInterfaceNames, fetchBridges, fetchInterfaceDescriptions } from "@/lib/interfaces";
import { fetchInterfaceStats } from "@/lib/vyos";
import { useDashboard } from "@/lib/DashboardContext";
import { RowActions } from "@/components/dashboard/RowActions";
import { ZoneFormModal } from "./ZoneFormModal";

/// What a zone does with traffic no rule allowed. VyOS has no accept default
/// for zones — unset still denies, it just doesn't say how.
function DefaultActionPill({ zone }: { zone: FirewallZone }) {
  if (zone.default_action === "reject") return <span className="badge badge-warn">Reject</span>;
  if (zone.default_action === "drop") return <span className="badge badge-crit">Deny</span>;
  return (
    <span className="badge badge-muted" title="Not set — VyOS drops traffic no rule allowed.">
      Deny (default)
    </span>
  );
}

export default function FirewallZonesPage() {
  const { setToast } = useDashboard();
  const [data, setData] = useState<FirewallConfig>(emptyFirewallConfig);
  const [interfaces, setInterfaces] = useState<string[]>([]);
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  // null = closed; { zone: undefined } = create; { zone } = edit.
  const [modal, setModal] = useState<{ zone?: FirewallZone } | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      // Interface reads populate the membership picker; tolerate their failure
      // so the zones still render.
      const [fw, ifs, descs, bridges] = await Promise.all([
        fetchFirewall(),
        fetchInterfaceStats().catch(() => []),
        fetchInterfaceDescriptions().catch(() => ({})),
        fetchBridges().catch(() => []),
      ]);
      setData(fw);
      // Config-derived bridge VIFs (br0.10) can be zone members too, and don't
      // show up in the operational interface list.
      const names = new Set(ifs.map((i) => i.name));
      for (const n of bridgeVifInterfaceNames(bridges)) names.add(n);
      names.delete("lo");
      setInterfaces([...names].sort((a, b) => a.localeCompare(b)));
      setDescriptions(descs);
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load firewall zones.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const usedBy = (zone: FirewallZone) => zoneUsage(data, zone);

  const remove = async (zone: FirewallZone) => {
    const rules = usedBy(zone);
    if (rules.length > 0) {
      setToast(
        `Cannot delete ${zone.display} — ${rules.length} rule${rules.length === 1 ? "" : "s"} still use its zone pairs. Delete them first.`,
      );
      return;
    }
    try {
      await deleteZone(data, zone);
      setToast(`Deleted zone ${zone.display} — confirm the change in the banner.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete zone ${zone.display}.`);
    }
  };

  const ifaceLabel = (n: string) => (descriptions[n] ? `${descriptions[n]} (${n})` : n);

  const columns: Column<FirewallZone>[] = [
    {
      key: "name",
      header: "Name",
      value: (z) => z.display,
      render: (z) => (
        <span title={`Device name: ${z.name}`}>
          {z.display}
          {z.local && <span className="badge badge-info ml-2">Firewall</span>}
        </span>
      ),
      mono: true,
      sortable: true,
      width: 200,
    },
    {
      key: "interfaces",
      header: "Interfaces",
      value: (z) => z.interfaces.join(", "),
      render: (z) =>
        z.local ? (
          <span className="text-[var(--cds-alias-typography-color-200)]">This device</span>
        ) : z.interfaces.length ? (
          <span title={z.interfaces.join(", ")}>{z.interfaces.map(ifaceLabel).join(", ")}</span>
        ) : (
          "—"
        ),
      mono: true,
    },
    {
      key: "default_action",
      header: "Unmatched traffic",
      value: (z) => z.default_action ?? "drop",
      render: (z) => <DefaultActionPill zone={z} />,
      sortable: true,
      width: 150,
    },
    {
      key: "intra_zone",
      header: "Within zone",
      value: (z) => z.intra_zone ?? "accept",
      render: (z) => {
        if (z.local) return <span className="text-[var(--cds-alias-typography-color-200)]">—</span>;
        if (z.intra_zone === "drop") return <span className="badge badge-crit">Deny</span>;
        if (z.intra_zone === "reject") return <span className="badge badge-warn">Reject</span>;
        return <span className="badge badge-ok">Allow</span>;
      },
      sortable: true,
      width: 130,
    },
    {
      key: "used",
      header: "In Use",
      value: (z) => usedBy(z).length,
      render: (z) => {
        const n = usedBy(z).length;
        return n > 0 ? (
          <span className="badge badge-ok">{n} rule{n === 1 ? "" : "s"}</span>
        ) : (
          <span className="badge badge-muted">unused</span>
        );
      },
      sortable: true,
      width: 110,
    },
  ];

  const filters: FilterDef<FirewallZone>[] = [
    {
      key: "kind",
      label: "Kind",
      options: [
        { value: "network", label: "Network zone" },
        { value: "local", label: "Firewall zone" },
      ],
      predicate: (z, v) => (v === "local" ? z.local : !z.local),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2>Zones</h2>
        <p className="clr-secondary" style={{ marginTop: 4 }}>
          Named groups of interfaces. Traffic between two zones is denied unless a rule allows it; traffic inside a
          zone flows freely unless you say otherwise
        </p>
      </div>

      {status === "loading" && <div className="clr-secondary">Loading zones…</div>}
      {status === "error" && (
        <div className="alert alert-danger alert-sm">
          <Icon shape="exclamation-circle" size={14} className="alert-icon" />
          <div className="alert-text">{errorMsg}</div>
          <div className="alert-actions">
            <Button kind="secondary" size="sm" icon="refresh" onClick={() => load()}>Retry</Button>
          </div>
        </div>
      )}
      {status === "ready" && (
        <div className="flex flex-col gap-3">
          {/* A zone denies everything its pairs don't allow, so a zone with no
              rules yet is a black hole — worth saying before it bites. */}
          {data.zones.length > 0 && data.zone_pairs.length === 0 && (
            <div className="alert alert-info alert-sm">
              <Icon shape="info-circle" size={14} className="alert-icon" />
              <div className="alert-text">
                No rules between these zones yet, so traffic between them is denied. Allow some under{" "}
                <Link href="/firewall/rules" className="text-[var(--cds-alias-typography-color-450)] underline">
                  Rules
                </Link>{" "}
                by setting a zone as a rule&apos;s From and To.
              </div>
            </div>
          )}
          <DataTable
            rows={data.zones}
            columns={columns}
            rowId={(z) => z.name}
            filters={filters}
            storageKey="firewall-zones"
            searchPlaceholder="Search zones…"
            emptyMessage="No zones defined."
            onRefresh={() => load("refresh")}
            onRowOpen={(z) => setModal({ zone: z })}
            toolbar={
              <Button kind="primary" size="sm" icon="plus" onClick={() => setModal({})}>
                Create Zone
              </Button>
            }
            actions={(z) => (
              <RowActions
                label={`zone ${z.display}`}
                onEdit={() => setModal({ zone: z })}
                onDelete={() => remove(z)}
              />
            )}
          />
        </div>
      )}

      {modal && (
        <ZoneFormModal
          initial={modal.zone}
          config={data}
          interfaces={interfaces}
          descriptions={descriptions}
          usedByRules={modal.zone ? usedBy(modal.zone).length : 0}
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
