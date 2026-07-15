// VRRP data layer (`high-availability vrrp`).
//
// Reads the whole `high-availability vrrp` subtree into structured objects and
// diffs one slice at a time (a group, a sync-group, or the global parameters)
// into a minimal set/delete command list — the same shape as bgp.ts.
//
// A VRRP change can move the management VIP and sever the session, so every
// apply goes through `guardedCommitAndSave` (live immediately, auto-reverted
// unless confirmed in the shell banner).

import { vyosApi } from "./api";
import { VyosCommand, VyosResponse } from "./interfaces";
import { guardedCommitAndSave } from "./guard";

const commitAndSave = (commands: VyosCommand[], what: string) =>
  guardedCommitAndSave(commands, what);

// ── model ─────────────────────────────────────────────────────────────────────

export type AuthType = "plaintext-password" | "ah";

/// A virtual (floating) IP the group owns. VyOS models `address` as a tag node
/// keyed by the CIDR, with an optional `interface` child (place the VIP on a
/// different interface than the VRRP one).
export interface VrrpVip {
  address: string;
  interface: string | null;
}

/// `authentication` — absent (type null) means no VRRP authentication.
export interface VrrpAuth {
  type: AuthType | null;
  /** Never round-tripped from a read (VyOS masks it); only sent when the user
   *  types a new value. */
  password: string | null;
}

/// `health-check` — a keepalived tracking script (group and sync-group level).
export interface VrrpHealthCheck {
  script: string | null;
  interval: number | null;
  failure_count: number | null;
  timeout: number | null;
}

/// `transition-script` — run on each state transition.
export interface VrrpTransitionScript {
  master: string | null;
  backup: string | null;
  fault: string | null;
  stop: string | null;
}

/// `garp` — gratuitous-ARP tuning (group and global level). `interval` is
/// fractional seconds so it stays a string to preserve precision.
export interface VrrpGarp {
  interval: string | null;
  master_delay: number | null;
  master_refresh: number | null;
  master_refresh_repeat: number | null;
  master_repeat: number | null;
}

export interface VrrpGroup {
  name: string;
  interface: string | null;
  vrid: number | null;
  priority: number | null;
  advertise_interval: number | null;
  description: string | null;
  /** Protocol version 2 or 3 (null = inherit global). */
  version: number | null;
  addresses: VrrpVip[];
  excluded_addresses: string[];
  hello_source_address: string | null;
  peer_address: string | null;
  /** `no-preempt` — a higher-priority router will NOT retake master. */
  no_preempt: boolean;
  /** Seconds to wait before preempting (only with preempt enabled). */
  preempt_delay: number | null;
  rfc3768_compatibility: boolean;
  /** `!disable`. */
  enabled: boolean;
  auth: VrrpAuth;
  track_interfaces: string[];
  track_exclude_vrrp_interface: boolean;
  health_check: VrrpHealthCheck;
  transition_script: VrrpTransitionScript;
  garp: VrrpGarp;
}

export interface VrrpSyncGroup {
  name: string;
  members: string[];
  health_check: VrrpHealthCheck;
  transition_script: VrrpTransitionScript;
}

export interface VrrpGlobalParameters {
  startup_delay: number | null;
  version: number | null;
  garp: VrrpGarp;
}

export interface VrrpConfig {
  groups: VrrpGroup[];
  syncGroups: VrrpSyncGroup[];
  global: VrrpGlobalParameters;
}

export function emptyHealthCheck(): VrrpHealthCheck {
  return { script: null, interval: null, failure_count: null, timeout: null };
}

export function emptyTransitionScript(): VrrpTransitionScript {
  return { master: null, backup: null, fault: null, stop: null };
}

export function emptyGarp(): VrrpGarp {
  return {
    interval: null,
    master_delay: null,
    master_refresh: null,
    master_refresh_repeat: null,
    master_repeat: null,
  };
}

export function emptyGroup(): VrrpGroup {
  return {
    name: "",
    interface: null,
    vrid: null,
    priority: null,
    advertise_interval: null,
    description: null,
    version: null,
    addresses: [],
    excluded_addresses: [],
    hello_source_address: null,
    peer_address: null,
    no_preempt: false,
    preempt_delay: null,
    rfc3768_compatibility: false,
    enabled: true,
    auth: { type: null, password: null },
    track_interfaces: [],
    track_exclude_vrrp_interface: false,
    health_check: emptyHealthCheck(),
    transition_script: emptyTransitionScript(),
    garp: emptyGarp(),
  };
}

export function emptySyncGroup(): VrrpSyncGroup {
  return {
    name: "",
    members: [],
    health_check: emptyHealthCheck(),
    transition_script: emptyTransitionScript(),
  };
}

export function emptyGlobal(): VrrpGlobalParameters {
  return { startup_delay: null, version: null, garp: emptyGarp() };
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

/// Multi-value / tag node → sorted key list.
function keysOf(v: Cfg | null): string[] {
  return v ? Object.keys(v).sort() : [];
}

function parseHealthCheck(node: Cfg | null): VrrpHealthCheck {
  if (!node) return emptyHealthCheck();
  return {
    script: childStr(node, "script"),
    interval: childNum(node, "interval"),
    failure_count: childNum(node, "failure-count"),
    timeout: childNum(node, "timeout"),
  };
}

function parseTransition(node: Cfg | null): VrrpTransitionScript {
  if (!node) return emptyTransitionScript();
  return {
    master: childStr(node, "master"),
    backup: childStr(node, "backup"),
    fault: childStr(node, "fault"),
    stop: childStr(node, "stop"),
  };
}

function parseGarp(node: Cfg | null): VrrpGarp {
  if (!node) return emptyGarp();
  return {
    interval: childStr(node, "interval"),
    master_delay: childNum(node, "master-delay"),
    master_refresh: childNum(node, "master-refresh"),
    master_refresh_repeat: childNum(node, "master-refresh-repeat"),
    master_repeat: childNum(node, "master-repeat"),
  };
}

function parseGroup(name: string, raw: Cfg): VrrpGroup {
  const addrNode = childCfg(raw, "address") ?? {};
  const addresses: VrrpVip[] = Object.entries(addrNode).map(([addr, v]) => ({
    address: addr,
    interface: childStr((v ?? {}) as Cfg, "interface"),
  }));
  const auth = childCfg(raw, "authentication");
  const track = childCfg(raw, "track");
  return {
    name,
    interface: childStr(raw, "interface"),
    vrid: childNum(raw, "vrid"),
    priority: childNum(raw, "priority"),
    advertise_interval: childNum(raw, "advertise-interval"),
    description: childStr(raw, "description"),
    version: childNum(raw, "version"),
    addresses: addresses.sort((a, b) => a.address.localeCompare(b.address)),
    excluded_addresses: keysOf(childCfg(raw, "excluded-address")),
    hello_source_address: childStr(raw, "hello-source-address"),
    peer_address: childStr(raw, "peer-address"),
    no_preempt: "no-preempt" in raw,
    preempt_delay: childNum(raw, "preempt-delay"),
    rfc3768_compatibility: "rfc3768-compatibility" in raw,
    enabled: !("disable" in raw),
    auth: {
      type: (childStr(auth ?? {}, "type") as AuthType | null) ?? (auth ? "plaintext-password" : null),
      // The read may be masked; keep the desired-side blank so a diff never
      // clobbers a live password with the mask.
      password: null,
    },
    track_interfaces: keysOf(childCfg(track ?? {}, "interface")),
    track_exclude_vrrp_interface: !!track && "exclude-vrrp-interface" in track,
    health_check: parseHealthCheck(childCfg(raw, "health-check")),
    transition_script: parseTransition(childCfg(raw, "transition-script")),
    garp: parseGarp(childCfg(raw, "garp")),
  };
}

function parseSyncGroup(name: string, raw: Cfg): VrrpSyncGroup {
  return {
    name,
    members: keysOf(childCfg(raw, "member")),
    health_check: parseHealthCheck(childCfg(raw, "health-check")),
    transition_script: parseTransition(childCfg(raw, "transition-script")),
  };
}

/// The whole VRRP config, structured. Absent (`{}`) when nothing is configured.
export async function fetchVrrp(): Promise<VrrpConfig> {
  const resp = await vyosApi<VyosResponse<Cfg | null>>("retrieve", {
    op: "showConfig",
    path: ["high-availability", "vrrp"],
  });

  let vrrp: Cfg = {};
  if (resp.success) vrrp = resp.data ?? {};
  else if (!(resp.error ?? "").toLowerCase().includes("empty")) {
    throw new Error(resp.error || "Device returned an error reading VRRP configuration.");
  }

  const groups = Object.entries(childCfg(vrrp, "group") ?? {})
    .map(([n, raw]) => parseGroup(n, (raw ?? {}) as Cfg))
    .sort((a, b) => a.name.localeCompare(b.name));
  const syncGroups = Object.entries(childCfg(vrrp, "sync-group") ?? {})
    .map(([n, raw]) => parseSyncGroup(n, (raw ?? {}) as Cfg))
    .sort((a, b) => a.name.localeCompare(b.name));

  const gp = childCfg(vrrp, "global-parameters") ?? {};
  const global: VrrpGlobalParameters = {
    startup_delay: childNum(gp, "startup-delay"),
    version: childNum(gp, "version"),
    garp: parseGarp(childCfg(gp, "garp")),
  };

  return { groups, syncGroups, global };
}

// ── diff helpers ────────────────────────────────────────────────────────────────

const BASE = ["high-availability", "vrrp"];
const trimmed = (s: string | null) => {
  const t = s?.trim() ?? "";
  return t === "" ? null : t;
};
const numStr = (n: number | null) => (n != null ? String(n) : null);

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

/// Multi-value leaf (add/remove children).
function multi(out: VyosCommand[], path: string[], live: string[], desired: string[]) {
  const want = desired.map((s) => s.trim()).filter(Boolean);
  for (const v of want) if (!live.includes(v)) out.push({ op: "set", path: [...path, v] });
  for (const v of live) if (!want.includes(v)) out.push({ op: "delete", path: [...path, v] });
}

function diffHealthCheck(out: VyosCommand[], base: string[], live: VrrpHealthCheck, u: VrrpHealthCheck) {
  const p = (...s: string[]) => [...base, "health-check", ...s];
  leaf(out, p("script"), live.script, u.script);
  leaf(out, p("interval"), numStr(live.interval), numStr(u.interval));
  leaf(out, p("failure-count"), numStr(live.failure_count), numStr(u.failure_count));
  leaf(out, p("timeout"), numStr(live.timeout), numStr(u.timeout));
}

function diffTransition(out: VyosCommand[], base: string[], live: VrrpTransitionScript, u: VrrpTransitionScript) {
  const p = (...s: string[]) => [...base, "transition-script", ...s];
  leaf(out, p("master"), live.master, u.master);
  leaf(out, p("backup"), live.backup, u.backup);
  leaf(out, p("fault"), live.fault, u.fault);
  leaf(out, p("stop"), live.stop, u.stop);
}

function diffGarp(out: VyosCommand[], base: string[], live: VrrpGarp, u: VrrpGarp) {
  const p = (...s: string[]) => [...base, "garp", ...s];
  leaf(out, p("interval"), live.interval, u.interval);
  leaf(out, p("master-delay"), numStr(live.master_delay), numStr(u.master_delay));
  leaf(out, p("master-refresh"), numStr(live.master_refresh), numStr(u.master_refresh));
  leaf(out, p("master-refresh-repeat"), numStr(live.master_refresh_repeat), numStr(u.master_refresh_repeat));
  leaf(out, p("master-repeat"), numStr(live.master_repeat), numStr(u.master_repeat));
}

// ── group ─────────────────────────────────────────────────────────────────────

/// Diff the virtual-address tag nodes (each with an optional `interface` child).
function diffAddresses(out: VyosCommand[], base: string[], live: VrrpVip[], desired: VrrpVip[]) {
  const liveByAddr = new Map(live.map((a) => [a.address, a]));
  const want = desired.filter((a) => a.address.trim() !== "");
  const wantAddrs = new Set(want.map((a) => a.address.trim()));

  for (const a of want) {
    const addr = a.address.trim();
    const l = liveByAddr.get(addr);
    if (!l) out.push({ op: "set", path: [...base, "address", addr] });
    leaf(out, [...base, "address", addr, "interface"], l?.interface ?? null, a.interface);
  }
  for (const a of live) {
    if (!wantAddrs.has(a.address)) out.push({ op: "delete", path: [...base, "address", a.address] });
  }
}

export function diffGroup(live: VrrpGroup | null, u: VrrpGroup): VyosCommand[] {
  const base = [...BASE, "group", u.name];
  const out: VyosCommand[] = [];
  const p = (...s: string[]) => [...base, ...s];
  const l = live ?? emptyGroup();

  leaf(out, p("interface"), l.interface, u.interface);
  leaf(out, p("vrid"), numStr(l.vrid), numStr(u.vrid));
  leaf(out, p("priority"), numStr(l.priority), numStr(u.priority));
  leaf(out, p("advertise-interval"), numStr(l.advertise_interval), numStr(u.advertise_interval));
  leaf(out, p("description"), l.description, u.description);
  leaf(out, p("version"), numStr(l.version), numStr(u.version));
  leaf(out, p("hello-source-address"), l.hello_source_address, u.hello_source_address);
  leaf(out, p("peer-address"), l.peer_address, u.peer_address);
  leaf(out, p("preempt-delay"), numStr(l.preempt_delay), numStr(u.preempt_delay));
  flag(out, p("no-preempt"), l.no_preempt, u.no_preempt);
  flag(out, p("rfc3768-compatibility"), l.rfc3768_compatibility, u.rfc3768_compatibility);
  flag(out, p("disable"), !l.enabled, !u.enabled);

  diffAddresses(out, base, l.addresses, u.addresses);
  multi(out, p("excluded-address"), l.excluded_addresses, u.excluded_addresses);

  // Tracking.
  multi(out, p("track", "interface"), l.track_interfaces, u.track_interfaces);
  flag(out, p("track", "exclude-vrrp-interface"), l.track_exclude_vrrp_interface, u.track_exclude_vrrp_interface);

  // Authentication — dropping the type removes the whole node; a password is
  // only sent when the user typed one (reads are masked).
  if (!u.auth.type) {
    if (l.auth.type) out.push({ op: "delete", path: p("authentication") });
  } else {
    leaf(out, p("authentication", "type"), l.auth.type, u.auth.type);
    const pw = trimmed(u.auth.password);
    if (pw !== null) out.push({ op: "set", path: p("authentication", "password", pw) });
  }

  diffHealthCheck(out, base, l.health_check, u.health_check);
  diffTransition(out, base, l.transition_script, u.transition_script);
  diffGarp(out, base, l.garp, u.garp);

  // A brand-new group with no leaves still needs its node created.
  if (live === null && !out.some((c) => c.op === "set")) {
    return [{ op: "set", path: base }];
  }
  return out;
}

export function applyGroup(live: VrrpGroup | null, update: VrrpGroup): Promise<number> {
  return commitAndSave(diffGroup(live, update), `VRRP group ${update.name} change`);
}

export function deleteGroup(name: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: [...BASE, "group", name] }], `Delete VRRP group ${name}`);
}

// ── sync-group ─────────────────────────────────────────────────────────────────

export function diffSyncGroup(live: VrrpSyncGroup | null, u: VrrpSyncGroup): VyosCommand[] {
  const base = [...BASE, "sync-group", u.name];
  const out: VyosCommand[] = [];
  const l = live ?? emptySyncGroup();

  multi(out, [...base, "member"], l.members, u.members);
  diffHealthCheck(out, base, l.health_check, u.health_check);
  diffTransition(out, base, l.transition_script, u.transition_script);

  if (live === null && !out.some((c) => c.op === "set")) {
    return [{ op: "set", path: base }];
  }
  return out;
}

export function applySyncGroup(live: VrrpSyncGroup | null, update: VrrpSyncGroup): Promise<number> {
  return commitAndSave(diffSyncGroup(live, update), `VRRP sync-group ${update.name} change`);
}

export function deleteSyncGroup(name: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: [...BASE, "sync-group", name] }], `Delete VRRP sync-group ${name}`);
}

// ── global-parameters ──────────────────────────────────────────────────────────

export function diffGlobal(live: VrrpGlobalParameters, u: VrrpGlobalParameters): VyosCommand[] {
  const base = [...BASE, "global-parameters"];
  const out: VyosCommand[] = [];
  leaf(out, [...base, "startup-delay"], numStr(live.startup_delay), numStr(u.startup_delay));
  leaf(out, [...base, "version"], numStr(live.version), numStr(u.version));
  diffGarp(out, base, live.garp, u.garp);
  return out;
}

export function applyGlobal(live: VrrpGlobalParameters, update: VrrpGlobalParameters): Promise<number> {
  return commitAndSave(diffGlobal(live, update), "VRRP global parameters change");
}
