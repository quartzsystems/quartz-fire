// Routing policy data layer (`policy prefix-list` / `prefix-list6` /
// `route-map`) — the filtering primitives BGP references for route control.
//
// Each prefix-list / route-map is edited as a whole (name + ordered rules) in
// one modal; apply diffs rule-by-rule into a minimal command list. Writes go
// through `guardedCommitAndSave` since a filter change can alter what BGP
// advertises and, indirectly, reachability.

import { vyosApi } from "./api";
import { VyosCommand, VyosResponse } from "./interfaces";
import { guardedCommitAndSave } from "./guard";

const commitAndSave = (commands: VyosCommand[], what: string) =>
  guardedCommitAndSave(commands, what);

// ── model ─────────────────────────────────────────────────────────────────────

export type PrefixFamily = "ipv4" | "ipv6";
export type PolicyAction = "permit" | "deny";

export interface PrefixRule {
  seq: number;
  action: PolicyAction;
  prefix: string;
  /** Match netmask length >= ge. */
  ge: number | null;
  /** Match netmask length <= le. */
  le: number | null;
  description: string | null;
}

export interface PrefixList {
  name: string;
  family: PrefixFamily;
  rules: PrefixRule[];
}

export interface RouteMapMatch {
  ip_prefix_list: string | null;
  ipv6_prefix_list: string | null;
  as_path: string | null;
  community_list: string | null;
  interface: string | null;
  metric: number | null;
  origin: string | null;
  peer: string | null;
}

export interface RouteMapSet {
  as_path_prepend: string | null;
  community: string | null;
  local_preference: number | null;
  /** Free-form to allow `+n` / `-n` / absolute. */
  metric: string | null;
  ip_next_hop: string | null;
  origin: string | null;
  weight: number | null;
  tag: number | null;
}

export interface RouteMapRule {
  seq: number;
  action: PolicyAction;
  description: string | null;
  match: RouteMapMatch;
  set: RouteMapSet;
  on_match: { kind: "none" | "next" | "goto"; goto: number | null };
  call: string | null;
}

export interface RouteMap {
  name: string;
  rules: RouteMapRule[];
}

export function emptyMatch(): RouteMapMatch {
  return {
    ip_prefix_list: null,
    ipv6_prefix_list: null,
    as_path: null,
    community_list: null,
    interface: null,
    metric: null,
    origin: null,
    peer: null,
  };
}

export function emptySet(): RouteMapSet {
  return {
    as_path_prepend: null,
    community: null,
    local_preference: null,
    metric: null,
    ip_next_hop: null,
    origin: null,
    weight: null,
    tag: null,
  };
}

export function emptyRouteMapRule(seq: number): RouteMapRule {
  return {
    seq,
    action: "permit",
    description: null,
    match: emptyMatch(),
    set: emptySet(),
    on_match: { kind: "none", goto: null },
    call: null,
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

const PREFIX_NODE: Record<PrefixFamily, string> = { ipv4: "prefix-list", ipv6: "prefix-list6" };

function parsePrefixRule(seq: number, raw: Cfg): PrefixRule {
  return {
    seq,
    action: childStr(raw, "action") === "deny" ? "deny" : "permit",
    prefix: childStr(raw, "prefix") ?? "",
    ge: childNum(raw, "ge"),
    le: childNum(raw, "le"),
    description: childStr(raw, "description"),
  };
}

function parsePrefixLists(policy: Cfg, family: PrefixFamily): PrefixList[] {
  const node = childCfg(policy, PREFIX_NODE[family]) ?? {};
  return Object.entries(node)
    .map(([name, raw]) => {
      const rules = childCfg((raw ?? {}) as Cfg, "rule") ?? {};
      return {
        name,
        family,
        rules: Object.entries(rules)
          .map(([seq, r]) => parsePrefixRule(Number(seq), (r ?? {}) as Cfg))
          .sort((a, b) => a.seq - b.seq),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function parseRouteMapRule(seq: number, raw: Cfg): RouteMapRule {
  const m = childCfg(raw, "match") ?? {};
  const s = childCfg(raw, "set") ?? {};
  const onMatch = childCfg(raw, "on-match");
  const goto = onMatch ? childNum(onMatch, "goto") : null;
  return {
    seq,
    action: childStr(raw, "action") === "deny" ? "deny" : "permit",
    description: childStr(raw, "description"),
    match: {
      ip_prefix_list: childStr(childCfg(childCfg(m, "ip") ?? {}, "address") ?? {}, "prefix-list"),
      ipv6_prefix_list: childStr(childCfg(childCfg(m, "ipv6") ?? {}, "address") ?? {}, "prefix-list"),
      as_path: childStr(m, "as-path"),
      community_list: childStr(childCfg(m, "community") ?? {}, "community-list"),
      interface: childStr(m, "interface"),
      metric: childNum(m, "metric"),
      origin: childStr(m, "origin"),
      peer: childStr(m, "peer"),
    },
    set: {
      as_path_prepend: childStr(childCfg(s, "as-path") ?? {}, "prepend"),
      community: childStr(s, "community"),
      local_preference: childNum(s, "local-preference"),
      metric: childStr(s, "metric"),
      ip_next_hop: childStr(s, "ip-next-hop"),
      origin: childStr(s, "origin"),
      weight: childNum(s, "weight"),
      tag: childNum(s, "tag"),
    },
    on_match: {
      kind: onMatch ? (goto != null ? "goto" : "next" in onMatch ? "next" : "none") : "none",
      goto,
    },
    call: childStr(raw, "call"),
  };
}

function parseRouteMaps(policy: Cfg): RouteMap[] {
  const node = childCfg(policy, "route-map") ?? {};
  return Object.entries(node)
    .map(([name, raw]) => {
      const rules = childCfg((raw ?? {}) as Cfg, "rule") ?? {};
      return {
        name,
        rules: Object.entries(rules)
          .map(([seq, r]) => parseRouteMapRule(Number(seq), (r ?? {}) as Cfg))
          .sort((a, b) => a.seq - b.seq),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchPolicy(): Promise<Cfg> {
  const resp = await vyosApi<VyosResponse<Cfg | null>>("retrieve", {
    op: "showConfig",
    path: ["policy"],
  });
  if (resp.success) return resp.data ?? {};
  if ((resp.error ?? "").toLowerCase().includes("empty")) return {};
  throw new Error(resp.error || "Device returned an error reading routing policy.");
}

/// All configured prefix-lists (IPv4 + IPv6).
export async function fetchPrefixLists(): Promise<PrefixList[]> {
  const policy = await fetchPolicy();
  return [...parsePrefixLists(policy, "ipv4"), ...parsePrefixLists(policy, "ipv6")];
}

/// All configured route-maps.
export async function fetchRouteMaps(): Promise<RouteMap[]> {
  return parseRouteMaps(await fetchPolicy());
}

/// Route-map names, for BGP route-map pickers. Best-effort (empty on failure).
export async function fetchRouteMapNames(): Promise<string[]> {
  try {
    return (await fetchRouteMaps()).map((r) => r.name);
  } catch {
    return [];
  }
}

/// Prefix-list names of one family, for route-map match pickers.
export async function fetchPrefixListNames(family: PrefixFamily): Promise<string[]> {
  try {
    return (await fetchPrefixLists()).filter((p) => p.family === family).map((p) => p.name);
  } catch {
    return [];
  }
}

// ── diff helpers ────────────────────────────────────────────────────────────────

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
const numStr = (n: number | null) => (n != null ? String(n) : null);

// ── prefix-list writes ──────────────────────────────────────────────────────────

const prefixBase = (family: PrefixFamily, name: string) => ["policy", PREFIX_NODE[family], name];

function diffPrefixRule(out: VyosCommand[], base: string[], live: PrefixRule | null, u: PrefixRule) {
  const r = [...base, "rule", String(u.seq)];
  if (live === null) out.push({ op: "set", path: r });
  leaf(out, [...r, "action"], live?.action ?? null, u.action);
  leaf(out, [...r, "prefix"], live?.prefix ?? null, u.prefix);
  leaf(out, [...r, "ge"], numStr(live?.ge ?? null), numStr(u.ge));
  leaf(out, [...r, "le"], numStr(live?.le ?? null), numStr(u.le));
  leaf(out, [...r, "description"], live?.description ?? null, u.description);
}

/// Apply a whole prefix-list: diff each desired rule, delete removed rules.
export function applyPrefixList(live: PrefixList | null, u: PrefixList): Promise<number> {
  const base = prefixBase(u.family, u.name);
  const out: VyosCommand[] = [];
  if (live === null) out.push({ op: "set", path: base });

  const liveBySeq = new Map((live?.rules ?? []).map((r) => [r.seq, r]));
  for (const rule of u.rules) diffPrefixRule(out, base, liveBySeq.get(rule.seq) ?? null, rule);

  const wantSeqs = new Set(u.rules.map((r) => r.seq));
  for (const r of live?.rules ?? [])
    if (!wantSeqs.has(r.seq)) out.push({ op: "delete", path: [...base, "rule", String(r.seq)] });

  return commitAndSave(out, `Prefix-list ${u.name} change`);
}

export function deletePrefixList(family: PrefixFamily, name: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: prefixBase(family, name) }], `Delete prefix-list ${name}`);
}

// ── route-map writes ────────────────────────────────────────────────────────────

const routeMapBase = (name: string) => ["policy", "route-map", name];

function diffRouteMapRule(out: VyosCommand[], base: string[], live: RouteMapRule | null, u: RouteMapRule) {
  const r = [...base, "rule", String(u.seq)];
  if (live === null) out.push({ op: "set", path: r });
  leaf(out, [...r, "action"], live?.action ?? null, u.action);
  leaf(out, [...r, "description"], live?.description ?? null, u.description);

  const lm = live?.match ?? emptyMatch();
  leaf(out, [...r, "match", "ip", "address", "prefix-list"], lm.ip_prefix_list, u.match.ip_prefix_list);
  leaf(out, [...r, "match", "ipv6", "address", "prefix-list"], lm.ipv6_prefix_list, u.match.ipv6_prefix_list);
  leaf(out, [...r, "match", "as-path"], lm.as_path, u.match.as_path);
  leaf(out, [...r, "match", "community", "community-list"], lm.community_list, u.match.community_list);
  leaf(out, [...r, "match", "interface"], lm.interface, u.match.interface);
  leaf(out, [...r, "match", "metric"], numStr(lm.metric), numStr(u.match.metric));
  leaf(out, [...r, "match", "origin"], lm.origin, u.match.origin);
  leaf(out, [...r, "match", "peer"], lm.peer, u.match.peer);

  const ls = live?.set ?? emptySet();
  leaf(out, [...r, "set", "as-path", "prepend"], ls.as_path_prepend, u.set.as_path_prepend);
  leaf(out, [...r, "set", "community"], ls.community, u.set.community);
  leaf(out, [...r, "set", "local-preference"], numStr(ls.local_preference), numStr(u.set.local_preference));
  leaf(out, [...r, "set", "metric"], ls.metric, u.set.metric);
  leaf(out, [...r, "set", "ip-next-hop"], ls.ip_next_hop, u.set.ip_next_hop);
  leaf(out, [...r, "set", "origin"], ls.origin, u.set.origin);
  leaf(out, [...r, "set", "weight"], numStr(ls.weight), numStr(u.set.weight));
  leaf(out, [...r, "set", "tag"], numStr(ls.tag), numStr(u.set.tag));

  // on-match: `next` is a flag, `goto` a leaf; they're mutually exclusive.
  const lom = live?.on_match ?? { kind: "none" as const, goto: null };
  flag(out, [...r, "on-match", "next"], lom.kind === "next", u.on_match.kind === "next");
  leaf(out, [...r, "on-match", "goto"], lom.kind === "goto" ? numStr(lom.goto) : null,
    u.on_match.kind === "goto" ? numStr(u.on_match.goto) : null);

  leaf(out, [...r, "call"], live?.call ?? null, u.call);
}

/// Apply a whole route-map: diff each desired rule, delete removed rules.
export function applyRouteMap(live: RouteMap | null, u: RouteMap): Promise<number> {
  const base = routeMapBase(u.name);
  const out: VyosCommand[] = [];
  if (live === null) out.push({ op: "set", path: base });

  const liveBySeq = new Map((live?.rules ?? []).map((r) => [r.seq, r]));
  for (const rule of u.rules) diffRouteMapRule(out, base, liveBySeq.get(rule.seq) ?? null, rule);

  const wantSeqs = new Set(u.rules.map((r) => r.seq));
  for (const r of live?.rules ?? [])
    if (!wantSeqs.has(r.seq)) out.push({ op: "delete", path: [...base, "rule", String(r.seq)] });

  return commitAndSave(out, `Route-map ${u.name} change`);
}

export function deleteRouteMap(name: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: routeMapBase(name) }], `Delete route-map ${name}`);
}
