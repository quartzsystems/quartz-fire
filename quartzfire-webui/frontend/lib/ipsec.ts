// IPsec data layer (`vpn ipsec`).
//
// IPsec is one global config node holding four independent collections:
//   * `interface <name>` — the interfaces IKE/IPsec listens on (multi-value),
//   * `ike-group <name>`  — IKE (phase-1) proposals + timers,
//   * `esp-group <name>`  — ESP (phase-2) proposals + PFS/mode,
//   * `site-to-site peer <name>` — the actual tunnels, referencing the groups.
//
// `fetchIpsec` reads the whole subtree into a structured object; each editor
// diffs one slice at a time (one group, one peer, or the interface list) into a
// minimal command list. A bad IPsec change can drop a site-to-site link the
// admin is riding over, so every apply goes through `guardedCommitAndSave` —
// live immediately, auto-reverted unless confirmed.

import { vyosApi } from "./api";
import type { VyosCommand, VyosResponse } from "./interfaces";
import { guardedCommitAndSave } from "./guard";

const commitAndSave = (commands: VyosCommand[], what: string) =>
  guardedCommitAndSave(commands, what);

// ── model ─────────────────────────────────────────────────────────────────────

export type KeyExchange = "ikev1" | "ikev2";
export type EspMode = "tunnel" | "transport";
export type ConnectionType = "initiate" | "respond" | "none";
export type AuthMode = "pre-shared-secret" | "x509";

/// One IKE proposal (`ike-group <g> proposal <n>`). DH group only applies to
/// IKE proposals; ESP proposals reuse this shape with `dh_group` left null.
export interface IpsecProposal {
  seq: number;
  encryption: string | null;
  hash: string | null;
  dh_group: string | null;
}

export interface IkeGroup {
  name: string;
  key_exchange: KeyExchange | null;
  lifetime: number | null;
  dpd_action: string | null;
  dpd_interval: number | null;
  dpd_timeout: number | null;
  proposals: IpsecProposal[];
}

export interface EspGroup {
  name: string;
  lifetime: number | null;
  /** `pfs enable|disable|dh-group<N>`. */
  pfs: string | null;
  mode: EspMode | null;
  proposals: IpsecProposal[];
}

/// One policy-based tunnel under a peer (`peer <p> tunnel <n>`).
export interface IpsecTunnel {
  seq: number;
  local_prefix: string | null;
  remote_prefix: string | null;
  protocol: string | null;
  /** Per-tunnel ESP group override (else the peer's default-esp-group). */
  esp_group: string | null;
}

export interface IpsecPeer {
  name: string;
  auth_mode: AuthMode | null;
  pre_shared_secret: string | null;
  local_id: string | null;
  remote_id: string | null;
  connection_type: ConnectionType | null;
  ike_group: string | null;
  default_esp_group: string | null;
  local_address: string | null;
  remote_address: string | null;
  /** Route-based binding to a VTI interface (`vti bind <vtiN>`). */
  vti_bind: string | null;
  /** Policy-based tunnels. Empty for a pure route-based (VTI) peer. */
  tunnels: IpsecTunnel[];
}

export interface IpsecConfig {
  interfaces: string[];
  ike_groups: IkeGroup[];
  esp_groups: EspGroup[];
  peers: IpsecPeer[];
}

export function emptyProposal(): IpsecProposal {
  return { seq: 10, encryption: null, hash: null, dh_group: null };
}
export function emptyIkeGroup(): IkeGroup {
  return { name: "", key_exchange: null, lifetime: null, dpd_action: null, dpd_interval: null, dpd_timeout: null, proposals: [] };
}
export function emptyEspGroup(): EspGroup {
  return { name: "", lifetime: null, pfs: null, mode: null, proposals: [] };
}
export function emptyPeer(): IpsecPeer {
  return {
    name: "",
    auth_mode: null,
    pre_shared_secret: null,
    local_id: null,
    remote_id: null,
    connection_type: null,
    ike_group: null,
    default_esp_group: null,
    local_address: null,
    remote_address: null,
    vti_bind: null,
    tunnels: [],
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
/// Tag node → keys (e.g. `interface`, or the top level of `ike-group`).
function keysOf(v: Cfg | null): string[] {
  return v ? Object.keys(v) : [];
}

function parseProposals(node: Cfg | null, withDh: boolean): IpsecProposal[] {
  if (!node) return [];
  return Object.entries(node)
    .map(([seq, raw]) => {
      const p = (raw ?? {}) as Cfg;
      return {
        seq: Number(seq) || 0,
        encryption: childStr(p, "encryption"),
        hash: childStr(p, "hash"),
        dh_group: withDh ? childStr(p, "dh-group") : null,
      };
    })
    .sort((a, b) => a.seq - b.seq);
}

function parseIkeGroup(name: string, raw: Cfg): IkeGroup {
  const dpd = childCfg(raw, "dead-peer-detection") ?? {};
  return {
    name,
    key_exchange: childStr(raw, "key-exchange") as KeyExchange | null,
    lifetime: childNum(raw, "lifetime"),
    dpd_action: childStr(dpd, "action"),
    dpd_interval: childNum(dpd, "interval"),
    dpd_timeout: childNum(dpd, "timeout"),
    proposals: parseProposals(childCfg(raw, "proposal"), true),
  };
}

function parseEspGroup(name: string, raw: Cfg): EspGroup {
  return {
    name,
    lifetime: childNum(raw, "lifetime"),
    pfs: childStr(raw, "pfs"),
    mode: childStr(raw, "mode") as EspMode | null,
    proposals: parseProposals(childCfg(raw, "proposal"), false),
  };
}

function parseTunnels(node: Cfg | null): IpsecTunnel[] {
  if (!node) return [];
  return Object.entries(node)
    .map(([seq, raw]) => {
      const t = (raw ?? {}) as Cfg;
      const local = childCfg(t, "local") ?? {};
      const remote = childCfg(t, "remote") ?? {};
      return {
        seq: Number(seq) || 0,
        local_prefix: childStr(local, "prefix"),
        remote_prefix: childStr(remote, "prefix"),
        protocol: childStr(t, "protocol"),
        esp_group: childStr(t, "esp-group"),
      };
    })
    .sort((a, b) => a.seq - b.seq);
}

function parsePeer(name: string, raw: Cfg): IpsecPeer {
  const auth = childCfg(raw, "authentication") ?? {};
  const vti = childCfg(raw, "vti");
  return {
    name,
    auth_mode: childStr(auth, "mode") as AuthMode | null,
    pre_shared_secret: childStr(auth, "pre-shared-secret"),
    local_id: childStr(auth, "local-id"),
    remote_id: childStr(auth, "remote-id"),
    connection_type: childStr(raw, "connection-type") as ConnectionType | null,
    ike_group: childStr(raw, "ike-group"),
    default_esp_group: childStr(raw, "default-esp-group"),
    local_address: childStr(raw, "local-address"),
    remote_address: childStr(raw, "remote-address"),
    vti_bind: vti ? childStr(vti, "bind") : null,
    tunnels: parseTunnels(childCfg(raw, "tunnel")),
  };
}

/// The whole IPsec config, structured. Absent (`{}`) when nothing is configured.
export async function fetchIpsec(): Promise<IpsecConfig> {
  const resp = await vyosApi<VyosResponse<Cfg | null>>("retrieve", {
    op: "showConfig",
    path: ["vpn", "ipsec"],
  });

  let ipsec: Cfg = {};
  if (resp.success) ipsec = resp.data ?? {};
  else if (!(resp.error ?? "").toLowerCase().includes("empty")) {
    throw new Error(resp.error || "Device returned an error reading IPsec configuration.");
  }

  const ike_groups = Object.entries(childCfg(ipsec, "ike-group") ?? {})
    .map(([n, raw]) => parseIkeGroup(n, (raw ?? {}) as Cfg))
    .sort((a, b) => a.name.localeCompare(b.name));
  const esp_groups = Object.entries(childCfg(ipsec, "esp-group") ?? {})
    .map(([n, raw]) => parseEspGroup(n, (raw ?? {}) as Cfg))
    .sort((a, b) => a.name.localeCompare(b.name));
  const s2s = childCfg(ipsec, "site-to-site");
  const peers = Object.entries(childCfg(s2s ?? {}, "peer") ?? {})
    .map(([n, raw]) => parsePeer(n, (raw ?? {}) as Cfg))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    interfaces: keysOf(childCfg(ipsec, "interface")).sort(),
    ike_groups,
    esp_groups,
    peers,
  };
}

// ── diff helpers ──────────────────────────────────────────────────────────────

const BASE = ["vpn", "ipsec"];
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

/// Diff a proposal set (tag node keyed by seq) — add/update by seq, drop the rest.
function diffProposals(out: VyosCommand[], base: string[], live: IpsecProposal[], want: IpsecProposal[], withDh: boolean) {
  const liveBySeq = new Map(live.map((p) => [p.seq, p]));
  const wantBySeq = new Map(want.filter((p) => Number.isInteger(p.seq) && p.seq > 0).map((p) => [p.seq, p]));
  for (const [seq, p] of wantBySeq) {
    const l = liveBySeq.get(seq) ?? null;
    const pb = [...base, "proposal", String(seq)];
    leaf(out, [...pb, "encryption"], l?.encryption ?? null, p.encryption);
    leaf(out, [...pb, "hash"], l?.hash ?? null, p.hash);
    if (withDh) leaf(out, [...pb, "dh-group"], l?.dh_group ?? null, p.dh_group);
    if (l === null && !trimmed(p.encryption) && !trimmed(p.hash) && !(withDh && trimmed(p.dh_group))) {
      out.push({ op: "set", path: pb });
    }
  }
  for (const [seq] of liveBySeq) if (!wantBySeq.has(seq)) out.push({ op: "delete", path: [...base, "proposal", String(seq)] });
}

// ── interfaces ──────────────────────────────────────────────────────────────────

export function applyIpsecInterfaces(live: string[], desired: string[]): Promise<number> {
  const out: VyosCommand[] = [];
  multi(out, [...BASE, "interface"], live, desired);
  return commitAndSave(out, "IPsec interface bindings change");
}

// ── IKE group ───────────────────────────────────────────────────────────────────

export function diffIkeGroup(live: IkeGroup | null, u: IkeGroup): VyosCommand[] {
  const out: VyosCommand[] = [];
  const base = [...BASE, "ike-group", u.name];
  const p = (...s: string[]) => [...base, ...s];

  leaf(out, p("key-exchange"), live?.key_exchange ?? null, u.key_exchange);
  leaf(out, p("lifetime"), numStr(live?.lifetime ?? null), numStr(u.lifetime));
  leaf(out, p("dead-peer-detection", "action"), live?.dpd_action ?? null, u.dpd_action);
  leaf(out, p("dead-peer-detection", "interval"), numStr(live?.dpd_interval ?? null), numStr(u.dpd_interval));
  leaf(out, p("dead-peer-detection", "timeout"), numStr(live?.dpd_timeout ?? null), numStr(u.dpd_timeout));
  diffProposals(out, base, live?.proposals ?? [], u.proposals, true);

  if (live === null && !out.some((c) => c.op === "set")) return [{ op: "set", path: base }];
  return out;
}

export function applyIkeGroup(live: IkeGroup | null, update: IkeGroup): Promise<number> {
  return commitAndSave(diffIkeGroup(live, update), `IPsec IKE group ${update.name} change`);
}
export function deleteIkeGroup(name: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: [...BASE, "ike-group", name] }], `Delete IKE group ${name}`);
}

// ── ESP group ───────────────────────────────────────────────────────────────────

export function diffEspGroup(live: EspGroup | null, u: EspGroup): VyosCommand[] {
  const out: VyosCommand[] = [];
  const base = [...BASE, "esp-group", u.name];
  const p = (...s: string[]) => [...base, ...s];

  leaf(out, p("lifetime"), numStr(live?.lifetime ?? null), numStr(u.lifetime));
  leaf(out, p("pfs"), live?.pfs ?? null, u.pfs);
  leaf(out, p("mode"), live?.mode ?? null, u.mode);
  diffProposals(out, base, live?.proposals ?? [], u.proposals, false);

  if (live === null && !out.some((c) => c.op === "set")) return [{ op: "set", path: base }];
  return out;
}

export function applyEspGroup(live: EspGroup | null, update: EspGroup): Promise<number> {
  return commitAndSave(diffEspGroup(live, update), `IPsec ESP group ${update.name} change`);
}
export function deleteEspGroup(name: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: [...BASE, "esp-group", name] }], `Delete ESP group ${name}`);
}

// ── site-to-site peer ────────────────────────────────────────────────────────────

function diffTunnels(out: VyosCommand[], base: string[], live: IpsecTunnel[], want: IpsecTunnel[]) {
  const liveBySeq = new Map(live.map((t) => [t.seq, t]));
  const wantBySeq = new Map(want.filter((t) => Number.isInteger(t.seq) && t.seq >= 0).map((t) => [t.seq, t]));
  for (const [seq, t] of wantBySeq) {
    const l = liveBySeq.get(seq) ?? null;
    const tb = [...base, "tunnel", String(seq)];
    leaf(out, [...tb, "local", "prefix"], l?.local_prefix ?? null, t.local_prefix);
    leaf(out, [...tb, "remote", "prefix"], l?.remote_prefix ?? null, t.remote_prefix);
    leaf(out, [...tb, "protocol"], l?.protocol ?? null, t.protocol);
    leaf(out, [...tb, "esp-group"], l?.esp_group ?? null, t.esp_group);
    if (l === null && !trimmed(t.local_prefix) && !trimmed(t.remote_prefix)) out.push({ op: "set", path: tb });
  }
  for (const [seq] of liveBySeq) if (!wantBySeq.has(seq)) out.push({ op: "delete", path: [...base, "tunnel", String(seq)] });
}

export function diffPeer(live: IpsecPeer | null, u: IpsecPeer): VyosCommand[] {
  const out: VyosCommand[] = [];
  const base = [...BASE, "site-to-site", "peer", u.name];
  const p = (...s: string[]) => [...base, ...s];

  leaf(out, p("authentication", "mode"), live?.auth_mode ?? null, u.auth_mode);
  leaf(out, p("authentication", "pre-shared-secret"), live?.pre_shared_secret ?? null, u.pre_shared_secret);
  leaf(out, p("authentication", "local-id"), live?.local_id ?? null, u.local_id);
  leaf(out, p("authentication", "remote-id"), live?.remote_id ?? null, u.remote_id);
  leaf(out, p("connection-type"), live?.connection_type ?? null, u.connection_type);
  leaf(out, p("ike-group"), live?.ike_group ?? null, u.ike_group);
  leaf(out, p("default-esp-group"), live?.default_esp_group ?? null, u.default_esp_group);
  leaf(out, p("local-address"), live?.local_address ?? null, u.local_address);
  leaf(out, p("remote-address"), live?.remote_address ?? null, u.remote_address);
  leaf(out, p("vti", "bind"), live?.vti_bind ?? null, u.vti_bind);
  diffTunnels(out, base, live?.tunnels ?? [], u.tunnels);

  if (live === null && !out.some((c) => c.op === "set")) return [{ op: "set", path: base }];
  return out;
}

export function applyPeer(live: IpsecPeer | null, update: IpsecPeer): Promise<number> {
  return commitAndSave(diffPeer(live, update), `IPsec peer ${update.name} change`);
}
export function deletePeer(name: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: [...BASE, "site-to-site", "peer", name] }], `Delete IPsec peer ${name}`);
}
