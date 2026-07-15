// Virtual-server data layer (`high-availability virtual-server`) — VyOS's
// LVS/IPVS L4 load balancer.
//
// A virtual server is identified by its tag: normally the virtual IP, or an
// arbitrary name when it matches on a firewall fwmark instead. Each server
// balances across a set of real servers with a chosen scheduling algorithm and
// forwarding method.
//
// Changes here can move the service VIP, so applies go through
// `guardedCommitAndSave`.

import { vyosApi } from "./api";
import { VyosCommand, VyosResponse } from "./interfaces";
import { guardedCommitAndSave } from "./guard";

const commitAndSave = (commands: VyosCommand[], what: string) =>
  guardedCommitAndSave(commands, what);

// ── model ─────────────────────────────────────────────────────────────────────

export type Algorithm =
  | "round-robin"
  | "weighted-round-robin"
  | "least-connection"
  | "weighted-least-connection"
  | "source-hashing"
  | "destination-hashing"
  | "locality-based-least-connection";

export const ALGORITHMS: Algorithm[] = [
  "round-robin",
  "weighted-round-robin",
  "least-connection",
  "weighted-least-connection",
  "source-hashing",
  "destination-hashing",
  "locality-based-least-connection",
];

export type ForwardMethod = "nat" | "direct" | "tunnel";
export const FORWARD_METHODS: ForwardMethod[] = ["nat", "direct", "tunnel"];

export type Protocol = "tcp" | "udp";

export interface RealServer {
  address: string;
  port: number | null;
  weight: number | null;
  connection_timeout: number | null;
  health_check_script: string | null;
}

export interface VirtualServer {
  /** Tag: the virtual IP, or a name when `fwmark` is used. */
  id: string;
  port: number | null;
  protocol: Protocol | null;
  fwmark: number | null;
  algorithm: Algorithm | null;
  forward_method: ForwardMethod | null;
  delay_loop: number | null;
  persistence_timeout: number | null;
  real_servers: RealServer[];
}

export function emptyRealServer(): RealServer {
  return { address: "", port: null, weight: null, connection_timeout: null, health_check_script: null };
}

export function emptyVirtualServer(): VirtualServer {
  return {
    id: "",
    port: null,
    protocol: null,
    fwmark: null,
    algorithm: null,
    forward_method: null,
    delay_loop: null,
    persistence_timeout: null,
    real_servers: [],
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
  return Number.isFinite(n) ? n : null;
}

function parseRealServer(address: string, raw: Cfg): RealServer {
  return {
    address,
    port: childNum(raw, "port"),
    weight: childNum(raw, "weight"),
    connection_timeout: childNum(raw, "connection-timeout"),
    health_check_script: childStr(childCfg(raw, "health-check") ?? {}, "script"),
  };
}

function parseVirtualServer(id: string, raw: Cfg): VirtualServer {
  const rs = childCfg(raw, "real-server") ?? {};
  return {
    id,
    port: childNum(raw, "port"),
    protocol: (childStr(raw, "protocol") as Protocol | null) ?? null,
    fwmark: childNum(raw, "fwmark"),
    algorithm: (childStr(raw, "algorithm") as Algorithm | null) ?? null,
    forward_method: (childStr(raw, "forward-method") as ForwardMethod | null) ?? null,
    delay_loop: childNum(raw, "delay-loop"),
    persistence_timeout: childNum(raw, "persistence-timeout"),
    real_servers: Object.entries(rs)
      .map(([addr, v]) => parseRealServer(addr, (v ?? {}) as Cfg))
      .sort((a, b) => a.address.localeCompare(b.address)),
  };
}

/// Every configured virtual server. Absent (`{}`) when none is configured.
export async function fetchVirtualServers(): Promise<VirtualServer[]> {
  const resp = await vyosApi<VyosResponse<Cfg | null>>("retrieve", {
    op: "showConfig",
    path: ["high-availability", "virtual-server"],
  });

  let node: Cfg = {};
  if (resp.success) node = resp.data ?? {};
  else if (!(resp.error ?? "").toLowerCase().includes("empty")) {
    throw new Error(resp.error || "Device returned an error reading virtual servers.");
  }

  return Object.entries(node)
    .map(([id, raw]) => parseVirtualServer(id, (raw ?? {}) as Cfg))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ── diff ──────────────────────────────────────────────────────────────────────

const BASE = ["high-availability", "virtual-server"];
const trimmed = (s: string | null) => {
  const t = s?.trim() ?? "";
  return t === "" ? null : t;
};
const numStr = (n: number | null) => (n != null ? String(n) : null);

function leaf(out: VyosCommand[], path: string[], live: string | null, desired: string | null) {
  const d = trimmed(desired);
  if (d === (live ?? null)) return;
  if (d !== null) out.push({ op: "set", path: [...path, d] });
  else out.push({ op: "delete", path });
}

function diffRealServer(out: VyosCommand[], base: string[], live: RealServer | null, u: RealServer) {
  const p = (...s: string[]) => [...base, "real-server", u.address, ...s];
  if (!live) out.push({ op: "set", path: [...base, "real-server", u.address] });
  leaf(out, p("port"), numStr(live?.port ?? null), numStr(u.port));
  leaf(out, p("weight"), numStr(live?.weight ?? null), numStr(u.weight));
  leaf(out, p("connection-timeout"), numStr(live?.connection_timeout ?? null), numStr(u.connection_timeout));
  leaf(out, p("health-check", "script"), live?.health_check_script ?? null, u.health_check_script);
}

export function diffVirtualServer(live: VirtualServer | null, u: VirtualServer): VyosCommand[] {
  const base = [...BASE, u.id];
  const out: VyosCommand[] = [];
  const p = (...s: string[]) => [...base, ...s];
  const l = live ?? emptyVirtualServer();

  leaf(out, p("port"), numStr(l.port), numStr(u.port));
  leaf(out, p("protocol"), l.protocol, u.protocol);
  leaf(out, p("fwmark"), numStr(l.fwmark), numStr(u.fwmark));
  leaf(out, p("algorithm"), l.algorithm, u.algorithm);
  leaf(out, p("forward-method"), l.forward_method, u.forward_method);
  leaf(out, p("delay-loop"), numStr(l.delay_loop), numStr(u.delay_loop));
  leaf(out, p("persistence-timeout"), numStr(l.persistence_timeout), numStr(u.persistence_timeout));

  // Real servers (tag node keyed by address).
  const liveByAddr = new Map(l.real_servers.map((r) => [r.address, r]));
  const want = u.real_servers.filter((r) => r.address.trim() !== "");
  const wantAddrs = new Set(want.map((r) => r.address.trim()));
  for (const r of want) {
    diffRealServer(out, base, liveByAddr.get(r.address.trim()) ?? null, { ...r, address: r.address.trim() });
  }
  for (const r of l.real_servers) {
    if (!wantAddrs.has(r.address)) out.push({ op: "delete", path: [...base, "real-server", r.address] });
  }

  if (live === null && !out.some((c) => c.op === "set")) {
    return [{ op: "set", path: base }];
  }
  return out;
}

export function applyVirtualServer(live: VirtualServer | null, update: VirtualServer): Promise<number> {
  return commitAndSave(diffVirtualServer(live, update), `Virtual server ${update.id} change`);
}

export function deleteVirtualServer(id: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: [...BASE, id] }], `Delete virtual server ${id}`);
}
