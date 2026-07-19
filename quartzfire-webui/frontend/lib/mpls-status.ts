// Live MPLS / LDP status (Routing → MPLS → Status tab).
//
// Operational read side, hitting the backend's FRR-via-vtysh endpoints (see
// backend `mpls.rs`). Every field is optional because FRR's LDP JSON key names
// drift across releases; the backend normalizes what it can and the UI renders
// "—" for the rest. Read-only.

import { apiFetch } from "./api";

// ── models (mirror backend mpls.rs) ─────────────────────────────────────────

export interface LdpNeighbor {
  neighbor_id: string | null;
  address_family: string | null;
  state: string | null;
  is_up: boolean;
  transport_address: string | null;
  uptime: string | null;
}

export interface LdpAdjacency {
  address_family: string | null;
  interface: string | null;
  neighbor_id: string | null;
  source: string | null;
  hold_time: number | null;
}

export interface MplsStatus {
  ldp_running: boolean;
  neighbors: LdpNeighbor[];
  discovery: LdpAdjacency[];
}

export interface LdpBinding {
  prefix: string | null;
  local_label: string | null;
  remote_label: string | null;
  neighbor_id: string | null;
  in_use: boolean;
}

export interface MplsRoute {
  in_label: string | null;
  out_label: string | null;
  nexthop: string | null;
  interface: string | null;
  installed: boolean;
}

// ── fetchers ────────────────────────────────────────────────────────────────

export function fetchMplsStatus(): Promise<MplsStatus> {
  return apiFetch<MplsStatus>("/mpls/status");
}

export function fetchMplsBindings(): Promise<LdpBinding[]> {
  return apiFetch<LdpBinding[]>("/mpls/bindings");
}

export function fetchMplsTable(): Promise<MplsRoute[]> {
  return apiFetch<MplsRoute[]>("/mpls/table");
}
