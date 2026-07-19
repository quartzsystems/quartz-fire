// Traffic Flow data layer (Monitoring → Traffic Flow).
//
// One endpoint: windowed, bytes-weighted flow records with firewall-rule
// attribution (backend/src/monitoring/flows.rs — conntrack byte sums joined
// against the nftables log on the service tuple). The Sankey aggregation into
// facet columns happens client-side so reordering facets never refetches.

import { apiFetch } from "./api";

export type FlowWindow = "5m" | "15m" | "1h";

/// One aggregated flow, matching backend FlowRecord. Attribution fields are
/// absent when no packet of the tuple was ever logged: `chain` undefined means
/// unattributed, while `chain` set with `rule` undefined is a default action.
export interface FlowRecord {
  src: string;
  dst: string;
  proto: string;
  dport: number;
  bytes_orig: number;
  bytes_reply: number;
  bytes: number;
  src_name?: string;
  dst_name?: string;
  chain?: string;
  rule?: number;
  action?: string;
  ips?: boolean;
  in_if?: string;
  out_if?: string;
}

export interface FlowsResponse {
  flows: FlowRecord[];
  /** Window totals over ALL tuples, not just the returned top-N. */
  total_bytes: number;
  flow_count: number;
  truncated: boolean;
  attributed_bytes: number;
  /** False until a qfdevd with flow recording has created the table. */
  available: boolean;
  window: string;
  now: number;
}

export async function fetchFlows(window: FlowWindow, limit = 400): Promise<FlowsResponse> {
  return apiFetch<FlowsResponse>(`/monitoring/flows?window=${window}&limit=${limit}`);
}
