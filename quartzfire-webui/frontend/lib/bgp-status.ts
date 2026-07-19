// Live BGP session status (Routing → BGP → Status tab).
//
// The config layer (`lib/bgp.ts`) edits `protocols bgp` through the VyOS proxy.
// This is the *operational* read side: it hits the backend's FRR-via-vtysh
// endpoints (see backend `bgp.rs`) and returns the flattened structs the Status
// panel renders. Everything here is read-only.

import { apiFetch } from "./api";
import type { AddressFamily } from "./bgp";

// ── models (mirror backend bgp.rs) ──────────────────────────────────────────

export interface PeerSummary {
  neighbor: string;
  remote_as: string | null;
  /** FRR session state: `Established`, `Idle`, `Connect`, `Active`, … */
  state: string;
  is_up: boolean;
  /** Seconds the session has been up; null when it has never come up. */
  uptime_secs: number | null;
  prefixes_received: number | null;
  prefixes_sent: number | null;
  msg_rcvd: number | null;
  msg_sent: number | null;
}

export interface AfSummary {
  af: AddressFamily;
  total_peers: number;
  established_peers: number;
  peers: PeerSummary[];
}

export interface BgpSummary {
  router_id: string | null;
  local_as: string | null;
  address_families: AfSummary[];
}

export interface Capability {
  name: string;
  value: string;
}

export interface MessageStats {
  opens_sent: number;
  opens_recv: number;
  notifications_sent: number;
  notifications_recv: number;
  updates_sent: number;
  updates_recv: number;
  keepalives_sent: number;
  keepalives_recv: number;
  route_refresh_sent: number;
  route_refresh_recv: number;
  total_sent: number;
  total_recv: number;
}

export interface AfPrefixes {
  af: AddressFamily;
  accepted_prefixes: number | null;
  sent_prefixes: number | null;
}

export interface NeighborDetail {
  neighbor: string;
  remote_as: string | null;
  local_as: string | null;
  description: string | null;
  remote_router_id: string | null;
  state: string;
  is_up: boolean;
  uptime_secs: number | null;
  hold_time_secs: number | null;
  keepalive_secs: number | null;
  connections_established: number | null;
  connections_dropped: number | null;
  last_reset: string | null;
  capabilities: Capability[];
  message_stats: MessageStats;
  address_families: AfPrefixes[];
}

// ── fetchers ────────────────────────────────────────────────────────────────

export function fetchBgpSummary(): Promise<BgpSummary> {
  return apiFetch<BgpSummary>("/bgp/summary");
}

export function fetchBgpNeighbor(id: string): Promise<NeighborDetail> {
  return apiFetch<NeighborDetail>(`/bgp/neighbor/${encodeURIComponent(id)}`);
}

// ── helpers ─────────────────────────────────────────────────────────────────

/// Compact uptime like `3d 4h`, `12m 5s`, or `—` when never up.
export function formatUptime(secs: number | null): string {
  if (secs == null) return "—";
  if (secs < 1) return "0s";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
