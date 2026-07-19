// Live IS-IS status (Routing → IS-IS → Status tab).
//
// The config layer (`lib/isis.ts`) edits `protocols isis` through the VyOS
// proxy. This is the operational read side: it hits the backend's FRR-via-vtysh
// endpoint (see backend `isis.rs`) and returns the flattened structs the Status
// panel renders. Read-only. Every optional field mirrors the backend's tolerant
// extraction from FRR's nested, drifting JSON keys.

import { apiFetch } from "./api";

// ── models (mirror backend isis.rs) ─────────────────────────────────────────

export interface IsisAreaState {
  area: string | null;
  net: string | null;
  system_id: string | null;
  is_type: string | null;
}

export interface IsisNeighborState {
  system_id: string | null;
  interface: string | null;
  level: string | null;
  state: string | null;
  is_up: boolean;
  expires: string | null;
  snpa: string | null;
}

export interface IsisSummary {
  running: boolean;
  areas: IsisAreaState[];
  neighbors: IsisNeighborState[];
}

export function fetchIsisSummary(): Promise<IsisSummary> {
  return apiFetch<IsisSummary>("/isis/summary");
}
