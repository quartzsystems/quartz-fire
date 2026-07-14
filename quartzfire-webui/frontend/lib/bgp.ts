// BGP data layer (`protocols bgp`) — spine/leaf underlay + L2VPN-EVPN overlay.
//
// Unlike the tag-list domains (routes, interfaces), BGP is a single global
// config node. `fetchBgp` reads the whole `protocols bgp` subtree into a
// structured object; the apply functions diff one slice at a time (global
// settings, one neighbor, one peer-group) into a minimal command list.
//
// A bad BGP change can sever the management session (it drives the fabric), so
// every apply goes through `guardedCommitAndSave` — live immediately, auto-
// reverted unless confirmed in the shell banner.

import { vyosApi } from "./api";
import { VyosCommand, VyosResponse } from "./interfaces";
import { guardedCommitAndSave } from "./guard";

const commitAndSave = (commands: VyosCommand[], what: string) =>
  guardedCommitAndSave(commands, what);

// ── model ─────────────────────────────────────────────────────────────────────

export type AddressFamily = "ipv4-unicast" | "ipv6-unicast" | "l2vpn-evpn";

export const ADDRESS_FAMILIES: AddressFamily[] = ["ipv4-unicast", "ipv6-unicast", "l2vpn-evpn"];

/// Per-neighbor (or per-peer-group) settings for one activated address family.
export interface NeighborAf {
  /** The AF is activated for this peer (`address-family <af>` node present). */
  enabled: boolean;
  route_reflector_client: boolean;
  nexthop_self: boolean;
  soft_reconfiguration_inbound: boolean;
  /** `allowas-in number <n>` — accept our own AS up to n times. */
  allowas_in: number | null;
  /** `maximum-prefix <n>` — not valid for l2vpn-evpn. */
  maximum_prefix: number | null;
  route_map_import: string | null;
  route_map_export: string | null;
}

/// A BGP neighbor or peer-group. Peer-groups reuse the same shape minus the
/// neighbor-only fields (`peer_group`, `is_interface`).
export interface BgpPeer {
  /** Neighbor address/interface name, or peer-group name. */
  name: string;
  /** Unnumbered neighbor (`interface v6only`) — neighbors only. */
  is_interface: boolean;
  /** ASN, or the keywords `external` / `internal`. */
  remote_as: string | null;
  /** Membership in a peer-group — neighbors only. */
  peer_group: string | null;
  update_source: string | null;
  ebgp_multihop: number | null;
  description: string | null;
  /** `capability extended-nexthop` — required for IPv6-unnumbered fabrics. */
  extended_nexthop: boolean;
  bfd: boolean;
  /** `!shutdown` — a shut peer keeps its config but drops the session. */
  enabled: boolean;
  afi: Record<AddressFamily, NeighborAf>;
}

/// A global unicast address family (ipv4/ipv6): originated networks + protocol
/// redistribution.
export interface BgpUnicastAf {
  networks: string[];
  redistribute: string[];
}

/// The global L2VPN-EVPN address family (the overlay control plane).
///
/// Note: RD and route-target are NOT leaves of the default instance's global
/// EVPN AF in VyOS — they only exist per-VNI or under a VRF (out of scope), so
/// they're intentionally absent here.
export interface BgpEvpnAf {
  advertise_all_vni: boolean;
  advertise_ipv4_unicast: boolean;
  advertise_ipv6_unicast: boolean;
}

export interface BgpGlobal {
  system_as: string | null;
  router_id: string | null;
  default_no_ipv4_unicast: boolean;
  bestpath_as_path_multipath_relax: boolean;
  bestpath_compare_routerid: boolean;
  log_neighbor_changes: boolean;
  /** Route-reflector cluster id. */
  cluster_id: string | null;
  ipv4_unicast: BgpUnicastAf;
  ipv6_unicast: BgpUnicastAf;
  evpn: BgpEvpnAf;
}

export interface BgpConfig {
  global: BgpGlobal;
  neighbors: BgpPeer[];
  peerGroups: BgpPeer[];
}

export function emptyAf(): NeighborAf {
  return {
    enabled: false,
    route_reflector_client: false,
    nexthop_self: false,
    soft_reconfiguration_inbound: false,
    allowas_in: null,
    maximum_prefix: null,
    route_map_import: null,
    route_map_export: null,
  };
}

export function emptyAfi(): Record<AddressFamily, NeighborAf> {
  return { "ipv4-unicast": emptyAf(), "ipv6-unicast": emptyAf(), "l2vpn-evpn": emptyAf() };
}

export function emptyPeer(): BgpPeer {
  return {
    name: "",
    is_interface: false,
    remote_as: null,
    peer_group: null,
    update_source: null,
    ebgp_multihop: null,
    description: null,
    extended_nexthop: false,
    bfd: false,
    enabled: true,
    afi: emptyAfi(),
  };
}

export function emptyGlobal(): BgpGlobal {
  return {
    system_as: null,
    router_id: null,
    default_no_ipv4_unicast: false,
    bestpath_as_path_multipath_relax: false,
    bestpath_compare_routerid: false,
    log_neighbor_changes: false,
    cluster_id: null,
    ipv4_unicast: { networks: [], redistribute: [] },
    ipv6_unicast: { networks: [], redistribute: [] },
    evpn: {
      advertise_all_vni: false,
      advertise_ipv4_unicast: false,
      advertise_ipv6_unicast: false,
    },
  };
}

// ── parse ─────────────────────────────────────────────────────────────────────

type Cfg = Record<string, unknown>;

function childStr(v: Cfg, key: string): string | null {
  const x = v[key];
  if (typeof x !== "string") return null;
  const s = x.trim();
  return s === "" ? null : s;
}

function childCfg(v: Cfg, key: string): Cfg | null {
  const x = v[key];
  return x && typeof x === "object" ? (x as Cfg) : null;
}

function childNum(v: Cfg, key: string): number | null {
  const s = childStr(v, key);
  const n = s === null ? NaN : Number(s);
  return Number.isInteger(n) ? n : null;
}

/// Multi-value leaf → sorted key list (VyOS renders `network`/`redistribute` as
/// child maps keyed by value).
function keysOf(v: Cfg | null): string[] {
  return v ? Object.keys(v).sort() : [];
}

function parseAf(afNode: Cfg | null): NeighborAf {
  if (!afNode) return emptyAf();
  const rm = childCfg(afNode, "route-map");
  const allowas = childCfg(afNode, "allowas-in");
  return {
    enabled: true,
    route_reflector_client: "route-reflector-client" in afNode,
    nexthop_self: "nexthop-self" in afNode,
    soft_reconfiguration_inbound: "inbound" in (childCfg(afNode, "soft-reconfiguration") ?? {}),
    // `allowas-in` may carry `number <n>`, or be a bare flag (treat as 1).
    allowas_in: allowas ? childNum(allowas, "number") ?? 1 : "allowas-in" in afNode ? 1 : null,
    maximum_prefix: childNum(afNode, "maximum-prefix"),
    route_map_import: rm ? childStr(rm, "import") : null,
    route_map_export: rm ? childStr(rm, "export") : null,
  };
}

function parsePeer(name: string, raw: Cfg): BgpPeer {
  const afRoot = childCfg(raw, "address-family") ?? {};
  const capability = childCfg(raw, "capability") ?? {};
  // Unnumbered peers keep remote-as/peer-group under `interface v6only` (or
  // directly under `interface`); everything else stays at neighbor level.
  const iface = childCfg(raw, "interface");
  const ifaceInner = iface ? childCfg(iface, "v6only") ?? iface : null;
  return {
    name,
    is_interface: iface !== null,
    remote_as: childStr(raw, "remote-as") ?? (ifaceInner ? childStr(ifaceInner, "remote-as") : null),
    peer_group: childStr(raw, "peer-group") ?? (ifaceInner ? childStr(ifaceInner, "peer-group") : null),
    update_source: childStr(raw, "update-source"),
    ebgp_multihop: childNum(raw, "ebgp-multihop"),
    description: childStr(raw, "description"),
    extended_nexthop: "extended-nexthop" in capability,
    bfd: "bfd" in raw,
    enabled: !("shutdown" in raw),
    afi: {
      "ipv4-unicast": parseAf(childCfg(afRoot, "ipv4-unicast")),
      "ipv6-unicast": parseAf(childCfg(afRoot, "ipv6-unicast")),
      "l2vpn-evpn": parseAf(childCfg(afRoot, "l2vpn-evpn")),
    },
  };
}

function parseGlobal(bgp: Cfg): BgpGlobal {
  const params = childCfg(bgp, "parameters") ?? {};
  const bestpath = childCfg(params, "bestpath") ?? {};
  const af = childCfg(bgp, "address-family") ?? {};
  const v4 = childCfg(af, "ipv4-unicast") ?? {};
  const v6 = childCfg(af, "ipv6-unicast") ?? {};
  const evpn = childCfg(af, "l2vpn-evpn") ?? {};
  const advertise = childCfg(evpn, "advertise") ?? {};

  return {
    system_as: childStr(bgp, "system-as"),
    router_id: childStr(params, "router-id"),
    default_no_ipv4_unicast: "no-ipv4-unicast" in (childCfg(params, "default") ?? {}),
    bestpath_as_path_multipath_relax:
      "multipath-relax" in (childCfg(bestpath, "as-path") ?? {}),
    bestpath_compare_routerid: "compare-routerid" in bestpath,
    log_neighbor_changes: "log-neighbor-changes" in params,
    cluster_id: childStr(params, "cluster-id"),
    ipv4_unicast: { networks: keysOf(childCfg(v4, "network")), redistribute: keysOf(childCfg(v4, "redistribute")) },
    ipv6_unicast: { networks: keysOf(childCfg(v6, "network")), redistribute: keysOf(childCfg(v6, "redistribute")) },
    evpn: {
      advertise_all_vni: "advertise-all-vni" in evpn,
      advertise_ipv4_unicast: "unicast" in (childCfg(advertise, "ipv4") ?? {}),
      advertise_ipv6_unicast: "unicast" in (childCfg(advertise, "ipv6") ?? {}),
    },
  };
}

/// The whole BGP config, structured. Absent (`{}`) when nothing is configured.
export async function fetchBgp(): Promise<BgpConfig> {
  const resp = await vyosApi<VyosResponse<Cfg | null>>("retrieve", {
    op: "showConfig",
    path: ["protocols", "bgp"],
  });

  let bgp: Cfg = {};
  if (resp.success) bgp = resp.data ?? {};
  else if (!(resp.error ?? "").toLowerCase().includes("empty")) {
    throw new Error(resp.error || "Device returned an error reading BGP configuration.");
  }

  const neighbors = Object.entries(childCfg(bgp, "neighbor") ?? {})
    .map(([n, raw]) => parsePeer(n, (raw ?? {}) as Cfg))
    .sort((a, b) => a.name.localeCompare(b.name));
  const peerGroups = Object.entries(childCfg(bgp, "peer-group") ?? {})
    .map(([n, raw]) => parsePeer(n, (raw ?? {}) as Cfg))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { global: parseGlobal(bgp), neighbors, peerGroups };
}

// ── diff helpers ────────────────────────────────────────────────────────────────

const BASE = ["protocols", "bgp"];
const trimmed = (s: string | null) => {
  const t = s?.trim() ?? "";
  return t === "" ? null : t;
};

/// Single-value leaf: set when it changed to a value, delete when cleared.
function leaf(out: VyosCommand[], path: string[], live: string | null, desired: string | null) {
  const d = trimmed(desired);
  if (d === (live ?? null)) return;
  if (d !== null) out.push({ op: "set", path: [...path, d] });
  else out.push({ op: "delete", path });
}

/// Valueless flag leaf: presence toggle.
function flag(out: VyosCommand[], path: string[], live: boolean, desired: boolean) {
  if (desired === live) return;
  out.push({ op: desired ? "set" : "delete", path });
}

/// Multi-value leaf (e.g. `network`, `redistribute`): add/remove children.
function multi(out: VyosCommand[], path: string[], live: string[], desired: string[]) {
  const want = desired.map((s) => s.trim()).filter(Boolean);
  for (const v of want) if (!live.includes(v)) out.push({ op: "set", path: [...path, v] });
  for (const v of live) if (!want.includes(v)) out.push({ op: "delete", path: [...path, v] });
}

// ── global ──────────────────────────────────────────────────────────────────────

export function diffBgpGlobal(live: BgpGlobal, u: BgpGlobal): VyosCommand[] {
  const out: VyosCommand[] = [];
  const p = (...s: string[]) => [...BASE, ...s];

  leaf(out, p("system-as"), live.system_as, u.system_as);
  leaf(out, p("parameters", "router-id"), live.router_id, u.router_id);
  leaf(out, p("parameters", "cluster-id"), live.cluster_id, u.cluster_id);
  flag(out, p("parameters", "default", "no-ipv4-unicast"), live.default_no_ipv4_unicast, u.default_no_ipv4_unicast);
  flag(out, p("parameters", "bestpath", "as-path", "multipath-relax"), live.bestpath_as_path_multipath_relax, u.bestpath_as_path_multipath_relax);
  flag(out, p("parameters", "bestpath", "compare-routerid"), live.bestpath_compare_routerid, u.bestpath_compare_routerid);
  flag(out, p("parameters", "log-neighbor-changes"), live.log_neighbor_changes, u.log_neighbor_changes);

  for (const [af, l, d] of [
    ["ipv4-unicast", live.ipv4_unicast, u.ipv4_unicast],
    ["ipv6-unicast", live.ipv6_unicast, u.ipv6_unicast],
  ] as const) {
    multi(out, p("address-family", af, "network"), l.networks, d.networks);
    multi(out, p("address-family", af, "redistribute"), l.redistribute, d.redistribute);
  }

  const e = ["address-family", "l2vpn-evpn"];
  flag(out, p(...e, "advertise-all-vni"), live.evpn.advertise_all_vni, u.evpn.advertise_all_vni);
  flag(out, p(...e, "advertise", "ipv4", "unicast"), live.evpn.advertise_ipv4_unicast, u.evpn.advertise_ipv4_unicast);
  flag(out, p(...e, "advertise", "ipv6", "unicast"), live.evpn.advertise_ipv6_unicast, u.evpn.advertise_ipv6_unicast);

  return out;
}

export function applyBgpGlobal(live: BgpGlobal, update: BgpGlobal): Promise<number> {
  return commitAndSave(diffBgpGlobal(live, update), "BGP global settings change");
}

// ── neighbor / peer-group ─────────────────────────────────────────────────────────

/// Diff one activated address family under a peer.
function diffPeerAf(out: VyosCommand[], base: string[], af: AddressFamily, live: NeighborAf, u: NeighborAf) {
  const p = (...s: string[]) => [...base, "address-family", af, ...s];

  // Whole-AF toggle. Disabling drops the node; the sub-leaves go with it.
  if (!u.enabled) {
    if (live.enabled) out.push({ op: "delete", path: p() });
    return;
  }
  // Newly activated: create the node, then diff sub-settings against defaults.
  const baseline = live.enabled ? live : emptyAf();
  if (!live.enabled) out.push({ op: "set", path: p() });

  flag(out, p("route-reflector-client"), baseline.route_reflector_client, u.route_reflector_client);
  flag(out, p("nexthop-self"), baseline.nexthop_self, u.nexthop_self);
  flag(out, p("soft-reconfiguration", "inbound"), baseline.soft_reconfiguration_inbound, u.soft_reconfiguration_inbound);

  leaf(out, p("allowas-in", "number"),
    baseline.allowas_in != null ? String(baseline.allowas_in) : null,
    u.allowas_in != null ? String(u.allowas_in) : null);

  // maximum-prefix is not valid for l2vpn-evpn.
  if (af !== "l2vpn-evpn") {
    leaf(out, p("maximum-prefix"),
      baseline.maximum_prefix != null ? String(baseline.maximum_prefix) : null,
      u.maximum_prefix != null ? String(u.maximum_prefix) : null);
  }

  leaf(out, p("route-map", "import"), baseline.route_map_import, u.route_map_import);
  leaf(out, p("route-map", "export"), baseline.route_map_export, u.route_map_export);
}

/// Diff a peer (neighbor when `kind==="neighbor"`, else peer-group) into a
/// command list. `live===null` means it's being created.
function diffPeer(kind: "neighbor" | "peer-group", live: BgpPeer | null, u: BgpPeer): VyosCommand[] {
  const base = [...BASE, kind, u.name];
  const out: VyosCommand[] = [];
  const p = (...s: string[]) => [...base, ...s];

  // remote-as / peer-group placement: for an unnumbered neighbor they live
  // under `interface v6only`; otherwise directly under the neighbor/peer-group.
  if (kind === "neighbor" && u.is_interface) {
    const v6 = p("interface", "v6only");
    flag(out, v6, live?.is_interface ?? false, true); // ensure the v6only node exists
    leaf(out, [...v6, "remote-as"], live?.remote_as ?? null, u.remote_as);
    leaf(out, [...v6, "peer-group"], live?.peer_group ?? null, u.peer_group);
  } else {
    leaf(out, p("remote-as"), live?.remote_as ?? null, u.remote_as);
    if (kind === "neighbor") leaf(out, p("peer-group"), live?.peer_group ?? null, u.peer_group);
  }

  leaf(out, p("update-source"), live?.update_source ?? null, u.update_source);
  leaf(out, p("ebgp-multihop"),
    live?.ebgp_multihop != null ? String(live.ebgp_multihop) : null,
    u.ebgp_multihop != null ? String(u.ebgp_multihop) : null);
  leaf(out, p("description"), live?.description ?? null, u.description);
  flag(out, p("capability", "extended-nexthop"), live?.extended_nexthop ?? false, u.extended_nexthop);
  flag(out, p("bfd"), live?.bfd ?? false, u.bfd);
  flag(out, p("shutdown"), !(live?.enabled ?? true), !u.enabled);

  for (const af of ADDRESS_FAMILIES) {
    diffPeerAf(out, base, af, live?.afi[af] ?? emptyAf(), u.afi[af]);
  }

  // A brand-new peer with no leaves set still needs its node created.
  if (live === null && !out.some((c) => c.op === "set")) {
    return [{ op: "set", path: base }];
  }
  return out;
}

export function applyBgpNeighbor(live: BgpPeer | null, update: BgpPeer): Promise<number> {
  return commitAndSave(diffPeer("neighbor", live, update), `BGP neighbor ${update.name} change`);
}

export function deleteBgpNeighbor(name: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: [...BASE, "neighbor", name] }], `Delete BGP neighbor ${name}`);
}

export function applyBgpPeerGroup(live: BgpPeer | null, update: BgpPeer): Promise<number> {
  return commitAndSave(diffPeer("peer-group", live, update), `BGP peer-group ${update.name} change`);
}

export function deleteBgpPeerGroup(name: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: [...BASE, "peer-group", name] }], `Delete BGP peer-group ${name}`);
}
