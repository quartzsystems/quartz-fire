// L2TP remote-access data layer (`vpn l2tp remote-access`).
//
// L2TP/IPsec is a single global config node: server-wide settings (outside
// address, pools, DNS, IPsec pre-shared secret) plus three lists — local
// users, client IP pools, and RADIUS servers. `fetchL2tp` reads the whole
// subtree; the general panel diffs the server-wide leaves while each list
// editor diffs one entry at a time.
//
// L2TP is a service (it doesn't ride the management path the way an interface
// or a route does), so writes take the DIRECT commit path like DHCP/DNS — live
// on commit, boot-config save scheduled in the background.

import { vyosApi } from "./api";
import { commitAndSave } from "./interfaces";
import type { VyosCommand, VyosResponse } from "./interfaces";

// ── model ─────────────────────────────────────────────────────────────────────

export const L2TP_AUTH_PROTOCOLS = ["pap", "chap", "mschap", "mschap-v2"] as const;
export type L2tpAuthProtocol = (typeof L2TP_AUTH_PROTOCOLS)[number];

export type L2tpAuthMode = "local" | "radius";
export type IpsecAuthMode = "pre-shared-secret" | "x509";

export interface L2tpUser {
  username: string;
  password: string | null;
  static_ip: string | null;
  disabled: boolean;
}

export interface L2tpPool {
  name: string;
  range: string | null;
}

export interface L2tpRadiusServer {
  address: string;
  key: string | null;
  port: number | null;
  disabled: boolean;
}

export interface L2tpGeneral {
  outside_address: string | null;
  gateway_address: string | null;
  name_servers: string[];
  mtu: number | null;
  auth_mode: L2tpAuthMode | null;
  auth_protocols: L2tpAuthProtocol[];
  default_pool: string | null;
  ipsec_auth_mode: IpsecAuthMode | null;
  ipsec_pre_shared_secret: string | null;
}

export interface L2tpConfig {
  general: L2tpGeneral;
  users: L2tpUser[];
  pools: L2tpPool[];
  radius_servers: L2tpRadiusServer[];
}

export function emptyL2tpGeneral(): L2tpGeneral {
  return {
    outside_address: null,
    gateway_address: null,
    name_servers: [],
    mtu: null,
    auth_mode: null,
    auth_protocols: [],
    default_pool: null,
    ipsec_auth_mode: null,
    ipsec_pre_shared_secret: null,
  };
}
export function emptyL2tpUser(): L2tpUser {
  return { username: "", password: null, static_ip: null, disabled: false };
}
export function emptyL2tpPool(): L2tpPool {
  return { name: "", range: null };
}
export function emptyL2tpRadius(): L2tpRadiusServer {
  return { address: "", key: null, port: null, disabled: false };
}

// ── parse ─────────────────────────────────────────────────────────────────────

type Cfg = Record<string, unknown>;

function childStr(v: Cfg, key: string): string | null {
  const x = v[key];
  if (typeof x !== "string") return null;
  const s = x.trim();
  return s === "" ? null : s;
}
function childNum(v: Cfg, key: string): number | null {
  const s = childStr(v, key);
  const n = s === null ? NaN : Number(s);
  return Number.isInteger(n) ? n : null;
}
function childCfg(v: Cfg, key: string): Cfg | null {
  const x = v[key];
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Cfg) : null;
}
function asMulti(v: Cfg, key: string): string[] {
  const a = v[key];
  if (typeof a === "string") return [a];
  if (Array.isArray(a)) return a.filter((x): x is string => typeof x === "string");
  return [];
}

function parseGeneral(ra: Cfg): L2tpGeneral {
  const auth = childCfg(ra, "authentication") ?? {};
  const ipsec = childCfg(ra, "ipsec-settings") ?? {};
  const ipsecAuth = childCfg(ipsec, "authentication") ?? {};
  return {
    outside_address: childStr(ra, "outside-address"),
    gateway_address: childStr(ra, "gateway-address"),
    name_servers: asMulti(ra, "name-server").sort(),
    mtu: childNum(ra, "mtu"),
    auth_mode: childStr(auth, "mode") as L2tpAuthMode | null,
    auth_protocols: asMulti(auth, "protocols").filter((p): p is L2tpAuthProtocol =>
      (L2TP_AUTH_PROTOCOLS as readonly string[]).includes(p),
    ),
    default_pool: childStr(ra, "default-pool"),
    ipsec_auth_mode: childStr(ipsecAuth, "mode") as IpsecAuthMode | null,
    ipsec_pre_shared_secret: childStr(ipsecAuth, "pre-shared-secret"),
  };
}

function parseUsers(ra: Cfg): L2tpUser[] {
  const auth = childCfg(ra, "authentication") ?? {};
  const local = childCfg(auth, "local-users") ?? {};
  const usernames = childCfg(local, "username") ?? {};
  return Object.entries(usernames)
    .map(([username, raw]) => {
      const u = (raw ?? {}) as Cfg;
      return {
        username,
        password: childStr(u, "password"),
        static_ip: childStr(u, "static-ip"),
        disabled: "disable" in u,
      };
    })
    .sort((a, b) => a.username.localeCompare(b.username));
}

function parsePools(ra: Cfg): L2tpPool[] {
  const pools = childCfg(ra, "client-ip-pool") ?? {};
  return Object.entries(pools)
    .map(([name, raw]) => ({ name, range: childStr((raw ?? {}) as Cfg, "range") }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function parseRadius(ra: Cfg): L2tpRadiusServer[] {
  const auth = childCfg(ra, "authentication") ?? {};
  const radius = childCfg(auth, "radius") ?? {};
  const servers = childCfg(radius, "server") ?? {};
  return Object.entries(servers)
    .map(([address, raw]) => {
      const s = (raw ?? {}) as Cfg;
      return {
        address,
        key: childStr(s, "key"),
        port: childNum(s, "port"),
        disabled: "disable" in s,
      };
    })
    .sort((a, b) => a.address.localeCompare(b.address));
}

/// The whole L2TP remote-access config, structured. Absent (`{}`) when nothing
/// is configured.
export async function fetchL2tp(): Promise<L2tpConfig> {
  const resp = await vyosApi<VyosResponse<Cfg | null>>("retrieve", {
    op: "showConfig",
    path: ["vpn", "l2tp", "remote-access"],
  });

  let ra: Cfg = {};
  if (resp.success) ra = resp.data ?? {};
  else if (!(resp.error ?? "").toLowerCase().includes("empty")) {
    throw new Error(resp.error || "Device returned an error reading L2TP configuration.");
  }

  return {
    general: parseGeneral(ra),
    users: parseUsers(ra),
    pools: parsePools(ra),
    radius_servers: parseRadius(ra),
  };
}

// ── diff helpers ──────────────────────────────────────────────────────────────

const BASE = ["vpn", "l2tp", "remote-access"];
const trimmed = (s: string | null) => {
  const t = s?.trim() ?? "";
  return t === "" ? null : t;
};
const numStr = (n: number | null) => (n == null ? null : String(n));

function leaf(out: VyosCommand[], path: string[], live: string | null, desired: string | null) {
  const d = trimmed(desired);
  if (d === (live ?? null)) return;
  if (d !== null) out.push({ op: "set", path: [...path, d] });
  else out.push({ op: "delete", path });
}
function multi(out: VyosCommand[], path: string[], live: string[], desired: string[]) {
  const want = desired.map((s) => s.trim()).filter(Boolean);
  for (const v of want) if (!live.includes(v)) out.push({ op: "set", path: [...path, v] });
  for (const v of live) if (!want.includes(v)) out.push({ op: "delete", path: [...path, v] });
}

// ── general ─────────────────────────────────────────────────────────────────────

export function diffL2tpGeneral(live: L2tpGeneral, u: L2tpGeneral): VyosCommand[] {
  const out: VyosCommand[] = [];
  const p = (...s: string[]) => [...BASE, ...s];

  leaf(out, p("outside-address"), live.outside_address, u.outside_address);
  leaf(out, p("gateway-address"), live.gateway_address, u.gateway_address);
  multi(out, p("name-server"), live.name_servers, u.name_servers);
  leaf(out, p("mtu"), numStr(live.mtu), numStr(u.mtu));
  leaf(out, p("authentication", "mode"), live.auth_mode, u.auth_mode);
  multi(out, p("authentication", "protocols"), live.auth_protocols, u.auth_protocols);
  leaf(out, p("default-pool"), live.default_pool, u.default_pool);
  leaf(out, p("ipsec-settings", "authentication", "mode"), live.ipsec_auth_mode, u.ipsec_auth_mode);
  leaf(out, p("ipsec-settings", "authentication", "pre-shared-secret"), live.ipsec_pre_shared_secret, u.ipsec_pre_shared_secret);

  return out;
}

export function applyL2tpGeneral(live: L2tpGeneral, update: L2tpGeneral): Promise<number> {
  return commitAndSave(diffL2tpGeneral(live, update));
}

// ── local users ───────────────────────────────────────────────────────────────

const userBase = (name: string) => [...BASE, "authentication", "local-users", "username", name];

export function diffL2tpUser(live: L2tpUser | null, u: L2tpUser): VyosCommand[] {
  const out: VyosCommand[] = [];
  const base = userBase(u.username);
  leaf(out, [...base, "password"], live?.password ?? null, u.password);
  leaf(out, [...base, "static-ip"], live?.static_ip ?? null, u.static_ip);
  if (u.disabled !== (live?.disabled ?? false)) out.push({ op: u.disabled ? "set" : "delete", path: [...base, "disable"] });
  if (live === null && !out.some((c) => c.op === "set")) out.push({ op: "set", path: base });
  return out;
}
export function applyL2tpUser(live: L2tpUser | null, update: L2tpUser): Promise<number> {
  return commitAndSave(diffL2tpUser(live, update));
}
export function deleteL2tpUser(username: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: userBase(username) }]);
}

// ── client IP pools ──────────────────────────────────────────────────────────────

const poolBase = (name: string) => [...BASE, "client-ip-pool", name];

export function diffL2tpPool(live: L2tpPool | null, u: L2tpPool): VyosCommand[] {
  const out: VyosCommand[] = [];
  const base = poolBase(u.name);
  leaf(out, [...base, "range"], live?.range ?? null, u.range);
  if (live === null && !out.some((c) => c.op === "set")) out.push({ op: "set", path: base });
  return out;
}
export function applyL2tpPool(live: L2tpPool | null, update: L2tpPool): Promise<number> {
  return commitAndSave(diffL2tpPool(live, update));
}
export function deleteL2tpPool(name: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: poolBase(name) }]);
}

// ── RADIUS servers ────────────────────────────────────────────────────────────────

const radiusBase = (address: string) => [...BASE, "authentication", "radius", "server", address];

export function diffL2tpRadius(live: L2tpRadiusServer | null, u: L2tpRadiusServer): VyosCommand[] {
  const out: VyosCommand[] = [];
  const base = radiusBase(u.address);
  leaf(out, [...base, "key"], live?.key ?? null, u.key);
  leaf(out, [...base, "port"], numStr(live?.port ?? null), numStr(u.port));
  if (u.disabled !== (live?.disabled ?? false)) out.push({ op: u.disabled ? "set" : "delete", path: [...base, "disable"] });
  if (live === null && !out.some((c) => c.op === "set")) out.push({ op: "set", path: base });
  return out;
}
export function applyL2tpRadius(live: L2tpRadiusServer | null, update: L2tpRadiusServer): Promise<number> {
  return commitAndSave(diffL2tpRadius(live, update));
}
export function deleteL2tpRadius(address: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: radiusBase(address) }]);
}
