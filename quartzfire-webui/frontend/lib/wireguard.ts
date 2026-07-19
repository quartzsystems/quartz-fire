// WireGuard data layer (`interfaces wireguard <wgN>`).
//
// A WireGuard interface is a tunnel endpoint plus a list of peers. Each
// interface is edited as a whole (interface leaves + its peers) in one modal;
// `applyWireguard` diffs one interface at a time — common leaves, WireGuard
// specifics, and the nested peer set — into a minimal set/delete command list.
//
// Like the other interface types, a WireGuard change can sever the management
// session (it's still an interface), so every write goes through
// `guardedCommitAndSave` — live immediately, auto-reverted unless confirmed.
//
// Keys: VyOS stores the interface `private-key` and each peer `public-key` /
// `preshared-key` as base64 leaves. The `retrieve` API returns their real
// values, so the modal prefills them and the diff treats them like any other
// leaf. Generate a key-pair on the appliance with
// `generate pki wireguard key-pair`.

import { vyosApi } from "./api";
import type { VyosCommand, VyosResponse } from "./interfaces";
import { guardedCommitAndSave } from "./guard";

const commitAndSave = (commands: VyosCommand[], what: string) =>
  guardedCommitAndSave(commands, what);

// ── model ─────────────────────────────────────────────────────────────────────

export interface WireguardPeer {
  /** Peer identifier (`peer <name>`) — a free-form label, not the key. */
  name: string;
  public_key: string | null;
  /** Optional pre-shared symmetric key (extra layer, post-quantum resistance). */
  preshared_key: string | null;
  /** Networks routed into the tunnel for this peer (`allowed-ips`). */
  allowed_ips: string[];
  /** Remote endpoint host (`peer <name> address`). Null for roaming peers. */
  endpoint_address: string | null;
  /** Remote endpoint port (`peer <name> port`). */
  endpoint_port: number | null;
  /** Keepalive seconds — needed to hold a session open through NAT. */
  persistent_keepalive: number | null;
  disabled: boolean;
}

export interface WireguardInterface {
  name: string;
  description: string | null;
  addresses: string[];
  private_key: string | null;
  /** UDP listen port (`interfaces wireguard <wgN> port`). */
  port: number | null;
  mtu: number | null;
  enabled: boolean;
  peers: WireguardPeer[];
}

export function emptyWireguardPeer(): WireguardPeer {
  return {
    name: "",
    public_key: null,
    preshared_key: null,
    allowed_ips: [],
    endpoint_address: null,
    endpoint_port: null,
    persistent_keepalive: null,
    disabled: false,
  };
}

export function emptyWireguardInterface(): WireguardInterface {
  return {
    name: "",
    description: null,
    addresses: [],
    private_key: null,
    port: null,
    mtu: null,
    enabled: true,
    peers: [],
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

/// A multi-value leaf renders as a JSON string for one value, array for several.
function asMulti(v: Cfg, key: string): string[] {
  const a = v[key];
  if (typeof a === "string") return [a];
  if (Array.isArray(a)) return a.filter((x): x is string => typeof x === "string");
  return [];
}

function asAddresses(v: Cfg): string[] {
  return asMulti(v, "address");
}

function parsePeer(name: string, raw: Cfg): WireguardPeer {
  return {
    name,
    public_key: childStr(raw, "public-key"),
    preshared_key: childStr(raw, "preshared-key"),
    allowed_ips: asMulti(raw, "allowed-ips").sort(),
    endpoint_address: childStr(raw, "address"),
    endpoint_port: childNum(raw, "port"),
    persistent_keepalive: childNum(raw, "persistent-keepalive"),
    disabled: "disable" in raw,
  };
}

function parseInterface(name: string, raw: Cfg): WireguardInterface {
  const peerNode = raw["peer"];
  const peers =
    peerNode && typeof peerNode === "object"
      ? Object.entries(peerNode as Record<string, Cfg>)
          .map(([n, p]) => parsePeer(n, (p ?? {}) as Cfg))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];
  return {
    name,
    description: childStr(raw, "description"),
    addresses: asAddresses(raw),
    private_key: childStr(raw, "private-key"),
    port: childNum(raw, "port"),
    mtu: childNum(raw, "mtu"),
    enabled: !("disable" in raw),
    peers,
  };
}

/// All configured WireGuard interfaces, from the running config.
export async function fetchWireguard(): Promise<WireguardInterface[]> {
  const resp = await vyosApi<VyosResponse<Cfg | null>>("retrieve", {
    op: "showConfig",
    path: ["interfaces", "wireguard"],
  });

  let node: Cfg = {};
  if (resp.success) node = resp.data ?? {};
  else if (!(resp.error ?? "").toLowerCase().includes("empty")) {
    throw new Error(resp.error || "Device returned an error reading WireGuard configuration.");
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

function multi(out: VyosCommand[], path: string[], live: string[], desired: string[]) {
  const want = desired.map((s) => s.trim()).filter(Boolean);
  for (const v of want) if (!live.includes(v)) out.push({ op: "set", path: [...path, v] });
  for (const v of live) if (!want.includes(v)) out.push({ op: "delete", path: [...path, v] });
}

function diffPeer(out: VyosCommand[], base: string[], live: WireguardPeer | null, u: WireguardPeer) {
  const sub: VyosCommand[] = [];
  const p = (...s: string[]) => [...base, ...s];
  leaf(sub, p("public-key"), live?.public_key ?? null, u.public_key);
  leaf(sub, p("preshared-key"), live?.preshared_key ?? null, u.preshared_key);
  multi(sub, p("allowed-ips"), live?.allowed_ips ?? [], u.allowed_ips);
  leaf(sub, p("address"), live?.endpoint_address ?? null, u.endpoint_address);
  leaf(sub, p("port"), numStr(live?.endpoint_port ?? null), numStr(u.endpoint_port));
  leaf(sub, p("persistent-keepalive"), numStr(live?.persistent_keepalive ?? null), numStr(u.persistent_keepalive));
  if (u.disabled !== (live?.disabled ?? false)) {
    sub.push({ op: u.disabled ? "set" : "delete", path: p("disable") });
  }
  // A brand-new peer that emitted nothing else still needs its node created.
  if (live === null && !sub.some((c) => c.op === "set")) sub.push({ op: "set", path: base });
  out.push(...sub);
}

export function diffWireguard(live: WireguardInterface | null, u: WireguardInterface): VyosCommand[] {
  const base = ["interfaces", "wireguard", u.name];
  const out: VyosCommand[] = [];
  const p = (...s: string[]) => [...base, ...s];

  leaf(out, p("description"), live?.description ?? null, u.description);
  multi(out, p("address"), live?.addresses ?? [], u.addresses);
  leaf(out, p("private-key"), live?.private_key ?? null, u.private_key);
  leaf(out, p("port"), numStr(live?.port ?? null), numStr(u.port));
  leaf(out, p("mtu"), numStr(live?.mtu ?? null), numStr(u.mtu));
  if (u.enabled !== (live?.enabled ?? true)) {
    out.push({ op: u.enabled ? "delete" : "set", path: p("disable") });
  }

  // Peers — add/update by name, drop the ones no longer present.
  const liveByName = new Map((live?.peers ?? []).map((x) => [x.name, x]));
  const wantByName = new Map(u.peers.filter((x) => x.name.trim()).map((x) => [x.name.trim(), x]));
  for (const [name, peer] of wantByName) {
    diffPeer(out, p("peer", name), liveByName.get(name) ?? null, peer);
  }
  for (const [name] of liveByName) {
    if (!wantByName.has(name)) out.push({ op: "delete", path: p("peer", name) });
  }

  // A brand-new interface with nothing set still needs its node created.
  if (live === null && !out.some((c) => c.op === "set")) {
    return [{ op: "set", path: base }];
  }
  return out;
}

export function applyWireguard(live: WireguardInterface | null, update: WireguardInterface): Promise<number> {
  return commitAndSave(diffWireguard(live, update), `WireGuard ${update.name} change`);
}

export function deleteWireguard(name: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: ["interfaces", "wireguard", name] }], `Delete WireGuard ${name}`);
}
