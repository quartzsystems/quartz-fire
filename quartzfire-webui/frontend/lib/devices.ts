// Device monitoring data layer (Monitoring → Devices).
//
// Reads the shared inventory qfdevd maintains (neighbor table + Kea leases +
// conntrack byte accounting) through the backend, and writes the one field the
// user owns — the description. The heavy lifting (windowed usage sums, the
// online freshness rule, search/sort/pagination) is done server-side, so the
// list endpoint is driven entirely by its query params.

import { apiFetch } from "./api";

export type UsageWindow = "1h" | "24h" | "7d";
export type StatusFilter = "all" | "online" | "offline";
export type SortKey = "last_seen" | "description" | "usage" | "client_type" | "ip" | "hostname" | "status";
export type SortDir = "asc" | "desc";

/// One device row, matching backend/src/monitoring.rs DeviceRow. Collected
/// identity fields are optional — a device may be known only by MAC.
export interface Device {
  mac: string;
  description?: string;
  hostname?: string;
  vendor?: string;
  client_type?: string;
  os_guess?: string;
  current_ip?: string;
  interface?: string;
  vlan?: string;
  /** true = static reservation, false = dynamic lease, undefined = not DHCP. */
  dhcp_static?: boolean;
  /** Lease expiry (unix seconds). */
  lease_expiry?: number;
  /** Last neighbor-table state (REACHABLE/STALE/…), for the detail panel. */
  neigh_state?: string;
  first_seen: number;
  last_seen: number;
  online: boolean;
  /** Bytes over the selected window. */
  bytes_in: number;
  bytes_out: number;
}

export interface DeviceList {
  devices: Device[];
  total: number;
  online_count: number;
  offline_count: number;
  page: number;
  page_size: number;
  window: UsageWindow;
  /** qfdevd health snapshot, if the daemon is running. */
  collector?: CollectorStatus | null;
}

/// qfdevd's status.json (see qfdevd/src/daemon.rs StatusJson).
export interface CollectorStatus {
  qfdevd_version: string;
  updated: number;
  device_count: number;
  neigh_ok: boolean;
  lease_ok: boolean;
  conntrack_ok: boolean;
  last_neigh: number;
  last_lease: number;
  last_usage: number;
}

export interface UsagePoint {
  ts: number;
  bytes_in: number;
  bytes_out: number;
}

export interface DeviceDetail extends Device {
  /** 5-minute usage buckets over the window, oldest first (sparkline input). */
  usage: UsagePoint[];
}

export interface DeviceQuery {
  window?: UsageWindow;
  status?: StatusFilter;
  search?: string;
  sort?: SortKey;
  dir?: SortDir;
  page?: number;
  page_size?: number;
}

function queryString(q: DeviceQuery): string {
  const p = new URLSearchParams();
  if (q.window) p.set("window", q.window);
  if (q.status) p.set("status", q.status);
  if (q.search) p.set("search", q.search);
  if (q.sort) p.set("sort", q.sort);
  if (q.dir) p.set("dir", q.dir);
  if (q.page) p.set("page", String(q.page));
  if (q.page_size) p.set("page_size", String(q.page_size));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function fetchDevices(q: DeviceQuery = {}): Promise<DeviceList> {
  return apiFetch<DeviceList>(`/monitoring/devices${queryString(q)}`);
}

export function fetchDeviceDetail(mac: string, window: UsageWindow = "24h"): Promise<DeviceDetail> {
  return apiFetch<DeviceDetail>(`/monitoring/devices/${encodeURIComponent(mac)}?window=${window}`);
}

/// Set (or clear, with null/empty) a device's user description. Returns the
/// updated row.
export function saveDeviceDescription(mac: string, description: string | null): Promise<Device> {
  return apiFetch<Device>(`/monitoring/devices/${encodeURIComponent(mac)}`, {
    method: "PATCH",
    body: JSON.stringify({ description }),
  });
}

// ── display helpers ─────────────────────────────────────────────────────────

/// Best identity for the Description column, in the spec's priority order:
/// user description → DHCP hostname → (reverse DNS, folded into hostname by the
/// collector) → MAC. Returns the value and which source it came from so the UI
/// can render the MAC fallback in monospace.
export function deviceIdentity(d: Device): { label: string; isMac: boolean } {
  if (d.description && d.description.trim()) return { label: d.description, isMac: false };
  if (d.hostname && d.hostname.trim()) return { label: d.hostname, isMac: false };
  return { label: d.mac, isMac: true };
}

/// A device's total bytes over the window.
export function deviceTotalBytes(d: Device): number {
  return (d.bytes_in ?? 0) + (d.bytes_out ?? 0);
}
