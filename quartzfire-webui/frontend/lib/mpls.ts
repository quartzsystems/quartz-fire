// MPLS data layer (`protocols mpls`) — MPLS forwarding + the LDP control plane.
//
// Like BGP (`lib/bgp.ts`), MPLS is a single global config node: `fetchMpls`
// reads the whole `protocols mpls` subtree into a structured object, and
// `applyMpls` diffs it back into a minimal command list. Every apply goes
// through `guardedCommitAndSave` — a bad label/LDP change can black-hole
// transit traffic, so it stays commit-confirm like the other routing domains.
//
// Config surface mirrors the VyOS 1.5 documentation:
//   https://docs.vyos.io/en/1.5/configuration/protocols/mpls.html

import { vyosApi } from "./api";
import { VyosCommand, VyosResponse } from "./interfaces";
import { guardedCommitAndSave } from "./guard";

// ── model ─────────────────────────────────────────────────────────────────────

/// One LDP neighbor (keyed by IPv4 LSR-id) with its optional session knobs.
export interface LdpNeighbor {
  address: string;
  password: string | null;
  session_holdtime: number | null;
  /** `disable`, or a GTSM hop count 1–254, or null (unset). */
  ttl_security: string | null;
}

/// Per-address-family targeted-neighbor (extended-discovery) settings.
export interface TargetedAf {
  enable: boolean;
  addresses: string[];
  hello_interval: number | null;
  hello_holdtime: number | null;
}

export interface MplsConfig {
  /** Interfaces with MPLS forwarding enabled (`mpls interface`). */
  interfaces: string[];
  no_propagate_ttl: boolean;
  maximum_ttl: number | null;

  ldp_router_id: string | null;
  /** LDP-enabled interfaces; value = `disable-establish-hello`. */
  ldp_interfaces: { name: string; disable_establish_hello: boolean }[];

  transport_ipv4_address: string | null;
  transport_ipv6_address: string | null;
  hello_ipv4_interval: number | null;
  hello_ipv4_holdtime: number | null;
  session_ipv4_holdtime: number | null;
  hello_ipv6_interval: number | null;
  hello_ipv6_holdtime: number | null;
  session_ipv6_holdtime: number | null;

  neighbors: LdpNeighbor[];

  cisco_interop_tlv: boolean;
  ordered_control: boolean;
  transport_prefer_ipv4: boolean;

  targeted_ipv4: TargetedAf;
  targeted_ipv6: TargetedAf;
}

export function emptyTargeted(): TargetedAf {
  return { enable: false, addresses: [], hello_interval: null, hello_holdtime: null };
}

export function emptyMpls(): MplsConfig {
  return {
    interfaces: [],
    no_propagate_ttl: false,
    maximum_ttl: null,
    ldp_router_id: null,
    ldp_interfaces: [],
    transport_ipv4_address: null,
    transport_ipv6_address: null,
    hello_ipv4_interval: null,
    hello_ipv4_holdtime: null,
    session_ipv4_holdtime: null,
    hello_ipv6_interval: null,
    hello_ipv6_holdtime: null,
    session_ipv6_holdtime: null,
    neighbors: [],
    cisco_interop_tlv: false,
    ordered_control: false,
    transport_prefer_ipv4: false,
    targeted_ipv4: emptyTargeted(),
    targeted_ipv6: emptyTargeted(),
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

/// Multi-value leaf → sorted key list (VyOS renders these as child maps).
function keysOf(v: Cfg | null): string[] {
  return v ? Object.keys(v).sort() : [];
}

function parseTargeted(node: Cfg | null): TargetedAf {
  if (!node) return emptyTargeted();
  return {
    enable: "enable" in node,
    addresses: keysOf(childCfg(node, "address")),
    hello_interval: childNum(node, "hello-interval"),
    hello_holdtime: childNum(node, "hello-holdtime"),
  };
}

function parseMpls(mpls: Cfg): MplsConfig {
  const params = childCfg(mpls, "parameters") ?? {};
  const ldp = childCfg(mpls, "ldp") ?? {};
  const disc = childCfg(ldp, "discovery") ?? {};
  const ldpParams = childCfg(ldp, "parameters") ?? {};
  const targeted = childCfg(ldp, "targeted-neighbor") ?? {};

  const ldpIfaces = Object.entries(childCfg(ldp, "interface") ?? {})
    .map(([name, raw]) => ({
      name,
      disable_establish_hello: "disable-establish-hello" in ((raw ?? {}) as Cfg),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const neighbors = Object.entries(childCfg(ldp, "neighbor") ?? {})
    .map(([address, raw]) => {
      const n = (raw ?? {}) as Cfg;
      return {
        address,
        password: childStr(n, "password"),
        session_holdtime: childNum(n, "session-holdtime"),
        ttl_security: childStr(n, "ttl-security"),
      };
    })
    .sort((a, b) => a.address.localeCompare(b.address));

  return {
    interfaces: keysOf(childCfg(mpls, "interface")),
    no_propagate_ttl: "no-propagate-ttl" in params,
    maximum_ttl: childNum(params, "maximum-ttl"),

    ldp_router_id: childStr(ldp, "router-id"),
    ldp_interfaces: ldpIfaces,

    transport_ipv4_address: childStr(disc, "transport-ipv4-address"),
    transport_ipv6_address: childStr(disc, "transport-ipv6-address"),
    hello_ipv4_interval: childNum(disc, "hello-ipv4-interval"),
    hello_ipv4_holdtime: childNum(disc, "hello-ipv4-holdtime"),
    session_ipv4_holdtime: childNum(disc, "session-ipv4-holdtime"),
    hello_ipv6_interval: childNum(disc, "hello-ipv6-interval"),
    hello_ipv6_holdtime: childNum(disc, "hello-ipv6-holdtime"),
    session_ipv6_holdtime: childNum(disc, "session-ipv6-holdtime"),

    neighbors,

    cisco_interop_tlv: "cisco-interop-tlv" in ldpParams,
    ordered_control: "ordered-control" in ldpParams,
    transport_prefer_ipv4: "transport-prefer-ipv4" in ldpParams,

    targeted_ipv4: parseTargeted(childCfg(targeted, "ipv4")),
    targeted_ipv6: parseTargeted(childCfg(targeted, "ipv6")),
  };
}

/// The whole MPLS config, structured. Absent (`{}`) when nothing is configured.
export async function fetchMpls(): Promise<MplsConfig> {
  const resp = await vyosApi<VyosResponse<Cfg | null>>("retrieve", {
    op: "showConfig",
    path: ["protocols", "mpls"],
  });

  let mpls: Cfg = {};
  if (resp.success) mpls = resp.data ?? {};
  else if (!(resp.error ?? "").toLowerCase().includes("empty")) {
    throw new Error(resp.error || "Device returned an error reading MPLS configuration.");
  }
  return parseMpls(mpls);
}

// ── diff helpers ────────────────────────────────────────────────────────────────

const BASE = ["protocols", "mpls"];
const LDP = [...BASE, "ldp"];
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

function numLeaf(out: VyosCommand[], path: string[], live: number | null, desired: number | null) {
  leaf(out, path, live != null ? String(live) : null, desired != null ? String(desired) : null);
}

/// Valueless flag leaf: presence toggle.
function flag(out: VyosCommand[], path: string[], live: boolean, desired: boolean) {
  if (desired === live) return;
  out.push({ op: desired ? "set" : "delete", path });
}

/// Multi-value leaf (e.g. `interface`, `address`): add/remove children.
function multi(out: VyosCommand[], path: string[], live: string[], desired: string[]) {
  const want = desired.map((s) => s.trim()).filter(Boolean);
  for (const v of want) if (!live.includes(v)) out.push({ op: "set", path: [...path, v] });
  for (const v of live) if (!want.includes(v)) out.push({ op: "delete", path: [...path, v] });
}

// ── diff ─────────────────────────────────────────────────────────────────────

function diffTargeted(out: VyosCommand[], af: "ipv4" | "ipv6", live: TargetedAf, u: TargetedAf) {
  const p = (...s: string[]) => [...LDP, "targeted-neighbor", af, ...s];
  flag(out, p("enable"), live.enable, u.enable);
  multi(out, p("address"), live.addresses, u.addresses);
  numLeaf(out, p("hello-interval"), live.hello_interval, u.hello_interval);
  numLeaf(out, p("hello-holdtime"), live.hello_holdtime, u.hello_holdtime);
}

export function diffMpls(live: MplsConfig, u: MplsConfig): VyosCommand[] {
  const out: VyosCommand[] = [];
  const p = (...s: string[]) => [...BASE, ...s];
  const d = (...s: string[]) => [...LDP, "discovery", ...s];

  // MPLS forwarding + global parameters.
  multi(out, p("interface"), live.interfaces, u.interfaces);
  flag(out, p("parameters", "no-propagate-ttl"), live.no_propagate_ttl, u.no_propagate_ttl);
  numLeaf(out, p("parameters", "maximum-ttl"), live.maximum_ttl, u.maximum_ttl);

  // LDP global.
  leaf(out, [...LDP, "router-id"], live.ldp_router_id, u.ldp_router_id);

  // LDP interfaces (name + per-interface disable-establish-hello flag).
  const liveIf = new Map(live.ldp_interfaces.map((i) => [i.name, i]));
  const wantIf = new Map(u.ldp_interfaces.map((i) => [i.name, i]));
  for (const [name, want] of wantIf) {
    const l = liveIf.get(name);
    if (!l) out.push({ op: "set", path: [...LDP, "interface", name] });
    flag(out, [...LDP, "interface", name, "disable-establish-hello"],
      l?.disable_establish_hello ?? false, want.disable_establish_hello);
  }
  for (const name of liveIf.keys()) {
    if (!wantIf.has(name)) out.push({ op: "delete", path: [...LDP, "interface", name] });
  }

  // Discovery transport + timers.
  leaf(out, d("transport-ipv4-address"), live.transport_ipv4_address, u.transport_ipv4_address);
  leaf(out, d("transport-ipv6-address"), live.transport_ipv6_address, u.transport_ipv6_address);
  numLeaf(out, d("hello-ipv4-interval"), live.hello_ipv4_interval, u.hello_ipv4_interval);
  numLeaf(out, d("hello-ipv4-holdtime"), live.hello_ipv4_holdtime, u.hello_ipv4_holdtime);
  numLeaf(out, d("session-ipv4-holdtime"), live.session_ipv4_holdtime, u.session_ipv4_holdtime);
  numLeaf(out, d("hello-ipv6-interval"), live.hello_ipv6_interval, u.hello_ipv6_interval);
  numLeaf(out, d("hello-ipv6-holdtime"), live.hello_ipv6_holdtime, u.hello_ipv6_holdtime);
  numLeaf(out, d("session-ipv6-holdtime"), live.session_ipv6_holdtime, u.session_ipv6_holdtime);

  // Neighbors (keyed by address; delete on removal).
  const liveN = new Map(live.neighbors.map((n) => [n.address, n]));
  const wantN = new Map(u.neighbors.map((n) => [n.address, n]));
  for (const [addr, want] of wantN) {
    const l = liveN.get(addr);
    const np = (...s: string[]) => [...LDP, "neighbor", addr, ...s];
    if (!l) out.push({ op: "set", path: [...LDP, "neighbor", addr] });
    leaf(out, np("password"), l?.password ?? null, want.password);
    numLeaf(out, np("session-holdtime"), l?.session_holdtime ?? null, want.session_holdtime);
    leaf(out, np("ttl-security"), l?.ttl_security ?? null, want.ttl_security);
  }
  for (const addr of liveN.keys()) {
    if (!wantN.has(addr)) out.push({ op: "delete", path: [...LDP, "neighbor", addr] });
  }

  // LDP parameters.
  flag(out, [...LDP, "parameters", "cisco-interop-tlv"], live.cisco_interop_tlv, u.cisco_interop_tlv);
  flag(out, [...LDP, "parameters", "ordered-control"], live.ordered_control, u.ordered_control);
  flag(out, [...LDP, "parameters", "transport-prefer-ipv4"], live.transport_prefer_ipv4, u.transport_prefer_ipv4);

  // Targeted neighbors.
  diffTargeted(out, "ipv4", live.targeted_ipv4, u.targeted_ipv4);
  diffTargeted(out, "ipv6", live.targeted_ipv6, u.targeted_ipv6);

  return out;
}

export function applyMpls(live: MplsConfig, update: MplsConfig): Promise<number> {
  return guardedCommitAndSave(diffMpls(live, update), "MPLS/LDP configuration change");
}
