// OSPFv2 data layer (`protocols ospf`).
//
// Like BGP, OSPF is a single global config node. `fetchOspf` reads the whole
// `protocols ospf` subtree into a structured object; the apply functions diff
// one slice at a time (global settings, one area, one interface) into a minimal
// command list.
//
// A bad OSPF change can black-hole the fabric, so every apply goes through
// `guardedCommitAndSave` — live immediately, auto-reverted unless confirmed in
// the shell banner (see lib/guard).

import { vyosApi } from "./api";
import { VyosCommand, VyosResponse } from "./interfaces";
import { guardedCommitAndSave } from "./guard";

const commitAndSave = (commands: VyosCommand[], what: string) =>
  guardedCommitAndSave(commands, what);

// ── model ─────────────────────────────────────────────────────────────────────

/// Protocols OSPF can redistribute into. Each is a presence toggle in the GUI.
export const OSPF_REDISTRIBUTE = ["connected", "static", "kernel", "bgp", "rip"] as const;
export type OspfRedistribute = (typeof OSPF_REDISTRIBUTE)[number];

/// Interface OSPF network types (`interface <n> network <type>`).
export const OSPF_NETWORK_TYPES = ["broadcast", "non-broadcast", "point-to-multipoint", "point-to-point"] as const;
export type OspfNetworkType = (typeof OSPF_NETWORK_TYPES)[number];

export type OspfAreaType = "normal" | "stub" | "nssa";

export interface OspfGlobal {
  router_id: string | null;
  /** `default-information originate` — inject a default route. */
  default_information: boolean;
  /** `… originate always` — originate even without a default in the RIB. */
  default_information_always: boolean;
  default_information_metric: number | null;
  /** `… metric-type` — 1 or 2 (default 2). */
  default_information_metric_type: "1" | "2" | null;
  default_metric: number | null;
  /** `auto-cost reference-bandwidth <Mbit/s>`. */
  reference_bandwidth: number | null;
  /** `distance global <1-255>`. */
  distance: number | null;
  /** `maximum-paths <1-64>` — ECMP width. */
  maximum_paths: number | null;
  log_adjacency_changes: boolean;
  log_adjacency_changes_detail: boolean;
  /** `passive-interface default` — every interface passive unless overridden. */
  passive_default: boolean;
  redistribute: OspfRedistribute[];
}

export interface OspfArea {
  /** Area id — a number or a dotted-quad (`0` / `0.0.0.0`). */
  area: string;
  area_type: OspfAreaType;
  /** `no-summary` on a stub/NSSA area (totally-stubby). */
  no_summary: boolean;
  networks: string[];
  ranges: string[];
}

export interface OspfInterface {
  name: string;
  /** Area this interface belongs to (`interface <n> area <x>`). */
  area: string | null;
  cost: number | null;
  priority: number | null;
  hello_interval: number | null;
  dead_interval: number | null;
  network_type: OspfNetworkType | null;
  passive: boolean;
  bfd: boolean;
  mtu_ignore: boolean;
  /** `authentication plaintext-password <text>` (simple auth). */
  auth_password: string | null;
}

export interface OspfConfig {
  global: OspfGlobal;
  areas: OspfArea[];
  interfaces: OspfInterface[];
}

export function emptyOspfGlobal(): OspfGlobal {
  return {
    router_id: null,
    default_information: false,
    default_information_always: false,
    default_information_metric: null,
    default_information_metric_type: null,
    default_metric: null,
    reference_bandwidth: null,
    distance: null,
    maximum_paths: null,
    log_adjacency_changes: false,
    log_adjacency_changes_detail: false,
    passive_default: false,
    redistribute: [],
  };
}

export function emptyOspfArea(): OspfArea {
  return { area: "", area_type: "normal", no_summary: false, networks: [], ranges: [] };
}

export function emptyOspfInterface(): OspfInterface {
  return {
    name: "",
    area: null,
    cost: null,
    priority: null,
    hello_interval: null,
    dead_interval: null,
    network_type: null,
    passive: false,
    bfd: false,
    mtu_ignore: false,
    auth_password: null,
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

/// Multi-value leaf → sorted key list (VyOS renders `network`/`range`/
/// `redistribute` as child maps keyed by value).
function keysOf(v: Cfg | null): string[] {
  return v ? Object.keys(v).sort() : [];
}

function parseGlobal(ospf: Cfg): OspfGlobal {
  const params = childCfg(ospf, "parameters") ?? {};
  const di = childCfg(ospf, "default-information");
  const originate = di ? childCfg(di, "originate") : null;
  const autoCost = childCfg(ospf, "auto-cost") ?? {};
  const distance = childCfg(ospf, "distance") ?? {};
  const lac = childCfg(ospf, "log-adjacency-changes");
  const redistribute = childCfg(ospf, "redistribute") ?? {};

  return {
    router_id: childStr(params, "router-id"),
    default_information: originate !== null,
    default_information_always: originate ? "always" in originate : false,
    default_information_metric: originate ? childNum(originate, "metric") : null,
    default_information_metric_type: originate
      ? (childStr(originate, "metric-type") as "1" | "2" | null)
      : null,
    default_metric: childNum(ospf, "default-metric"),
    reference_bandwidth: childNum(autoCost, "reference-bandwidth"),
    distance: childNum(distance, "global"),
    maximum_paths: childNum(ospf, "maximum-paths"),
    log_adjacency_changes: "log-adjacency-changes" in ospf,
    log_adjacency_changes_detail: lac ? "detail" in lac : false,
    passive_default: "default" in (childCfg(ospf, "passive-interface") ?? {}),
    redistribute: keysOf(redistribute).filter((k): k is OspfRedistribute =>
      (OSPF_REDISTRIBUTE as readonly string[]).includes(k),
    ),
  };
}

function parseArea(area: string, raw: Cfg): OspfArea {
  const at = childCfg(raw, "area-type");
  let area_type: OspfAreaType = "normal";
  let no_summary = false;
  if (at) {
    if ("nssa" in at) {
      area_type = "nssa";
      no_summary = "no-summary" in (childCfg(at, "nssa") ?? {});
    } else if ("stub" in at) {
      area_type = "stub";
      no_summary = "no-summary" in (childCfg(at, "stub") ?? {});
    }
  }
  return {
    area,
    area_type,
    no_summary,
    networks: keysOf(childCfg(raw, "network")),
    ranges: keysOf(childCfg(raw, "range")),
  };
}

function parseInterface(name: string, raw: Cfg): OspfInterface {
  const passive = childCfg(raw, "passive");
  const auth = childCfg(raw, "authentication");
  return {
    name,
    area: childStr(raw, "area"),
    cost: childNum(raw, "cost"),
    priority: childNum(raw, "priority"),
    hello_interval: childNum(raw, "hello-interval"),
    dead_interval: childNum(raw, "dead-interval"),
    network_type: childStr(raw, "network") as OspfNetworkType | null,
    // `passive` is a valueless node; `passive disable` explicitly un-passives it.
    passive: "passive" in raw && !(passive ? "disable" in passive : false),
    bfd: "bfd" in raw,
    mtu_ignore: "mtu-ignore" in raw,
    auth_password: auth ? childStr(auth, "plaintext-password") : null,
  };
}

/// The whole OSPF config, structured. Absent (`{}`) when nothing is configured.
export async function fetchOspf(): Promise<OspfConfig> {
  const resp = await vyosApi<VyosResponse<Cfg | null>>("retrieve", {
    op: "showConfig",
    path: ["protocols", "ospf"],
  });

  let ospf: Cfg = {};
  if (resp.success) ospf = resp.data ?? {};
  else if (!(resp.error ?? "").toLowerCase().includes("empty")) {
    throw new Error(resp.error || "Device returned an error reading OSPF configuration.");
  }

  const areas = Object.entries(childCfg(ospf, "area") ?? {})
    .map(([a, raw]) => parseArea(a, (raw ?? {}) as Cfg))
    .sort((a, b) => a.area.localeCompare(b.area, undefined, { numeric: true }));
  const interfaces = Object.entries(childCfg(ospf, "interface") ?? {})
    .map(([n, raw]) => parseInterface(n, (raw ?? {}) as Cfg))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { global: parseGlobal(ospf), areas, interfaces };
}

// ── diff helpers ──────────────────────────────────────────────────────────────

const BASE = ["protocols", "ospf"];
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

/// Multi-value leaf (e.g. `network`, `range`, `redistribute`): add/remove children.
function multi(out: VyosCommand[], path: string[], live: string[], desired: string[]) {
  const want = desired.map((s) => s.trim()).filter(Boolean);
  for (const v of want) if (!live.includes(v)) out.push({ op: "set", path: [...path, v] });
  for (const v of live) if (!want.includes(v)) out.push({ op: "delete", path: [...path, v] });
}

const numStr = (n: number | null) => (n == null ? null : String(n));

// ── global ──────────────────────────────────────────────────────────────────────

export function diffOspfGlobal(live: OspfGlobal, u: OspfGlobal): VyosCommand[] {
  const out: VyosCommand[] = [];
  const p = (...s: string[]) => [...BASE, ...s];

  leaf(out, p("parameters", "router-id"), live.router_id, u.router_id);
  leaf(out, p("default-metric"), numStr(live.default_metric), numStr(u.default_metric));
  leaf(out, p("auto-cost", "reference-bandwidth"), numStr(live.reference_bandwidth), numStr(u.reference_bandwidth));
  leaf(out, p("distance", "global"), numStr(live.distance), numStr(u.distance));
  leaf(out, p("maximum-paths"), numStr(live.maximum_paths), numStr(u.maximum_paths));
  flag(out, p("passive-interface", "default"), live.passive_default, u.passive_default);

  // Log adjacency changes: the node presence is "on"; `detail` is a child.
  flag(out, p("log-adjacency-changes"), live.log_adjacency_changes, u.log_adjacency_changes);
  if (u.log_adjacency_changes) {
    flag(out, p("log-adjacency-changes", "detail"),
      live.log_adjacency_changes && live.log_adjacency_changes_detail, u.log_adjacency_changes_detail);
  }

  // default-information originate + its sub-leaves.
  if (!u.default_information) {
    if (live.default_information) out.push({ op: "delete", path: p("default-information") });
  } else {
    const base = live.default_information ? live : null;
    if (!live.default_information) out.push({ op: "set", path: p("default-information", "originate") });
    flag(out, p("default-information", "originate", "always"),
      base?.default_information_always ?? false, u.default_information_always);
    leaf(out, p("default-information", "originate", "metric"),
      numStr(base?.default_information_metric ?? null), numStr(u.default_information_metric));
    leaf(out, p("default-information", "originate", "metric-type"),
      base?.default_information_metric_type ?? null, u.default_information_metric_type);
  }

  multi(out, p("redistribute"), live.redistribute, u.redistribute);

  return out;
}

export function applyOspfGlobal(live: OspfGlobal, update: OspfGlobal): Promise<number> {
  return commitAndSave(diffOspfGlobal(live, update), "OSPF global settings change");
}

// ── area ──────────────────────────────────────────────────────────────────────

export function diffOspfArea(live: OspfArea | null, u: OspfArea): VyosCommand[] {
  const out: VyosCommand[] = [];
  const base = [...BASE, "area", u.area];
  const p = (...s: string[]) => [...base, ...s];

  // area-type: rebuild the node whenever the type changes so no stale stub/nssa
  // leaf survives a switch.
  const liveType = live?.area_type ?? "normal";
  if (u.area_type !== liveType) {
    if (live && liveType !== "normal") out.push({ op: "delete", path: p("area-type") });
    if (u.area_type !== "normal") out.push({ op: "set", path: p("area-type", u.area_type) });
  }
  if (u.area_type !== "normal") {
    const liveNoSummary = live && live.area_type === u.area_type ? live.no_summary : false;
    flag(out, p("area-type", u.area_type, "no-summary"), liveNoSummary, u.no_summary);
  }

  multi(out, p("network"), live?.networks ?? [], u.networks);
  multi(out, p("range"), live?.ranges ?? [], u.ranges);

  // A brand-new area with only `normal` type and no networks still needs a node.
  if (live === null && !out.some((c) => c.op === "set")) {
    return [{ op: "set", path: base }];
  }
  return out;
}

export function applyOspfArea(live: OspfArea | null, update: OspfArea): Promise<number> {
  return commitAndSave(diffOspfArea(live, update), `OSPF area ${update.area} change`);
}

export function deleteOspfArea(area: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: [...BASE, "area", area] }], `Delete OSPF area ${area}`);
}

// ── interface ───────────────────────────────────────────────────────────────────

export function diffOspfInterface(live: OspfInterface | null, u: OspfInterface): VyosCommand[] {
  const out: VyosCommand[] = [];
  const base = [...BASE, "interface", u.name];
  const p = (...s: string[]) => [...base, ...s];

  leaf(out, p("area"), live?.area ?? null, u.area);
  leaf(out, p("cost"), numStr(live?.cost ?? null), numStr(u.cost));
  leaf(out, p("priority"), numStr(live?.priority ?? null), numStr(u.priority));
  leaf(out, p("hello-interval"), numStr(live?.hello_interval ?? null), numStr(u.hello_interval));
  leaf(out, p("dead-interval"), numStr(live?.dead_interval ?? null), numStr(u.dead_interval));
  leaf(out, p("network"), live?.network_type ?? null, u.network_type);
  flag(out, p("passive"), live?.passive ?? false, u.passive);
  flag(out, p("bfd"), live?.bfd ?? false, u.bfd);
  flag(out, p("mtu-ignore"), live?.mtu_ignore ?? false, u.mtu_ignore);
  leaf(out, p("authentication", "plaintext-password"), live?.auth_password ?? null, u.auth_password);

  if (live === null && !out.some((c) => c.op === "set")) {
    return [{ op: "set", path: base }];
  }
  return out;
}

export function applyOspfInterface(live: OspfInterface | null, update: OspfInterface): Promise<number> {
  return commitAndSave(diffOspfInterface(live, update), `OSPF interface ${update.name} change`);
}

export function deleteOspfInterface(name: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: [...BASE, "interface", name] }], `Delete OSPF interface ${name}`);
}
