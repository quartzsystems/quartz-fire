"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Tabs } from "@/components/ui/Tabs";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { RowActions } from "@/components/dashboard/RowActions";
import {
  deleteDhcpMapping,
  deleteDhcpRange,
  deleteDhcpServer,
  deleteDhcpSubnet,
  DhcpLease,
  DhcpRange,
  DhcpServer,
  DhcpServerConfig,
  DhcpStaticMapping,
  DhcpSubnet,
  fetchDhcpServer,
} from "@/lib/services";
import { useDashboard } from "@/lib/DashboardContext";
import { ServerFormModal } from "./ServerFormModal";
import { SubnetFormModal } from "./SubnetFormModal";
import { RangeFormModal } from "./RangeFormModal";
import { MappingFormModal } from "./MappingFormModal";

type Tab = "subnets" | "ranges" | "mappings" | "leases";

const TABS: { id: Tab; label: string }[] = [
  { id: "subnets", label: "Subnets" },
  { id: "ranges", label: "Ranges" },
  { id: "mappings", label: "Static Mappings" },
  { id: "leases", label: "Leases" },
];

// Rows for ranges/mappings carry their subnet context (the tables flatten
// every subnet of the selected server).
interface RangeRow {
  subnet: string;
  range: DhcpRange;
}
interface MappingRow {
  subnet: string;
  mapping: DhcpStaticMapping;
}

const dash = (v: string | null | undefined) => (v && v.length ? v : "—");

const subnetColumns: Column<DhcpSubnet>[] = [
  { key: "subnet", header: "Subnet", value: (r) => r.subnet, mono: true, sortable: true },
  { key: "default_router", header: "Gateway", value: (r) => r.default_router ?? "", render: (r) => dash(r.default_router), mono: true },
  { key: "name_servers", header: "DNS", value: (r) => r.name_servers.join(", "), render: (r) => dash(r.name_servers.join(", ")), mono: true },
  { key: "domain_name", header: "Domain", value: (r) => r.domain_name ?? "", render: (r) => dash(r.domain_name) },
  { key: "lease", header: "Lease (s)", value: (r) => r.lease ?? "", render: (r) => dash(r.lease), mono: true, sortable: true, width: 110 },
  { key: "ranges", header: "Ranges", value: (r) => r.ranges.length, mono: true, sortable: true, width: 90 },
  { key: "mappings", header: "Mappings", value: (r) => r.static_mappings.length, mono: true, sortable: true, width: 100 },
];

const rangeColumns: Column<RangeRow>[] = [
  { key: "subnet", header: "Subnet", value: (r) => r.subnet, mono: true, sortable: true },
  { key: "name", header: "Range", value: (r) => r.range.name, mono: true, sortable: true },
  { key: "start", header: "Start", value: (r) => r.range.start ?? "", render: (r) => dash(r.range.start), mono: true },
  { key: "stop", header: "Stop", value: (r) => r.range.stop ?? "", render: (r) => dash(r.range.stop), mono: true },
];

const mappingColumns: Column<MappingRow>[] = [
  { key: "name", header: "Name", value: (r) => r.mapping.name, sortable: true },
  { key: "subnet", header: "Subnet", value: (r) => r.subnet, mono: true, sortable: true },
  { key: "ip_address", header: "IP Address", value: (r) => r.mapping.ip_address ?? "", render: (r) => dash(r.mapping.ip_address), mono: true },
  { key: "mac_address", header: "MAC Address", value: (r) => r.mapping.mac_address ?? "", render: (r) => dash(r.mapping.mac_address), mono: true },
  { key: "description", header: "Description", value: (r) => r.mapping.description ?? "", render: (r) => dash(r.mapping.description) },
];

const leaseColumns: Column<DhcpLease>[] = [
  { key: "ip_address", header: "IP Address", value: (r) => r.ip_address, mono: true, sortable: true },
  { key: "mac_address", header: "MAC Address", value: (r) => r.mac_address ?? "", render: (r) => dash(r.mac_address), mono: true },
  { key: "hostname", header: "Hostname", value: (r) => r.hostname ?? "", render: (r) => dash(r.hostname) },
  {
    key: "state",
    header: "State",
    value: (r) => r.state ?? "",
    render: (r) =>
      r.state ? (
        <span className={r.state.toLowerCase() === "active" ? "badge badge-ok" : "badge badge-muted"}>{r.state}</span>
      ) : (
        "—"
      ),
    sortable: true,
    width: 110,
  },
  { key: "lease_expiration", header: "Expires", value: (r) => r.lease_expiration ?? "", render: (r) => dash(r.lease_expiration), mono: true },
  { key: "remaining", header: "Remaining", value: (r) => r.remaining ?? "", render: (r) => dash(r.remaining), mono: true },
];

export default function DhcpServerPage() {
  const { setToast } = useDashboard();
  const [data, setData] = useState<DhcpServerConfig>({ servers: [], leases: [] });
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("subnets");
  const [confirmingServer, setConfirmingServer] = useState(false);

  // null = closed; {} = create; { <entity> } = edit.
  const [serverModal, setServerModal] = useState<{ server?: DhcpServer } | null>(null);
  const [subnetModal, setSubnetModal] = useState<{ subnet?: DhcpSubnet } | null>(null);
  const [rangeModal, setRangeModal] = useState<{ row?: RangeRow } | null>(null);
  const [mappingModal, setMappingModal] = useState<{ row?: MappingRow } | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      const cfg = await fetchDhcpServer();
      setData(cfg);
      setSelectedName((prev) =>
        prev && cfg.servers.some((s) => s.name === prev) ? prev : cfg.servers[0]?.name ?? null,
      );
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load DHCP servers.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const selected: DhcpServer | null = useMemo(
    () => data.servers.find((s) => s.name === selectedName) ?? null,
    [data, selectedName],
  );

  const rangeRows: RangeRow[] = useMemo(
    () => (selected?.subnets ?? []).flatMap((s) => s.ranges.map((range) => ({ subnet: s.subnet, range }))),
    [selected],
  );

  const mappingRows: MappingRow[] = useMemo(
    () => (selected?.subnets ?? []).flatMap((s) => s.static_mappings.map((mapping) => ({ subnet: s.subnet, mapping }))),
    [selected],
  );

  // VyOS labels each lease with its shared-network "Pool"; leases with no pool show everywhere.
  const leaseRows: DhcpLease[] = useMemo(() => {
    if (!selected) return [];
    const name = selected.name.toLowerCase();
    return data.leases.filter((l) => !l.pool || l.pool.toLowerCase() === name);
  }, [data, selected]);

  const toastAfter = async (action: Promise<unknown>, ok: string, fail: string) => {
    try {
      await action;
      setToast(ok);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : fail);
    }
  };

  const removeServer = async () => {
    if (!selected) return;
    setConfirmingServer(false);
    await toastAfter(
      deleteDhcpServer(selected.name),
      `Deleted DHCP server ${selected.name}.`,
      `Failed to delete DHCP server ${selected.name}.`,
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2>DHCP Server</h2>
        <p className="clr-secondary" style={{ marginTop: 4 }}>
          Shared networks, their subnets, ranges, static mappings, and active leases
        </p>
      </div>

      {status === "loading" && <p className="clr-secondary">Loading DHCP servers…</p>}
      {status === "error" && (
        <div className="alert alert-danger alert-sm">
          <Icon shape="exclamation-circle" size={14} className="alert-icon" />
          <div className="alert-text">{errorMsg}</div>
          <div className="alert-actions">
            <button type="button" className="alert-action" onClick={() => load()}>
              Retry
            </button>
          </div>
        </div>
      )}
      {status === "ready" && (
        <div className="flex flex-col gap-5">
          {/* Server selector */}
          <div className="flex items-center gap-3 flex-wrap">
            {data.servers.length === 0 ? (
              <p className="clr-secondary m-0">No DHCP servers configured.</p>
            ) : (
              data.servers.map((s) => {
                const active = s.name === selectedName;
                return (
                  <button
                    key={s.name}
                    type="button"
                    onClick={() => setSelectedName(s.name)}
                    className="card clickable items-start gap-[6px] px-4 py-3 text-left min-w-[180px]"
                    style={{
                      background: active
                        ? "var(--cds-alias-object-interaction-background-selected)"
                        : undefined,
                      borderColor: active ? "var(--cds-alias-interaction-action)" : undefined,
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="text-[14px] font-semibold"
                        style={{
                          color: active
                            ? "var(--cds-alias-interaction-action)"
                            : "var(--cds-alias-typography-color-450)",
                        }}
                      >
                        {s.name}
                      </span>
                      <span className={s.enabled ? "badge badge-ok" : "badge badge-muted"}>{s.enabled ? "Enabled" : "Disabled"}</span>
                      {s.authoritative && <span className="badge badge-ok">Authoritative</span>}
                    </div>
                    <span className="text-[12px]" style={{ color: "var(--cds-alias-typography-color-200)" }}>
                      {s.subnets.length} {s.subnets.length === 1 ? "subnet" : "subnets"}
                      {s.description ? ` · ${s.description}` : ""}
                    </span>
                  </button>
                );
              })
            )}
            <div className="ml-auto flex items-center gap-2">
              {selected && (
                confirmingServer ? (
                  <>
                    <span className="text-[12px]" style={{ color: "var(--cds-alias-typography-color-300)" }}>
                      Delete {selected.name}?
                    </span>
                    <button type="button" className="btn btn-sm btn-danger" onClick={removeServer}>
                      Confirm
                    </button>
                    <button type="button" className="btn btn-sm btn-neutral" onClick={() => setConfirmingServer(false)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <Button kind="secondary" size="sm" icon="pencil" onClick={() => setServerModal({ server: selected })}>
                      Edit Server
                    </Button>
                    <Button kind="secondary" size="sm" icon="trash" onClick={() => setConfirmingServer(true)}>
                      Delete Server
                    </Button>
                  </>
                )
              )}
              <Button kind="primary" size="sm" icon="plus" onClick={() => setServerModal({})}>
                Create DHCP Server
              </Button>
            </div>
          </div>

          {selected && (
            <>
              <Tabs
                items={TABS.map((t) => ({
                  value: t.id,
                  label: t.label,
                  count: {
                    subnets: selected.subnets.length,
                    ranges: rangeRows.length,
                    mappings: mappingRows.length,
                    leases: leaseRows.length,
                  }[t.id],
                }))}
                value={tab}
                onChange={(v) => setTab(v as Tab)}
              />

              {tab === "subnets" && (
                <DataTable
                  rows={selected.subnets}
                  columns={subnetColumns}
                  rowId={(r) => r.subnet}
                  storageKey="services-dhcp-subnets"
                  searchPlaceholder="Search subnets…"
                  emptyMessage="No subnets configured for this server."
                  onRefresh={() => load("refresh")}
                  onRowOpen={(row) => setSubnetModal({ subnet: row })}
                  toolbar={
                    <Button kind="primary" size="sm" icon="plus" onClick={() => setSubnetModal({})}>
                      Create Subnet
                    </Button>
                  }
                  actions={(row) => (
                    <RowActions
                      label={`subnet ${row.subnet}`}
                      onEdit={() => setSubnetModal({ subnet: row })}
                      onDelete={() =>
                        toastAfter(
                          deleteDhcpSubnet(selected.name, row.subnet),
                          `Deleted subnet ${row.subnet}.`,
                          `Failed to delete subnet ${row.subnet}.`,
                        )
                      }
                    />
                  )}
                />
              )}
              {tab === "ranges" && (
                <DataTable
                  rows={rangeRows}
                  columns={rangeColumns}
                  rowId={(r) => `${r.subnet}/${r.range.name}`}
                  storageKey="services-dhcp-ranges"
                  searchPlaceholder="Search ranges…"
                  emptyMessage="No address ranges configured for this server."
                  onRefresh={() => load("refresh")}
                  onRowOpen={(row) => setRangeModal({ row })}
                  toolbar={
                    <Button kind="primary" size="sm" icon="plus" onClick={() => setRangeModal({})}>
                      Create Range
                    </Button>
                  }
                  actions={(row) => (
                    <RowActions
                      label={`range ${row.range.name}`}
                      onEdit={() => setRangeModal({ row })}
                      onDelete={() =>
                        toastAfter(
                          deleteDhcpRange(selected.name, row.subnet, row.range.name),
                          `Deleted range ${row.range.name}.`,
                          `Failed to delete range ${row.range.name}.`,
                        )
                      }
                    />
                  )}
                />
              )}
              {tab === "mappings" && (
                <DataTable
                  rows={mappingRows}
                  columns={mappingColumns}
                  rowId={(r) => `${r.subnet}/${r.mapping.name}`}
                  storageKey="services-dhcp-mappings"
                  searchPlaceholder="Search static mappings…"
                  emptyMessage="No static mappings configured for this server."
                  onRefresh={() => load("refresh")}
                  onRowOpen={(row) => setMappingModal({ row })}
                  toolbar={
                    <Button kind="primary" size="sm" icon="plus" onClick={() => setMappingModal({})}>
                      Create Mapping
                    </Button>
                  }
                  actions={(row) => (
                    <RowActions
                      label={`mapping ${row.mapping.name}`}
                      onEdit={() => setMappingModal({ row })}
                      onDelete={() =>
                        toastAfter(
                          deleteDhcpMapping(selected.name, row.subnet, row.mapping.name),
                          `Deleted mapping ${row.mapping.name}.`,
                          `Failed to delete mapping ${row.mapping.name}.`,
                        )
                      }
                    />
                  )}
                />
              )}
              {tab === "leases" && (
                <DataTable
                  rows={leaseRows}
                  columns={leaseColumns}
                  rowId={(r) => `${r.ip_address}/${r.mac_address ?? ""}`}
                  storageKey="services-dhcp-leases"
                  searchPlaceholder="Search leases…"
                  emptyMessage="No active leases for this server."
                  onRefresh={() => load("refresh")}
                />
              )}
            </>
          )}
        </div>
      )}

      {serverModal && (
        <ServerFormModal
          initial={serverModal.server}
          existing={data.servers}
          onClose={() => setServerModal(null)}
          onSaved={(msg) => {
            setServerModal(null);
            setToast(msg);
            load("refresh");
          }}
        />
      )}

      {selected && subnetModal && (
        <SubnetFormModal
          server={selected.name}
          servers={data.servers}
          initial={subnetModal.subnet}
          onClose={() => setSubnetModal(null)}
          onSaved={(msg) => {
            setSubnetModal(null);
            setToast(msg);
            load("refresh");
          }}
        />
      )}

      {selected && rangeModal && (
        <RangeFormModal
          server={selected.name}
          servers={data.servers}
          initial={rangeModal.row}
          onClose={() => setRangeModal(null)}
          onSaved={(msg) => {
            setRangeModal(null);
            setToast(msg);
            load("refresh");
          }}
        />
      )}

      {selected && mappingModal && (
        <MappingFormModal
          server={selected.name}
          servers={data.servers}
          initial={mappingModal.row}
          onClose={() => setMappingModal(null)}
          onSaved={(msg) => {
            setMappingModal(null);
            setToast(msg);
            load("refresh");
          }}
        />
      )}
    </div>
  );
}
