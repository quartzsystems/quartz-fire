"use client";

// Monitoring → Devices — a Meraki-style client list over everything the box has
// seen on the LAN. The data is collected by qfdevd (neighbor table + Kea leases
// + conntrack byte accounting) into a shared SQLite inventory; this page is the
// read side plus inline editing of the user-assigned description.
//
// The list is server-driven: search, status filter, usage window, sort, and
// pagination are all query params on GET /api/monitoring/devices, so the page
// scales to thousands of rows (the backend paginates; we render one page). All
// of that state lives in React, so a 30 s auto-refresh re-runs the same query
// without disturbing the user's filters, sort, page, or an open detail row.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Pencil,
  RotateCw,
  Search,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { Sparkline } from "@/components/ui/Sparkline";
import { UsageChart } from "@/components/ui/UsageChart";
import { DonutChart } from "@/components/ui/DonutChart";
import { useDashboard } from "@/lib/DashboardContext";
import { formatBytes, formatRelative, formatTimestamp } from "@/lib/format";
import { AppUsage, fetchAppUsage } from "@/lib/appcontrol";
import {
  Device,
  DeviceDetail,
  DeviceList,
  UsageSeries,
  PingResult,
  deviceIdentity,
  fetchDeviceDetail,
  fetchDevices,
  fetchUsageSeries,
  isIpv4,
  pingDevice,
  saveDeviceDescription,
  SortDir,
  SortKey,
  StatusFilter,
  UsageWindow,
} from "@/lib/devices";

const REFRESH_MS = 30_000;
const SEARCH_DEBOUNCE_MS = 300;
const PAGE_SIZE = 50;

const dash = <span className="text-[var(--qz-fg-4)]">—</span>;

const WINDOWS: { value: UsageWindow; label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
];

/// Usage window label → seconds, for the timeline x-axis span.
const WINDOW_SECS: Record<UsageWindow, number> = {
  "1h": 3_600,
  "24h": 86_400,
  "7d": 7 * 86_400,
};

interface ColumnDef {
  key: string;
  header: string;
  sort?: SortKey;
  width?: string;
}

// Fixed widths on every column except the trailing IPv4 one, which is left
// width-less so it absorbs the table's slack — that keeps Description tight to
// MAC/Last Seen instead of stretching and leaving a big empty gap.
const COLUMNS: ColumnDef[] = [
  { key: "status", header: "Status", sort: "status", width: "110px" },
  { key: "description", header: "Description", sort: "description", width: "260px" },
  { key: "mac", header: "MAC", width: "160px" },
  { key: "last_seen", header: "Last Seen", sort: "last_seen", width: "120px" },
  { key: "usage", header: "Usage", sort: "usage", width: "160px" },
  { key: "type", header: "Client Type / OS", sort: "client_type", width: "150px" },
  { key: "ip", header: "IPv4 Address", sort: "ip" },
];

export default function DevicesPage() {
  const { setToast } = useDashboard();

  // ── server-query state (drives the fetch) ─────────────────────────────────
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [usageWindow, setUsageWindow] = useState<UsageWindow>("24h");
  const [sort, setSort] = useState<SortKey>("last_seen");
  const [dir, setDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(1);

  // ── data state ────────────────────────────────────────────────────────────
  const [data, setData] = useState<DeviceList | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  // ── header summary state (aggregate usage graph + apps pie) ────────────────
  const [usageSeries, setUsageSeries] = useState<UsageSeries | null>(null);
  const [appUsage, setAppUsage] = useState<AppUsage | null>(null);

  // Debounce the search box, and reset to page 1 whenever a filter changes.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, status, usageWindow, sort, dir]);

  const load = useCallback(
    async (manual: boolean) => {
      if (manual) setRefreshing(true);
      try {
        const list = await fetchDevices({
          window: usageWindow,
          status,
          search: debouncedSearch,
          sort,
          dir,
          page,
          page_size: PAGE_SIZE,
        });
        setData(list);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load devices.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [usageWindow, status, debouncedSearch, sort, dir, page],
  );

  // Refetch on any query change, and poll every 30 s with the same params.
  useEffect(() => {
    load(false);
    const id = setInterval(() => load(false), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  // Header summary depends only on the usage window (not search/sort/page).
  const loadSummary = useCallback(async () => {
    const [series, apps] = await Promise.allSettled([
      fetchUsageSeries(usageWindow),
      fetchAppUsage(usageWindow),
    ]);
    if (series.status === "fulfilled") setUsageSeries(series.value);
    if (apps.status === "fulfilled") setAppUsage(apps.value);
  }, [usageWindow]);

  useEffect(() => {
    loadSummary();
    const id = setInterval(loadSummary, REFRESH_MS);
    return () => clearInterval(id);
  }, [loadSummary]);

  const toggleSort = (key?: SortKey) => {
    if (!key) return;
    if (sort === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      // Sensible initial direction: time/usage default to descending.
      setDir(key === "last_seen" || key === "usage" ? "desc" : "asc");
    }
  };

  const devices = data?.devices ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const collectorDown =
    data?.collector && !data.collector.conntrack_ok
      ? "Usage accounting is unavailable — check that qfdevd is running and conntrack accounting is enabled."
      : null;

  const statusItems = useMemo(
    () => [
      { value: "all", label: `All${data ? ` (${data.online_count + data.offline_count})` : ""}` },
      { value: "online", label: `Online${data ? ` (${data.online_count})` : ""}` },
      { value: "offline", label: `Offline${data ? ` (${data.offline_count})` : ""}` },
    ],
    [data],
  );

  return (
    <div className="p-[28px_36px]">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
            Devices
          </h1>
          <p className="text-[13px] text-[var(--qz-fg-4)] mt-1 mb-0">
            Clients seen on the network — identity, activity, and usage.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-[var(--qz-fg-4)]">Usage window</span>
          <Segmented items={WINDOWS} value={usageWindow} onChange={(v) => setUsageWindow(v as UsageWindow)} />
        </div>
      </div>

      {/* Usage and clients — combined throughput + application mix */}
      <div className="mt-6 rounded-md p-5" style={{ border: "1px solid var(--qz-border)", background: "var(--qz-surface)" }}>
        <div className="grid gap-6" style={{ gridTemplateColumns: "minmax(0, 1.9fr) minmax(260px, 1fr)" }}>
          {/* Usage graph */}
          <div>
            <div className="flex items-baseline justify-between gap-3 mb-2 flex-wrap">
              <span className="text-[13px] font-semibold text-[var(--qz-fg-1)]">Network usage</span>
              {usageSeries && (
                <span className="text-[12px] text-[var(--qz-fg-4)]">
                  {formatBytes(usageSeries.bytes_in + usageSeries.bytes_out)}
                  <span className="mx-1">·</span>
                  {formatBytes(usageSeries.bytes_in)} ↓ / {formatBytes(usageSeries.bytes_out)} ↑
                </span>
              )}
            </div>
            <UsageChart
              points={usageSeries?.points ?? []}
              windowSecs={WINDOW_SECS[usageWindow]}
              height={190}
            />
          </div>
          {/* Applications pie */}
          <div style={{ borderLeft: "1px solid var(--qz-border)" }} className="pl-6">
            <div className="text-[13px] font-semibold text-[var(--qz-fg-1)] mb-3">Applications</div>
            <DonutChart
              slices={(appUsage?.apps ?? []).map((a) => ({ label: a.app, value: a.bytes, sub: a.category }))}
              available={appUsage?.available ?? false}
            />
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap mt-6">
        <div className="relative">
          <Search size={14} className="absolute left-[10px] top-1/2 -translate-y-1/2 text-[var(--qz-fg-4)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search description, hostname, MAC, IP…"
            className="rounded-md pl-8 pr-3 py-[7px] text-[13px] text-[var(--qz-fg-1)] outline-none w-[300px]"
            style={{ background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" }}
            onFocus={(e) => (e.currentTarget.style.borderColor = "var(--qz-accent)")}
            onBlur={(e) => (e.currentTarget.style.borderColor = "var(--qz-border)")}
          />
        </div>

        <Segmented items={statusItems} value={status} onChange={(v) => setStatus(v as StatusFilter)} />

        <div className="ml-auto flex items-center gap-3">
          <Button kind="secondary" size="sm" icon={RotateCw} onClick={() => load(true)} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
          <span className="text-[12px] text-[var(--qz-fg-4)]">
            {total} {total === 1 ? "device" : "devices"}
          </span>
        </div>
      </div>

      {collectorDown && (
        <div
          className="mt-4 px-3 py-2 rounded-md text-[12.5px] text-[var(--qz-warn)]"
          style={{ background: "var(--qz-warn-soft)", border: "1px solid color-mix(in oklab, var(--qz-warn) 30%, transparent)" }}
        >
          {collectorDown}
        </div>
      )}

      {/* Table */}
      <div className="mt-4 rounded-md overflow-x-auto" style={{ border: "1px solid var(--qz-border)" }}>
        <table className="qz-table" style={{ tableLayout: "fixed", width: "100%" }}>
          <colgroup>
            <col style={{ width: 34 }} />
            {COLUMNS.map((c) => (
              <col key={c.key} style={{ width: c.width }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th style={{ width: 34 }} aria-hidden />
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  onClick={() => toggleSort(c.sort)}
                  style={{ cursor: c.sort ? "pointer" : "default" }}
                >
                  <span className="inline-flex items-center gap-1">
                    {c.header}
                    {sort === c.sort && (dir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {devices.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length + 1} className="text-center text-[var(--qz-fg-4)]" style={{ cursor: "default" }}>
                  {loading ? "Loading…" : error ? error : "No devices seen yet."}
                </td>
              </tr>
            ) : (
              devices.map((d) => (
                <DeviceRowView
                  key={d.mac}
                  device={d}
                  usageWindow={usageWindow}
                  expanded={expanded === d.mac}
                  onToggle={() => setExpanded((m) => (m === d.mac ? null : d.mac))}
                  onSaved={(row) => {
                    setData((prev) =>
                      prev ? { ...prev, devices: prev.devices.map((x) => (x.mac === row.mac ? { ...x, ...row } : x)) } : prev,
                    );
                    setToast("Description saved.");
                  }}
                  onError={(m) => setToast(m)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between mt-3">
        <span className="text-[12px] text-[var(--qz-fg-4)]">
          Page {data?.page ?? page} of {pageCount}
        </span>
        <div className="flex items-center gap-2">
          <Button kind="secondary" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
            Previous
          </Button>
          <Button kind="secondary" size="sm" onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={page >= pageCount}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── row ─────────────────────────────────────────────────────────────────────

function DeviceRowView({
  device,
  usageWindow,
  expanded,
  onToggle,
  onSaved,
  onError,
}: {
  device: Device;
  usageWindow: UsageWindow;
  expanded: boolean;
  onToggle: () => void;
  onSaved: (row: Device) => void;
  onError: (msg: string) => void;
}) {
  const identity = deviceIdentity(device);
  const down = device.bytes_in ?? 0;
  const up = device.bytes_out ?? 0;

  // Client type / OS: OS is the headline, type the secondary; "Unknown" when
  // fingerprinting found nothing.
  const os = device.os_guess;
  const type = device.client_type;
  const typeCell =
    os || type ? (
      <div className="flex flex-col leading-tight">
        <span className="text-[13px] text-[var(--qz-fg-1)]">{os ?? type}</span>
        {os && type && <span className="text-[11px] text-[var(--qz-fg-4)]">{type}</span>}
      </div>
    ) : (
      <span className="text-[var(--qz-fg-4)]">Unknown</span>
    );

  return (
    <>
      <tr className={expanded ? "selected" : ""} onClick={onToggle}>
        {/* expand chevron */}
        <td onClick={(e) => e.stopPropagation()} style={{ cursor: "pointer", textAlign: "center" }}>
          <button
            type="button"
            onClick={onToggle}
            aria-label={expanded ? "Collapse" : "Expand"}
            className="text-[var(--qz-fg-4)] hover:text-[var(--qz-fg-1)] bg-transparent border-0 p-0 cursor-pointer align-middle"
          >
            {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
        </td>

        {/* Status */}
        <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <span className="inline-flex items-center gap-[7px]">
            <Circle
              size={9}
              className="flex-shrink-0"
              style={{
                fill: device.online ? "var(--qz-success)" : "var(--qz-ink-7)",
                color: device.online ? "var(--qz-success)" : "var(--qz-ink-7)",
              }}
            />
            <span className={device.online ? "text-[var(--qz-fg-1)]" : "text-[var(--qz-fg-4)]"}>
              {device.online ? "Online" : "Offline"}
            </span>
          </span>
        </td>

        {/* Description (inline edit) */}
        <td style={{ overflow: "hidden" }} onClick={(e) => e.stopPropagation()}>
          <DescriptionCell device={device} identity={identity} onSaved={onSaved} onError={onError} />
        </td>

        {/* MAC */}
        <td className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <span className="text-[13px] text-[var(--qz-fg-2)]" title={device.mac}>
            {device.mac}
          </span>
        </td>

        {/* Last Seen */}
        <td
          title={formatTimestamp(device.last_seen)}
          style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {formatRelative(device.last_seen)}
        </td>

        {/* Usage (down/up split) */}
        <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <div className="flex flex-col leading-tight">
            <span className="text-[13px] text-[var(--qz-fg-1)]">{formatBytes(down + up)}</span>
            <span className="text-[11px] text-[var(--qz-fg-4)]">
              {formatBytes(down)} ↓ / {formatBytes(up)} ↑
            </span>
          </div>
        </td>

        {/* Client Type / OS */}
        <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{typeCell}</td>

        {/* IPv4 + lease/static badge (IPv6 is kept out of this column) */}
        <td className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {isIpv4(device.current_ip) ? (
            <span className="inline-flex items-center gap-[6px]">
              {device.current_ip}
              {device.dhcp_static === true && (
                <span className="badge badge-info" title="Static DHCP reservation">Static</span>
              )}
              {device.dhcp_static === false && (
                <span
                  className="badge badge-muted"
                  title={device.lease_expiry ? `Lease expires ${formatTimestamp(device.lease_expiry)}` : "Dynamic DHCP lease"}
                >
                  DHCP
                </span>
              )}
            </span>
          ) : (
            dash
          )}
        </td>
      </tr>

      {expanded && (
        <tr style={{ cursor: "default" }}>
          <td colSpan={COLUMNS.length + 1} style={{ background: "var(--qz-ink-0)", padding: 0 }}>
            <DeviceDetailPanel mac={device.mac} usageWindow={usageWindow} />
          </td>
        </tr>
      )}
    </>
  );
}

// ── inline description editing ────────────────────────────────────────────────

function DescriptionCell({
  device,
  identity,
  onSaved,
  onError,
}: {
  device: Device;
  identity: { label: string; isMac: boolean };
  onSaved: (row: Device) => void;
  onError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(device.description ?? "");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const begin = () => {
    setValue(device.description ?? "");
    setEditing(true);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const row = await saveDeviceDescription(device.mac, value.trim() || null);
      onSaved(row);
      setEditing(false);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save description.");
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1 w-full">
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") setEditing(false);
          }}
          maxLength={128}
          placeholder={device.hostname ?? device.mac}
          disabled={saving}
          className="flex-1 min-w-0 rounded-md px-2 py-[4px] text-[13px] text-[var(--qz-fg-1)] outline-none"
          style={{ background: "var(--qz-input-bg)", border: "1px solid var(--qz-accent)" }}
        />
        <button type="button" onClick={save} disabled={saving} title="Save" className="text-[var(--qz-success)] bg-transparent border-0 p-0 cursor-pointer">
          <Check size={15} />
        </button>
        <button type="button" onClick={() => setEditing(false)} title="Cancel" className="text-[var(--qz-fg-4)] hover:text-[var(--qz-fg-1)] bg-transparent border-0 p-0 cursor-pointer">
          <X size={15} />
        </button>
      </span>
    );
  }

  return (
    <span className="group inline-flex items-center gap-[6px] max-w-full">
      <span
        className={identity.isMac ? "mono text-[13px] text-[var(--qz-fg-2)] truncate" : "text-[13px] text-[var(--qz-fg-1)] truncate"}
        title={identity.label}
      >
        {identity.label}
      </span>
      <button
        type="button"
        onClick={begin}
        title="Edit description"
        aria-label="Edit description"
        className="opacity-0 group-hover:opacity-100 transition-opacity text-[var(--qz-fg-4)] hover:text-[var(--qz-accent)] bg-transparent border-0 p-0 cursor-pointer flex-shrink-0"
      >
        <Pencil size={13} />
      </button>
    </span>
  );
}

// ── detail panel ──────────────────────────────────────────────────────────────

function DeviceDetailPanel({ mac, usageWindow }: { mac: string; usageWindow: UsageWindow }) {
  const [detail, setDetail] = useState<DeviceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apps, setApps] = useState<AppUsage | null>(null);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError(null);
    fetchDeviceDetail(mac, usageWindow)
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Failed to load detail."));
    return () => {
      alive = false;
    };
  }, [mac, usageWindow]);

  // Per-client application mix, keyed on the client's IPv4 (App Control events
  // record source IP). Refetch when the client's IP resolves or the window
  // changes.
  const clientIp = detail?.current_ip;
  useEffect(() => {
    let alive = true;
    setApps(null);
    if (!clientIp || !isIpv4(clientIp)) {
      setApps({ apps: [], total: 0, available: false });
      return;
    }
    fetchAppUsage(usageWindow, clientIp)
      .then((a) => alive && setApps(a))
      .catch(() => alive && setApps({ apps: [], total: 0, available: false }));
    return () => {
      alive = false;
    };
  }, [clientIp, usageWindow]);

  if (error) return <div className="px-5 py-4 text-[13px] text-[var(--qz-danger)]">{error}</div>;
  if (!detail) return <div className="px-5 py-4 text-[13px] text-[var(--qz-fg-4)]">Loading detail…</div>;

  const mono = (v: string | null | undefined) =>
    v ? <span className="mono">{v}</span> : dash;

  const facts: [string, React.ReactNode][] = [
    ["IPv4 address", isIpv4(detail.current_ip) ? mono(detail.current_ip) : dash],
    ["IPv6 (link-local)", mono(detail.current_ipv6)],
    ["MAC address", <span className="mono" key="mac">{detail.mac}</span>],
    ["Vendor (OUI)", detail.vendor ?? "Unknown"],
    ["Interface", mono(detail.interface)],
    ["VLAN", detail.vlan ?? dash],
    ["Neighbor state", detail.neigh_state ?? dash],
    [
      "IPv4 assignment",
      detail.dhcp_static === true ? "Static reservation" : detail.dhcp_static === false ? "Dynamic DHCP lease" : "Not from DHCP",
    ],
    ["Lease expiry", detail.lease_expiry ? formatTimestamp(detail.lease_expiry) : dash],
    ["First seen", <span title={formatTimestamp(detail.first_seen)} key="fs">{formatRelative(detail.first_seen)}</span>],
    ["Last seen", <span title={formatTimestamp(detail.last_seen)} key="ls">{formatRelative(detail.last_seen)}</span>],
  ];

  return (
    <div className="px-5 py-5 flex flex-col gap-6">
      {/* Usage over the window */}
      <div>
        <div className="flex items-baseline justify-between mb-1 gap-3 flex-wrap">
          <span className="text-[13px] font-semibold text-[var(--qz-fg-1)]">Usage over {usageWindow}</span>
          <span className="text-[12px] text-[var(--qz-fg-2)]">
            {formatBytes(detail.bytes_in + detail.bytes_out)}
            <span className="mx-1 text-[var(--qz-fg-4)]">·</span>
            {formatBytes(detail.bytes_in)} ↓ / {formatBytes(detail.bytes_out)} ↑
          </span>
        </div>
        <UsageChart points={detail.usage} windowSecs={WINDOW_SECS[usageWindow]} height={170} />
      </div>

      {/* Applications + Ping */}
      <div className="grid gap-6" style={{ gridTemplateColumns: "minmax(0, 1.5fr) minmax(220px, 1fr)" }}>
        <div>
          <div className="text-[13px] font-semibold text-[var(--qz-fg-1)] mb-3">Applications</div>
          <DonutChart
            slices={(apps?.apps ?? []).map((a) => ({ label: a.app, value: a.bytes, sub: a.category }))}
            available={apps?.available ?? false}
            size={130}
          />
        </div>
        <div style={{ borderLeft: "1px solid var(--qz-border)" }} className="pl-6">
          <PingWidget mac={mac} pingable={isIpv4(detail.current_ip)} />
        </div>
      </div>

      {/* Network facts */}
      <div>
        <div className="text-[13px] font-semibold text-[var(--qz-fg-1)] mb-3">Network</div>
        <div
          className="grid gap-x-6 gap-y-[10px]"
          style={{ gridTemplateColumns: "max-content 1fr", alignContent: "start", maxWidth: 520 }}
        >
          {facts.map(([k, v]) => (
            <div key={k} className="contents">
              <div className="text-[12px] text-[var(--qz-fg-4)]">{k}</div>
              <div className="text-[13px] text-[var(--qz-fg-1)]">{v}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── ping tool ─────────────────────────────────────────────────────────────────

function PingWidget({ mac, pingable }: { mac: string; pingable: boolean }) {
  const [result, setResult] = useState<PingResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      setResult(await pingDevice(mac));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ping failed.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <span className="text-[13px] font-semibold text-[var(--qz-fg-1)]">Ping</span>
        <span title={pingable ? "Send an ICMP burst" : "No IPv4 address to ping"}>
          <Button
            kind="secondary"
            size="sm"
            icon={Activity}
            onClick={run}
            disabled={running || !pingable}
          >
            {running ? "Pinging…" : "Run"}
          </Button>
        </span>
      </div>

      {!pingable && (
        <p className="text-[12px] text-[var(--qz-fg-4)] m-0">This client has no IPv4 address to ping.</p>
      )}
      {error && <p className="text-[12px] text-[var(--qz-danger)] m-0">{error}</p>}

      {result && (
        <>
          {result.samples.length > 1 && <Sparkline data={result.samples} height={40} />}
          <div className="grid gap-x-4 gap-y-1 mt-2" style={{ gridTemplateColumns: "max-content 1fr" }}>
            <span className="text-[12px] text-[var(--qz-fg-4)]">Loss rate</span>
            <span
              className="text-[12px] tabular-nums"
              style={{ color: result.loss_pct > 0 ? "var(--qz-warn)" : "var(--qz-fg-1)" }}
            >
              {result.loss_pct.toFixed(0)}% ({result.received}/{result.transmitted})
            </span>
            <span className="text-[12px] text-[var(--qz-fg-4)]">Average latency</span>
            <span className="text-[12px] text-[var(--qz-fg-1)] tabular-nums">
              {result.avg_ms != null ? `${result.avg_ms.toFixed(1)} ms` : "—"}
            </span>
          </div>
        </>
      )}
      {!result && !error && pingable && (
        <p className="text-[12px] text-[var(--qz-fg-4)] m-0">Run a burst to measure loss and latency.</p>
      )}
    </div>
  );
}
