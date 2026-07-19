// IS-IS data layer (`protocols isis`).
//
// Like BGP/OSPF, IS-IS is a single global config node. `fetchIsis` reads the
// whole `protocols isis` subtree into a structured object; the apply functions
// diff one slice at a time (global settings, one interface) into a minimal
// command list.
//
// A bad IS-IS change can black-hole the fabric, so every apply goes through
// `guardedCommitAndSave` — live immediately, auto-reverted unless confirmed in
// the shell banner (see lib/guard).

import { vyosApi } from "./api";
import { VyosCommand, VyosResponse } from "./interfaces";
import { guardedCommitAndSave } from "./guard";

const commitAndSave = (commands: VyosCommand[], what: string) =>
  guardedCommitAndSave(commands, what);

// ── model ─────────────────────────────────────────────────────────────────────

export type IsisLevel = "level-1" | "level-1-2" | "level-2";
export type IsisCircuitType = "level-1" | "level-1-2" | "level-2-only";
export type IsisMetricStyle = "narrow" | "transition" | "wide";
export type IsisRedistLevel = "level-1" | "level-2";

/// Protocols IS-IS can redistribute, per address family. Each (afi, protocol,
/// level) triple is a presence toggle in the config tree.
export const ISIS_REDIST_IPV4 = ["connected", "static", "kernel", "bgp", "ospf", "rip"] as const;
export const ISIS_REDIST_IPV6 = ["connected", "static", "kernel", "bgp", "ospfv3", "ripng"] as const;

export interface IsisRedistribute {
  afi: "ipv4" | "ipv6";
  protocol: string;
  level: IsisRedistLevel;
}

/// A `default-information originate` entry (address family × level).
export interface IsisDefaultOriginate {
  afi: "ipv4" | "ipv6";
  level: IsisRedistLevel;
}

export interface IsisGlobal {
  /** Network Entity Title — the router's IS-IS identity. Required to run. */
  net: string | null;
  level: IsisLevel | null;
  metric_style: IsisMetricStyle | null;
  dynamic_hostname: boolean;
  set_attached_bit: boolean;
  set_overload_bit: boolean;
  lsp_gen_interval: number | null;
  lsp_refresh_interval: number | null;
  spf_interval: number | null;
  redistribute: IsisRedistribute[];
  default_originate: IsisDefaultOriginate[];
}

export interface IsisInterface {
  name: string;
  circuit_type: IsisCircuitType | null;
  hello_interval: number | null;
  hello_multiplier: number | null;
  metric: number | null;
  /** `interface <n> network point-to-point`. */
  point_to_point: boolean;
  passive: boolean;
  bfd: boolean;
  /** `password plaintext-password <text>`. */
  password: string | null;
}

export interface IsisConfig {
  global: IsisGlobal;
  interfaces: IsisInterface[];
}

export function emptyIsisGlobal(): IsisGlobal {
  return {
    net: null,
    level: null,
    metric_style: null,
    dynamic_hostname: false,
    set_attached_bit: false,
    set_overload_bit: false,
    lsp_gen_interval: null,
    lsp_refresh_interval: null,
    spf_interval: null,
    redistribute: [],
    default_originate: [],
  };
}

export function emptyIsisInterface(): IsisInterface {
  return {
    name: "",
    circuit_type: null,
    hello_interval: null,
    hello_multiplier: null,
    metric: null,
    point_to_point: false,
    passive: false,
    bfd: false,
    password: null,
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

/// Parse `redistribute { ipv4 { <proto> { level-1 {} level-2 {} } } ipv6 {…} }`
/// into a flat list of (afi, protocol, level) triples.
function parseRedistribute(redist: Cfg | null): IsisRedistribute[] {
  const out: IsisRedistribute[] = [];
  if (!redist) return out;
  for (const afi of ["ipv4", "ipv6"] as const) {
    const afNode = childCfg(redist, afi);
    if (!afNode) continue;
    for (const [protocol, pRaw] of Object.entries(afNode)) {
      const levels = (pRaw ?? {}) as Cfg;
      for (const level of ["level-1", "level-2"] as const) {
        if (level in levels) out.push({ afi, protocol, level });
      }
    }
  }
  return out;
}

/// Parse `default-information originate { ipv4 { level-1 {} } ipv6 {…} }`.
function parseDefaultOriginate(di: Cfg | null): IsisDefaultOriginate[] {
  const out: IsisDefaultOriginate[] = [];
  const originate = di ? childCfg(di, "originate") : null;
  if (!originate) return out;
  for (const afi of ["ipv4", "ipv6"] as const) {
    const afNode = childCfg(originate, afi);
    if (!afNode) continue;
    for (const level of ["level-1", "level-2"] as const) {
      if (level in afNode) out.push({ afi, level });
    }
  }
  return out;
}

function parseGlobal(isis: Cfg): IsisGlobal {
  return {
    net: childStr(isis, "net"),
    level: childStr(isis, "level") as IsisLevel | null,
    metric_style: childStr(isis, "metric-style") as IsisMetricStyle | null,
    dynamic_hostname: "dynamic-hostname" in isis,
    set_attached_bit: "set-attached-bit" in isis,
    set_overload_bit: "set-overload-bit" in isis,
    lsp_gen_interval: childNum(isis, "lsp-gen-interval"),
    lsp_refresh_interval: childNum(isis, "lsp-refresh-interval"),
    spf_interval: childNum(isis, "spf-interval"),
    redistribute: parseRedistribute(childCfg(isis, "redistribute")),
    default_originate: parseDefaultOriginate(childCfg(isis, "default-information")),
  };
}

function parseInterface(name: string, raw: Cfg): IsisInterface {
  const network = childCfg(raw, "network");
  const password = childCfg(raw, "password");
  return {
    name,
    circuit_type: childStr(raw, "circuit-type") as IsisCircuitType | null,
    hello_interval: childNum(raw, "hello-interval"),
    hello_multiplier: childNum(raw, "hello-multiplier"),
    metric: childNum(raw, "metric"),
    point_to_point: network ? "point-to-point" in network : false,
    passive: "passive" in raw,
    bfd: "bfd" in raw,
    password: password ? childStr(password, "plaintext-password") : null,
  };
}

/// The whole IS-IS config, structured. Absent (`{}`) when nothing is configured.
export async function fetchIsis(): Promise<IsisConfig> {
  const resp = await vyosApi<VyosResponse<Cfg | null>>("retrieve", {
    op: "showConfig",
    path: ["protocols", "isis"],
  });

  let isis: Cfg = {};
  if (resp.success) isis = resp.data ?? {};
  else if (!(resp.error ?? "").toLowerCase().includes("empty")) {
    throw new Error(resp.error || "Device returned an error reading IS-IS configuration.");
  }

  const interfaces = Object.entries(childCfg(isis, "interface") ?? {})
    .map(([n, raw]) => parseInterface(n, (raw ?? {}) as Cfg))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { global: parseGlobal(isis), interfaces };
}

// ── diff helpers ──────────────────────────────────────────────────────────────

const BASE = ["protocols", "isis"];
const trimmed = (s: string | null) => {
  const t = s?.trim() ?? "";
  return t === "" ? null : t;
};

function leaf(out: VyosCommand[], path: string[], live: string | null, desired: string | null) {
  const d = trimmed(desired);
  if (d === (live ?? null)) return;
  if (d !== null) out.push({ op: "set", path: [...path, d] });
  else out.push({ op: "delete", path });
}

function flag(out: VyosCommand[], path: string[], live: boolean, desired: boolean) {
  if (desired === live) return;
  out.push({ op: desired ? "set" : "delete", path });
}

const numStr = (n: number | null) => (n == null ? null : String(n));

const redistKey = (r: IsisRedistribute) => `${r.afi}/${r.protocol}/${r.level}`;
const originateKey = (d: IsisDefaultOriginate) => `${d.afi}/${d.level}`;

// ── global ──────────────────────────────────────────────────────────────────────

export function diffIsisGlobal(live: IsisGlobal, u: IsisGlobal): VyosCommand[] {
  const out: VyosCommand[] = [];
  const p = (...s: string[]) => [...BASE, ...s];

  leaf(out, p("net"), live.net, u.net);
  leaf(out, p("level"), live.level, u.level);
  leaf(out, p("metric-style"), live.metric_style, u.metric_style);
  flag(out, p("dynamic-hostname"), live.dynamic_hostname, u.dynamic_hostname);
  flag(out, p("set-attached-bit"), live.set_attached_bit, u.set_attached_bit);
  flag(out, p("set-overload-bit"), live.set_overload_bit, u.set_overload_bit);
  leaf(out, p("lsp-gen-interval"), numStr(live.lsp_gen_interval), numStr(u.lsp_gen_interval));
  leaf(out, p("lsp-refresh-interval"), numStr(live.lsp_refresh_interval), numStr(u.lsp_refresh_interval));
  leaf(out, p("spf-interval"), numStr(live.spf_interval), numStr(u.spf_interval));

  // redistribute triples: add/remove by presence of the (afi, proto, level) node.
  const liveR = new Set(live.redistribute.map(redistKey));
  const wantR = new Set(u.redistribute.map(redistKey));
  for (const r of u.redistribute)
    if (!liveR.has(redistKey(r))) out.push({ op: "set", path: p("redistribute", r.afi, r.protocol, r.level) });
  for (const r of live.redistribute)
    if (!wantR.has(redistKey(r))) out.push({ op: "delete", path: p("redistribute", r.afi, r.protocol, r.level) });

  // default-information originate entries.
  const liveD = new Set(live.default_originate.map(originateKey));
  const wantD = new Set(u.default_originate.map(originateKey));
  for (const d of u.default_originate)
    if (!liveD.has(originateKey(d))) out.push({ op: "set", path: p("default-information", "originate", d.afi, d.level) });
  for (const d of live.default_originate)
    if (!wantD.has(originateKey(d))) out.push({ op: "delete", path: p("default-information", "originate", d.afi, d.level) });

  return out;
}

export function applyIsisGlobal(live: IsisGlobal, update: IsisGlobal): Promise<number> {
  return commitAndSave(diffIsisGlobal(live, update), "IS-IS global settings change");
}

// ── interface ───────────────────────────────────────────────────────────────────

export function diffIsisInterface(live: IsisInterface | null, u: IsisInterface): VyosCommand[] {
  const out: VyosCommand[] = [];
  const base = [...BASE, "interface", u.name];
  const p = (...s: string[]) => [...base, ...s];

  leaf(out, p("circuit-type"), live?.circuit_type ?? null, u.circuit_type);
  leaf(out, p("hello-interval"), numStr(live?.hello_interval ?? null), numStr(u.hello_interval));
  leaf(out, p("hello-multiplier"), numStr(live?.hello_multiplier ?? null), numStr(u.hello_multiplier));
  leaf(out, p("metric"), numStr(live?.metric ?? null), numStr(u.metric));
  flag(out, p("network", "point-to-point"), live?.point_to_point ?? false, u.point_to_point);
  flag(out, p("passive"), live?.passive ?? false, u.passive);
  flag(out, p("bfd"), live?.bfd ?? false, u.bfd);
  leaf(out, p("password", "plaintext-password"), live?.password ?? null, u.password);

  if (live === null && !out.some((c) => c.op === "set")) {
    return [{ op: "set", path: base }];
  }
  return out;
}

export function applyIsisInterface(live: IsisInterface | null, update: IsisInterface): Promise<number> {
  return commitAndSave(diffIsisInterface(live, update), `IS-IS interface ${update.name} change`);
}

export function deleteIsisInterface(name: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: [...BASE, "interface", name] }], `Delete IS-IS interface ${name}`);
}
