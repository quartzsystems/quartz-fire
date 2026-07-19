// Traffic Flow data layer (Monitoring → Traffic Flow).
//
// One endpoint: windowed, bytes-weighted flow records with firewall-rule
// attribution (backend/src/monitoring/flows.rs — conntrack byte sums joined
// against the nftables log on the service tuple). The Sankey aggregation into
// facet columns happens client-side so reordering facets never refetches.

import { apiFetch } from "./api";

export type FlowWindow = "5m" | "15m" | "1h";
export type FlowMetric = "bytes" | "hits";

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
  /** Connections begun over the window — the "hits" weight. */
  conns: number;
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
  total_conns: number;
  flow_count: number;
  truncated: boolean;
  attributed_bytes: number;
  attributed_conns: number;
  /** False until a qfdevd with flow recording has created the table. */
  available: boolean;
  window: string;
  now: number;
}

/** `metric` picks the server-side top-N ranking so a truncated result keeps
 * the heaviest flows for whichever weight the diagram is showing. */
export async function fetchFlows(window: FlowWindow, metric: FlowMetric, limit = 400): Promise<FlowsResponse> {
  return apiFetch<FlowsResponse>(`/monitoring/flows?window=${window}&metric=${metric}&limit=${limit}`);
}

/// One rule move of a reorder: (chain, old number) → new number.
export interface AttributionMove {
  chain: string;
  from: number;
  to: number;
}

/** Re-point the backend's flow-attribution cache after a rule renumber. The
 * nftables log prefix only carries rule numbers, so without this a long-lived
 * flow's cached number would resolve to whichever rule holds it NOW — the
 * Sankey would file its bytes under the wrong rule until the flow re-logs. */
export async function remapFlowAttribution(moves: AttributionMove[]): Promise<void> {
  if (moves.length === 0) return;
  await apiFetch(`/monitoring/flows/renumber`, { method: "POST", body: JSON.stringify(moves) });
}
