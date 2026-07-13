// Unified log/event model — normalizes the firewall traffic stream, the Content
// Filtering access log, and the IPS / Application-Control / Geolocation security
// alerts into one row shape so the Monitoring → Logs page can merge and render
// them in a single time-sorted table.
//
// Each source keeps its own live transport (firewall/IPS/AppControl/Geo are SSE;
// Content Filtering is polled — it has no stream), but everything lands here as a
// UnifiedEvent. `key` is the cross-poll/reconnect dedupe identity; the page adds
// a numeric `id` for React.

import type { RuleChain } from "./firewall";
import type { IpsAlert } from "./ips";
import type { AcEvent } from "./appcontrol";
import type { GeoEvent } from "./geolocation";
import type { CfLogEntry } from "./content-filtering";

export type UnifiedSource = "firewall" | "content-filtering" | "ips" | "appcontrol" | "geo";
export type UnifiedAction = "allowed" | "blocked" | "alert";

/// One firewall SSE payload (backend/src/monitor.rs LogEntry). Mirrors the shape
/// the Traffic Monitor page consumes; duplicated here so the unified page can
/// import it without depending on that page.
export interface FirewallLogEntry {
  ts: number;
  family: string;
  chain: RuleChain;
  rule: number | null;
  action: "accept" | "drop" | "reject";
  ips: boolean;
  in?: string;
  out?: string;
  src?: string;
  dst?: string;
  proto?: string;
  spt?: number;
  dpt?: number;
  len?: number;
  icmp_type?: number;
}

export interface UnifiedEvent {
  /// React key — a monotonic counter assigned by the page.
  id: number;
  /// Dedupe identity across reconnect backfills and Content Filtering polls.
  key: string;
  /// Milliseconds since the epoch.
  ts: number;
  source: UnifiedSource;
  action: UnifiedAction;
  /// The primary human descriptor: rule name / URL / signature / app / geo action.
  summary: string;
  src?: string;
  spt?: number;
  dst?: string;
  dpt?: number;
  proto?: string;
  /// "in → out" (firewall/geo) or a single interface, when known.
  iface?: string;
  /// Secondary context: category, severity, group, SNI, chain, …
  detail?: string;
}

export const SOURCE_META: Record<UnifiedSource, { label: string; badge: string }> = {
  firewall: { label: "Firewall", badge: "badge-info" },
  "content-filtering": { label: "Filter", badge: "badge-ok" },
  ips: { label: "IPS", badge: "badge-crit" },
  appcontrol: { label: "App", badge: "badge-warn" },
  geo: { label: "Geo", badge: "badge-info" },
};

type Raw = Omit<UnifiedEvent, "id">;

// ── per-source normalizers ────────────────────────────────────────────────────

/// The firewall entry needs its rule resolved to a friendly name by the caller
/// (the page owns the rule-number → name map), so the label is passed in.
export function normalizeFirewall(e: FirewallLogEntry, ruleLabel: string): Raw {
  const iface = e.in ? (e.out ? `${e.in} → ${e.out}` : e.in) : e.out;
  const detail = [e.chain !== "forward" ? e.chain : null, e.ips ? "IPS" : null]
    .filter(Boolean)
    .join(" · ");
  return {
    key: `fw|${e.ts}|${e.src ?? ""}:${e.spt ?? ""}|${e.dst ?? ""}:${e.dpt ?? ""}|${e.chain}:${e.rule ?? "d"}`,
    ts: e.ts,
    source: "firewall",
    action: e.action === "accept" ? "allowed" : "blocked",
    summary: ruleLabel,
    src: e.src,
    spt: e.spt,
    dst: e.dst,
    dpt: e.dpt,
    proto: e.proto,
    iface,
    detail: detail || undefined,
  };
}

export function normalizeCf(e: CfLogEntry): Raw {
  const ts = Date.parse(e.ts);
  const action: UnifiedAction = e.action === "blocked" ? "blocked" : "allowed";
  const detail = [e.category, e.group ? `group ${e.group}` : null, e.reason]
    .filter(Boolean)
    .join(" · ");
  return {
    key: `cf|${e.ts}|${e.client_ip}|${e.url}|${e.action}`,
    ts: Number.isFinite(ts) ? ts : Date.now(),
    source: "content-filtering",
    action,
    summary: e.url,
    src: e.client_ip,
    detail: detail || undefined,
  };
}

export function normalizeIps(e: IpsAlert): Raw {
  // `blocked` = dropped inline; `allowed` = alert-only detection.
  const action: UnifiedAction = e.action === "blocked" ? "blocked" : "alert";
  const detail = [e.level, e.category].filter(Boolean).join(" · ");
  return {
    key: `ips|${e.ts}|${e.flow_id ?? ""}|${e.sid}`,
    ts: e.ts,
    source: "ips",
    action,
    summary: e.signature,
    src: e.src,
    spt: e.spt,
    dst: e.dst,
    dpt: e.dpt,
    proto: e.proto,
    detail: detail || undefined,
  };
}

export function normalizeAc(e: AcEvent): Raw {
  const detail = [e.category, e.sni, e.confidence ? `conf ${e.confidence}` : null]
    .filter(Boolean)
    .join(" · ");
  return {
    key: `ac|${e.ts}|${e.app}|${e.src ?? ""}:${e.spt ?? ""}|${e.dst ?? ""}:${e.dpt ?? ""}`,
    ts: e.ts,
    source: "appcontrol",
    action: e.action === "block" ? "blocked" : "allowed",
    summary: e.app,
    src: e.src,
    spt: e.spt,
    dst: e.dst,
    dpt: e.dpt,
    proto: e.proto,
    detail: detail || undefined,
  };
}

export function normalizeGeo(e: GeoEvent): Raw {
  const blocked = /block|drop|deny|reject/i.test(e.action_name);
  const iface = e.iif ? (e.oif ? `${e.iif} → ${e.oif}` : e.iif) : e.oif;
  return {
    key: `geo|${e.ts}|${e.action_name}|${e.src ?? ""}:${e.spt ?? ""}|${e.dst ?? ""}:${e.dpt ?? ""}`,
    ts: e.ts,
    source: "geo",
    action: blocked ? "blocked" : "alert",
    summary: e.action_name,
    src: e.src,
    spt: e.spt,
    dst: e.dst,
    dpt: e.dpt,
    proto: e.proto,
    iface,
    detail: undefined,
  };
}
