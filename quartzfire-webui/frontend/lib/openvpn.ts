// OpenVPN data layer (`interfaces openvpn <vtunN>`).
//
// An OpenVPN interface runs in one of three modes — site-to-site (static key
// or TLS peer), client, or server — and the meaningful leaf set differs per
// mode. `fetchOpenvpn` reads every tunnel; `applyOpenvpn` diffs one tunnel at a
// time, and when the mode changes it first drops the leaves that belonged to
// the old mode so no stale `server`/`authentication`/static-key config lingers.
//
// Writes go through `guardedCommitAndSave` — an OpenVPN interface is still an
// interface and a bad change can sever management, so it's live-then-confirm.
//
// Certificates, DH parameters and static/secret keys are referenced by PKI
// name (configure them under `pki` / `generate pki`); this layer stores the
// names only.

import { vyosApi } from "./api";
import type { VyosCommand, VyosResponse } from "./interfaces";
import { guardedCommitAndSave } from "./guard";

const commitAndSave = (commands: VyosCommand[], what: string) =>
  guardedCommitAndSave(commands, what);

// ── model ─────────────────────────────────────────────────────────────────────

export const OPENVPN_MODES = ["site-to-site", "client", "server"] as const;
export type OpenvpnMode = (typeof OPENVPN_MODES)[number];

export const OPENVPN_DEVICE_TYPES = ["tun", "tap"] as const;
export type OpenvpnDeviceType = (typeof OPENVPN_DEVICE_TYPES)[number];

export const OPENVPN_PROTOCOLS = ["udp", "tcp-passive", "tcp-active"] as const;
export type OpenvpnProtocol = (typeof OPENVPN_PROTOCOLS)[number];

export const OPENVPN_TOPOLOGIES = ["subnet", "net30", "point-to-point"] as const;
export type OpenvpnTopology = (typeof OPENVPN_TOPOLOGIES)[number];

export interface OpenvpnInterface {
  name: string;
  mode: OpenvpnMode;
  description: string | null;
  device_type: OpenvpnDeviceType | null;
  protocol: OpenvpnProtocol | null;
  local_host: string | null;
  local_port: number | null;
  persistent_tunnel: boolean;
  enabled: boolean;

  /** `encryption cipher <alg>` — the (legacy/fallback) data-channel cipher. */
  encryption_cipher: string | null;
  /** `hash <alg>` — HMAC auth digest. */
  hash: string | null;

  // TLS / PKI (references by name).
  tls_ca_certificate: string | null;
  tls_certificate: string | null;
  tls_dh_params: string | null;
  /** `tls role active|passive` — site-to-site TLS role. */
  tls_role: "active" | "passive" | null;

  // site-to-site.
  local_address: string | null;
  remote_address: string | null;
  /** `shared-secret-key <name>` — pre-shared static key (site-to-site). */
  shared_secret_key: string | null;

  // client (also `remote_host` for a TLS site-to-site initiator).
  remote_host: string | null;
  remote_port: number | null;
  auth_username: string | null;
  auth_password: string | null;

  // server.
  server_subnet: string | null;
  server_topology: OpenvpnTopology | null;
  server_push_routes: string[];
  server_name_servers: string[];
  server_max_connections: number | null;

  /** Raw `openvpn-option <text>` passthrough for knobs the UI doesn't model. */
  openvpn_options: string[];
}

export function emptyOpenvpn(): OpenvpnInterface {
  return {
    name: "",
    mode: "site-to-site",
    description: null,
    device_type: null,
    protocol: null,
    local_host: null,
    local_port: null,
    persistent_tunnel: false,
    enabled: true,
    encryption_cipher: null,
    hash: null,
    tls_ca_certificate: null,
    tls_certificate: null,
    tls_dh_params: null,
    tls_role: null,
    local_address: null,
    remote_address: null,
    shared_secret_key: null,
    remote_host: null,
    remote_port: null,
    auth_username: null,
    auth_password: null,
    server_subnet: null,
    server_topology: null,
    server_push_routes: [],
    server_name_servers: [],
    server_max_connections: null,
    openvpn_options: [],
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

function parseInterface(name: string, raw: Cfg): OpenvpnInterface {
  const enc = childCfg(raw, "encryption") ?? {};
  const tls = childCfg(raw, "tls") ?? {};
  const server = childCfg(raw, "server") ?? {};
  const auth = childCfg(raw, "authentication") ?? {};
  const mode = (childStr(raw, "mode") as OpenvpnMode | null) ?? "site-to-site";

  return {
    name,
    mode,
    description: childStr(raw, "description"),
    device_type: childStr(raw, "device-type") as OpenvpnDeviceType | null,
    protocol: childStr(raw, "protocol") as OpenvpnProtocol | null,
    local_host: childStr(raw, "local-host"),
    local_port: childNum(raw, "local-port"),
    persistent_tunnel: "persistent-tunnel" in raw,
    enabled: !("disable" in raw),
    encryption_cipher: childStr(enc, "cipher"),
    hash: childStr(raw, "hash"),
    tls_ca_certificate: childStr(tls, "ca-certificate"),
    tls_certificate: childStr(tls, "certificate"),
    tls_dh_params: childStr(tls, "dh-params"),
    tls_role: childStr(tls, "role") as "active" | "passive" | null,
    local_address: childStr(raw, "local-address"),
    remote_address: childStr(raw, "remote-address"),
    shared_secret_key: childStr(raw, "shared-secret-key"),
    remote_host: childStr(raw, "remote-host"),
    remote_port: childNum(raw, "remote-port"),
    auth_username: childStr(auth, "username"),
    auth_password: childStr(auth, "password"),
    server_subnet: childStr(server, "subnet"),
    server_topology: childStr(server, "topology") as OpenvpnTopology | null,
    server_push_routes: asMulti(server, "push-route").sort(),
    server_name_servers: asMulti(server, "name-server").sort(),
    server_max_connections: childNum(server, "max-connections"),
    openvpn_options: asMulti(raw, "openvpn-option"),
  };
}

/// All configured OpenVPN interfaces, from the running config.
export async function fetchOpenvpn(): Promise<OpenvpnInterface[]> {
  const resp = await vyosApi<VyosResponse<Cfg | null>>("retrieve", {
    op: "showConfig",
    path: ["interfaces", "openvpn"],
  });

  let node: Cfg = {};
  if (resp.success) node = resp.data ?? {};
  else if (!(resp.error ?? "").toLowerCase().includes("empty")) {
    throw new Error(resp.error || "Device returned an error reading OpenVPN configuration.");
  }

  return Object.entries(node)
    .map(([name, raw]) => parseInterface(name, (raw ?? {}) as Cfg))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── diff ────────────────────────────────────────────────────────────────────────

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

function flag(out: VyosCommand[], path: string[], live: boolean, desired: boolean) {
  if (desired === live) return;
  out.push({ op: desired ? "set" : "delete", path });
}

function multi(out: VyosCommand[], path: string[], live: string[], desired: string[]) {
  const want = desired.map((s) => s.trim()).filter(Boolean);
  for (const v of want) if (!live.includes(v)) out.push({ op: "set", path: [...path, v] });
  for (const v of live) if (!want.includes(v)) out.push({ op: "delete", path: [...path, v] });
}

/// Top-level nodes owned by each mode. When the mode changes we drop the old
/// mode's nodes wholesale so no stale subtree (e.g. a full `server` block)
/// survives the switch.
const MODE_NODES: Record<OpenvpnMode, string[]> = {
  "site-to-site": ["local-address", "remote-address", "shared-secret-key"],
  client: ["remote-host", "remote-port", "authentication"],
  server: ["server"],
};

export function diffOpenvpn(live: OpenvpnInterface | null, u: OpenvpnInterface): VyosCommand[] {
  const base = ["interfaces", "openvpn", u.name];
  const out: VyosCommand[] = [];
  const p = (...s: string[]) => [...base, ...s];

  // Mode: on a change, purge the previous mode's nodes before writing the new.
  if (live && live.mode !== u.mode) {
    for (const node of MODE_NODES[live.mode]) out.push({ op: "delete", path: p(node) });
    // `tls role` is only meaningful for site-to-site TLS.
    if (live.mode === "site-to-site" && live.tls_role) out.push({ op: "delete", path: p("tls", "role") });
  }
  leaf(out, p("mode"), live?.mode ?? null, u.mode);

  // Common leaves.
  leaf(out, p("description"), live?.description ?? null, u.description);
  leaf(out, p("device-type"), live?.device_type ?? null, u.device_type);
  leaf(out, p("protocol"), live?.protocol ?? null, u.protocol);
  leaf(out, p("local-host"), live?.local_host ?? null, u.local_host);
  leaf(out, p("local-port"), numStr(live?.local_port ?? null), numStr(u.local_port));
  flag(out, p("persistent-tunnel"), live?.persistent_tunnel ?? false, u.persistent_tunnel);
  if (u.enabled !== (live?.enabled ?? true)) out.push({ op: u.enabled ? "delete" : "set", path: p("disable") });

  leaf(out, p("encryption", "cipher"), live?.encryption_cipher ?? null, u.encryption_cipher);
  leaf(out, p("hash"), live?.hash ?? null, u.hash);

  leaf(out, p("tls", "ca-certificate"), live?.tls_ca_certificate ?? null, u.tls_ca_certificate);
  leaf(out, p("tls", "certificate"), live?.tls_certificate ?? null, u.tls_certificate);
  leaf(out, p("tls", "dh-params"), live?.tls_dh_params ?? null, u.tls_dh_params);

  // Mode-specific — when the field belongs to a different mode the modal passes
  // null/[], so the diff naturally deletes any stale leaf. `live` slices are
  // read as null when the previous mode was purged above.
  const sameMode = live && live.mode === u.mode;
  const l = (k: keyof OpenvpnInterface) => (sameMode ? (live![k] as string | null) ?? null : null);

  if (u.mode === "site-to-site") {
    leaf(out, p("local-address"), l("local_address"), u.local_address);
    leaf(out, p("remote-address"), l("remote_address"), u.remote_address);
    leaf(out, p("remote-host"), l("remote_host"), u.remote_host);
    leaf(out, p("shared-secret-key"), l("shared_secret_key"), u.shared_secret_key);
    leaf(out, p("tls", "role"), sameMode ? live!.tls_role : null, u.tls_role);
  } else if (u.mode === "client") {
    leaf(out, p("remote-host"), l("remote_host"), u.remote_host);
    leaf(out, p("remote-port"), sameMode ? numStr(live!.remote_port) : null, numStr(u.remote_port));
    leaf(out, p("authentication", "username"), l("auth_username"), u.auth_username);
    leaf(out, p("authentication", "password"), l("auth_password"), u.auth_password);
  } else {
    leaf(out, p("server", "subnet"), l("server_subnet"), u.server_subnet);
    leaf(out, p("server", "topology"), l("server_topology"), u.server_topology);
    leaf(out, p("server", "max-connections"), sameMode ? numStr(live!.server_max_connections) : null, numStr(u.server_max_connections));
    multi(out, p("server", "push-route"), sameMode ? live!.server_push_routes : [], u.server_push_routes);
    multi(out, p("server", "name-server"), sameMode ? live!.server_name_servers : [], u.server_name_servers);
  }

  multi(out, p("openvpn-option"), live?.openvpn_options ?? [], u.openvpn_options);

  // A brand-new interface with only `mode` still gets created by the mode leaf;
  // if somehow nothing was emitted, create the node explicitly.
  if (live === null && !out.some((c) => c.op === "set")) return [{ op: "set", path: base }];
  return out;
}

export function applyOpenvpn(live: OpenvpnInterface | null, update: OpenvpnInterface): Promise<number> {
  return commitAndSave(diffOpenvpn(live, update), `OpenVPN ${update.name} change`);
}

export function deleteOpenvpn(name: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: ["interfaces", "openvpn", name] }], `Delete OpenVPN ${name}`);
}
