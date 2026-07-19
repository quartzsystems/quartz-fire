// Live OSPFv2 status (Routing → OSPF → Status tab).
//
// The config layer (`lib/ospf.ts`) edits `protocols ospf` through the VyOS
// proxy. This is the operational read side: it hits the backend's FRR-via-vtysh
// endpoint (see backend `ospf.rs`) and returns the flattened structs the Status
// panel renders. Read-only. Every optional field mirrors the backend's tolerant
// extraction from FRR's drifting JSON keys.

import { apiFetch } from "./api";

// ── models (mirror backend ospf.rs) ─────────────────────────────────────────

export interface OspfAreaSummary {
  area: string;
  backbone: boolean;
  interfaces_total: number | null;
  interfaces_active: number | null;
  neighbors_full: number | null;
}

export interface OspfNeighborState {
  neighbor_id: string;
  address: string | null;
  interface: string | null;
  /** FRR state string, e.g. `Full/DR`, `2-Way/DROther`, `Init`. */
  state: string;
  is_up: boolean;
  priority: number | null;
  dead_time_secs: number | null;
  uptime_secs: number | null;
}

export interface OspfInterfaceState {
  name: string;
  area: string | null;
  state: string | null;
  cost: number | null;
  network_type: string | null;
  hello_secs: number | null;
  dead_secs: number | null;
  neighbor_count: number | null;
  passive: boolean;
}

export interface OspfSummary {
  running: boolean;
  router_id: string | null;
  areas: OspfAreaSummary[];
  neighbors: OspfNeighborState[];
  interfaces: OspfInterfaceState[];
}

export function fetchOspfSummary(): Promise<OspfSummary> {
  return apiFetch<OspfSummary>("/ospf/summary");
}
