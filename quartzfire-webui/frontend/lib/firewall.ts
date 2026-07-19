// Firewall data layer — a WatchGuard-style model over native VyOS config.
//
// The GUI works with three object kinds, all stored as plain VyOS firewall
// config so the CLI view stays normal:
//   Aliases  → `firewall group` address-group (hosts) / network-group
//              (networks) / domain-group (FQDNs)
//   Policies → `firewall group port-group`; the protocol is kept in a
//              `[tcp]`/`[udp]`/`[tcp_udp]` marker prefixed to the group
//              description (port-groups have no protocol of their own)
//   Rules    → `firewall ipv4 <chain> filter rule <n>`, ordered by rule
//              number in gaps of 10 so drag-reorder renumbers cleanly.
//              Routed traffic lives in the forward chain; a rule whose To
//              (From) side is the built-in Firewall endpoint lives in the
//              input (output) chain instead, because traffic to/from the box
//              itself never traverses forward. The first rule written to
//              input/output also seeds hidden `[qz-sys]` baseline rules
//              (accept established/related and loopback, default-action
//              accept) so a broad deny can't cut off reply traffic or the
//              WebUI's own loopback API connection.
//
// A rule's From/To is a WatchGuard-style list matching ANY of its entries. One
// native rule can't OR several groups (multiple criteria AND together), so a
// multi-entry side is backed by a hidden auto-managed group — an address/
// network-group `include`-ing each chosen alias, or an interface-group holding
// the chosen interfaces — marked with a `[qz-rule]` description and kept off
// the Aliases page.
//
// Writes follow the QuartzFire model — diff against the live config, commit
// straight to the VyOS API, and save to the boot config in the background.

import { vyosApi } from "./api";
import type { VyosCommand, VyosResponse } from "./interfaces";
import { guardedCommitAndSave } from "./guard";
import { showText } from "./vyos";
import { remapFlowAttribution } from "./flows";
import type { AttributionMove } from "./flows";

/// A bad firewall change can sever the management session, so firewall writes
/// commit under commit-confirm: live immediately, auto-reverted unless the
/// user confirms in the shell banner (see lib/guard).
const commitAndSave = (commands: VyosCommand[]) =>
  guardedCommitAndSave(commands, "Firewall configuration change");

export type AliasType = "host" | "network" | "fqdn" | "iface";

/// VyOS group node + member leaf backing each alias type. `iface` is a named
/// set of interfaces (`firewall group interface-group`) — zone-like grouping
/// without zone-based mode; a rule matches it via `inbound-interface group` /
/// `outbound-interface group`.
export const ALIAS_GROUP: Record<AliasType, { node: string; memberLeaf: string; label: string }> = {
  host:    { node: "address-group",   memberLeaf: "address",   label: "Host" },
  network: { node: "network-group",   memberLeaf: "network",   label: "Network" },
  fqdn:    { node: "domain-group",    memberLeaf: "address",   label: "FQDN" },
  iface:   { node: "interface-group", memberLeaf: "interface", label: "Interface Group" },
};

const GROUP_NODE_TO_TYPE: Record<string, AliasType> = {
  "address-group": "host",
  "network-group": "network",
  "domain-group": "fqdn",
  "interface-group": "iface",
};

export interface FirewallAlias {
  name: string;
  /** Friendly name shown in the UI (may contain spaces) — see DN_MARK. */
  display: string;
  type: AliasType;
  description: string | null;
  members: string[];
}

/// Built-in alias derived from a configured interface (ethernet or VLAN),
/// named by the interface description. Shown on the Aliases page but not
/// stored as a VyOS group — selecting it in a rule is selecting the interface,
/// so it always mirrors the interface config.
export interface InterfaceAlias {
  iface: string;
  display: string;
  description: string | null;
  /** Connected IPv4 networks, from the interface addresses (172.16.1.1/24 → 172.16.1.0/24). */
  networks: string[];
}

/// IPv4 network containing `cidr` (`172.16.1.10/24` → `172.16.1.0/24`); null
/// for IPv6, `dhcp`, or anything else that isn't a literal IPv4 CIDR.
function ipv4Network(cidr: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!m) return null;
  const prefix = Number(m[5]);
  const octets = m.slice(1, 5).map(Number);
  if (prefix > 32 || octets.some((o) => o > 255)) return null;
  const addr = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const net = (addr & mask) >>> 0;
  return `${net >>> 24}.${(net >>> 16) & 255}.${(net >>> 8) & 255}.${net & 255}/${prefix}`;
}

export function interfaceAliases(
  ifaces: { name: string; description: string | null; addresses: string[] }[],
): InterfaceAlias[] {
  return ifaces
    // Only interfaces actually set up (addressed or named) get a built-in
    // alias — a bare NIC that exists in the config only as a hw-id doesn't.
    .filter((i) => i.description !== null || i.addresses.length > 0)
    .map((i) => ({
      iface: i.name,
      display: i.description ?? i.name,
      description: i.description,
      networks: [...new Set(i.addresses.map(ipv4Network).filter((n): n is string => n !== null))],
    }))
    .sort((a, b) => a.display.localeCompare(b.display));
}

export type PolicyProtocol = "tcp" | "udp" | "tcp_udp";

export const PROTOCOL_LABEL: Record<PolicyProtocol, string> = {
  tcp: "TCP",
  udp: "UDP",
  tcp_udp: "TCP/UDP",
};

export interface FirewallPolicy {
  name: string;
  protocol: PolicyProtocol;
  /** Port numbers, ranges (`8000-8010`), or service names (`https`). */
  ports: string[];
  description: string | null;
}

/// Policies offered in the rule form without prior setup. Selecting one seeds
/// a normal port-group of the same name on first use — it then shows on the
/// Policies page and behaves like any user policy. (Ping is separate: ICMP
/// can't be expressed as a port-group.)
export const BUILTIN_POLICIES: Record<string, { protocol: PolicyProtocol; ports: string[] }> = {
  HTTPS: { protocol: "tcp", ports: ["443"] },
  SSH: { protocol: "tcp", ports: ["22"] },
};

export type RuleAction = "accept" | "drop" | "reject";

/// What a zone does with traffic no rule matched, and with traffic between
/// members of the zone itself. VyOS has no `accept` default-action for zones —
/// a zone always denies what its pair rulesets don't allow.
export type ZoneDefaultAction = "drop" | "reject";

/// A firewall zone — a named group of interfaces, with the rules between any
/// two zones living in that pair's ruleset (see zoneRuleChain).
///
/// Stored as native `firewall zone <name>` config:
///   member interface <if>     the zone's interfaces
///   local-zone                the firewall itself (no members; at most one)
///   default-action            what unmatched traffic INTO this zone gets
///   intra-zone-filtering      what traffic between the zone's own members gets
///
/// Friendly names go through the same `[dn:…]` description marker as aliases,
/// because VyOS zone names can't contain spaces.
export interface FirewallZone {
  name: string;
  /** Friendly name shown in the UI (may contain spaces) — see DN_MARK. */
  display: string;
  description: string | null;
  /** The firewall itself. A local zone has no member interfaces, and there can
   *  only be one — it backs the built-in Firewall endpoint. */
  local: boolean;
  interfaces: string[];
  /** Unmatched traffic into the zone (null = not set; VyOS then drops). */
  default_action: ZoneDefaultAction | null;
  /** Whether default-action hits are logged (feeds the Traffic Monitor). */
  default_log: boolean;
  /** Traffic between the zone's own members (null = VyOS default, accept). */
  intra_zone: RuleAction | null;
}

/// A zone pair and the ruleset holding its rules — one direction of traffic,
/// `zone <dst> from <src> firewall name <ruleset>`. Traffic the other way is a
/// separate pair with its own ruleset.
export interface ZonePair {
  src: string;
  dst: string;
  ruleset: string;
}

/// Ruleset name backing a zone pair. Auto-managed: created with the pair's
/// first rule and removed with its last.
export const pairRuleset = (src: string, dst: string) => `QZ-Z-${src}-TO-${dst}`;

/// Base chain a rule lives in. Routed traffic uses forward; traffic addressed
/// to the firewall itself only ever traverses input, and firewall-originated
/// traffic output — so the built-in Firewall endpoint steers a rule into the
/// matching chain.
///
/// This is the narrow union: features that can only ever target a base chain
/// (geolocation, whose qzgeo binary hardcodes `firewall ipv4 <ruleset> filter`)
/// take BaseChain, not RuleChain.
export type BaseChain = "forward" | "input" | "output";

/// Where a rule lives. Either a base chain, or a named ruleset holding the
/// rules of one zone pair (`name:<ruleset>` → `firewall ipv4 name <ruleset>`).
///
/// Zone rules can't live in a base chain: VyOS binds a zone pair to a named
/// ruleset (`zone <dst> from <src> firewall name <ruleset>`) and jumps to it
/// from the zone chains. Keeping the scope a plain string preserves the
/// `${chain}:${rule}` key used by the cascade, the monitor, and the counters.
export type RuleChain = BaseChain | `name:${string}`;

/// The named ruleset a scope refers to, or null for a base chain.
export function rulesetName(chain: RuleChain): string | null {
  return chain.startsWith("name:") ? chain.slice("name:".length) : null;
}

/// Whether a scope is one of the three base chains (rather than a zone pair's
/// ruleset) — the guard that lets base-chain-only code narrow.
export function isBaseChain(chain: RuleChain): chain is BaseChain {
  return !chain.startsWith("name:");
}

/// Scope holding the rules of a zone pair.
export const zoneRuleChain = (ruleset: string): RuleChain => `name:${ruleset}`;

const BASE_CHAIN_RANK: Record<BaseChain, number> = { forward: 0, input: 1, output: 2 };

/// Sort rank — base chains first in forward/input/output order, then zone
/// rulesets, so the merged Rules table stays stable.
function chainRank(chain: RuleChain): number {
  return rulesetName(chain) === null ? BASE_CHAIN_RANK[chain as BaseChain] : 3;
}

/// Auto-managed OR group backing a multi-entry From/To side.
export interface AutoGroup {
  name: string;
  /** VyOS group node: address-group, network-group, domain-group, or interface-group. */
  node: string;
  /** Included alias-group names (address/network groups). */
  includes: string[];
  /** Member interfaces (interface groups). */
  interfaces: string[];
  /** Literal members — inline hosts/networks/FQDNs typed into the rule form. */
  members: string[];
}

/// Description marker identifying auto-managed groups.
export const AUTO_MARK = "[qz-rule]";

/// Description marker identifying hidden system rules — the safety baseline
/// seeded into the input/output chains (see ensureChainSetup).
export const SYS_MARK = "[qz-sys]";

/// Connection mark tagging flows selected for IPS inspection. An IPS-enabled
/// rule sets it on the first packet it queues; the hidden flow rule at the
/// top of the forward chain (ensureIpsFlowBaseline) then queues every later
/// packet of the connection — both directions — to the engine. Without that,
/// the established/related baseline would accept everything after the
/// handshake and Suricata could never match content signatures.
export const IPS_CONNMARK = 81;

/// One side of a rule match as stored in the config: a group reference, an
/// interface (by name or interface-group), a literal address, or none (= any).
/// `iface`/`iface_group` map to the rule-level `inbound-interface` (From) /
/// `outbound-interface` (To) node.
export interface RuleEndpoint {
  group_type: string | null;
  group_name: string | null;
  address: string | null;
  iface: string | null;
  iface_group: string | null;
}

/// One config rule backing a UI rule: where it lives, and its raw subtree.
export interface RuleScope {
  chain: RuleChain;
  /** Full raw config subtree — used to rebuild the rule when renumbering so
   *  leaves this UI doesn't model (state, log-options, …) survive a reorder. */
  raw: Cfg;
}

export interface FirewallRule {
  rule: number;
  /** Representative scope (`scopes[0].chain`). A base rule only ever has one;
   *  a zone rule reports the first of its pairs. */
  chain: RuleChain;
  /** Every config rule backing this one UI rule — one for a base-chain rule,
   *  one per zone pair for a zone rule.
   *
   *  VyOS can't OR zone pairs: a rule From [LAN, DMZ] To [WAN] has to exist
   *  once per pair, in each pair's own ruleset. All copies share this rule's
   *  number (numbers are allocated globally, see nextRuleNumber), which is
   *  what lets them be recognised as one rule on the way back in. */
  scopes: RuleScope[];
  /** Rule name, stored as the VyOS `description` leaf. */
  name: string | null;
  action: RuleAction | null;
  /** Whether matches are inspected by the IPS engine. Stored as `action
   *  queue` (+ `queue`/`queue-options` leaves) — the packet is queued to
   *  Suricata, which returns the accept/drop verdict. Displayed as an Allow
   *  rule with IPS on; `action` reads "accept" when this is set. */
  ips: boolean;
  from: RuleEndpoint;
  to: RuleEndpoint;
  /** Policy (destination port-group) name, or null = any port. */
  policy: string | null;
  protocol: string | null;
  enabled: boolean;
  /** Whether matches are logged (feeds the Traffic Monitor). */
  log: boolean;
  /** Raw config subtree of the representative scope (`scopes[0].raw`). */
  raw: Cfg;
}

/// Stable identity of a UI rule.
///
/// Rule numbers are only unique within a chain, so base rules key on both. A
/// zone rule spans one scope per pair and its pair set changes as it's edited,
/// so it keys on its number alone — which is safe because new rule numbers are
/// allocated across every scope at once (nextRuleNumber).
export function ruleKey(rule: Pick<FirewallRule, "chain" | "rule">): string {
  return isBaseChain(rule.chain) ? `${rule.chain}:${rule.rule}` : `zone:${rule.rule}`;
}

/// What already exists in a base chain — used to seed the hidden safety
/// baseline exactly once (see ensureChainSetup / ensureForwardBaseline).
export interface ChainSetup {
  /** Baseline rules present (or their rule numbers already taken). */
  baseline: boolean;
  /** Hidden connmark→queue rule present (see ensureIpsFlowBaseline) — without
   *  it the IPS engine only ever sees each connection's first packet. */
  ips_flow: boolean;
  /** The chain's configured default-action (null = not set). */
  default_action: string | null;
  /** Whether `default-log` is set (default-action hits reach the monitor). */
  default_log: boolean;
}

export interface FirewallConfig {
  aliases: FirewallAlias[];
  policies: FirewallPolicy[];
  rules: FirewallRule[];
  /** Auto-managed OR groups created by the rule editor. */
  auto_groups: AutoGroup[];
  /** Every configured group name across all group types — used to pick fresh
   *  auto-group names without colliding with user-defined groups. */
  group_names: string[];
  /** `firewall ipv4 forward filter default-action` (null = VyOS default). */
  default_action: string | null;
  /** Per-chain baseline/logging state (input/output back the built-in
   *  Firewall endpoint; forward backs the traffic-monitor baseline). Keyed on
   *  the base chains only — a zone pair's ruleset has no baseline of its own
   *  (replies are handled globally, see ensureStatePolicy). */
  setup: Record<BaseChain, ChainSetup>;
  /** Configured zones (`firewall zone`), empty when zones aren't in use. */
  zones: FirewallZone[];
  /** Zone pairs and the rulesets holding their rules. */
  zone_pairs: ZonePair[];
  /** Whether `firewall global-options state-policy` accepts established and
   *  related traffic — required for zones to pass reply packets. */
  state_policy: boolean;
}

/// Empty config used as the initial page state before the first fetch.
export function emptyFirewallConfig(): FirewallConfig {
  const chain = (): ChainSetup => ({ baseline: false, ips_flow: false, default_action: null, default_log: false });
  return {
    aliases: [],
    policies: [],
    rules: [],
    auto_groups: [],
    group_names: [],
    default_action: null,
    setup: { forward: chain(), input: chain(), output: chain() },
    zones: [],
    zone_pairs: [],
    state_policy: false,
  };
}

// ── parse helpers ─────────────────────────────────────────────────────────────

type Cfg = Record<string, unknown>;

function childStr(v: Cfg, key: string): string | null {
  const x = v[key];
  if (typeof x !== "string") return null;
  const s = x.trim();
  return s === "" ? null : s;
}

function childCfg(v: Cfg, key: string): Cfg | null {
  const x = v[key];
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Cfg) : null;
}

/// A multi-value leaf — VyOS renders one value as a JSON string and several
/// as a JSON array.
function childList(v: Cfg, key: string): string[] {
  const x = v[key];
  if (typeof x === "string") return [x];
  if (Array.isArray(x)) return x.filter((m): m is string => typeof m === "string");
  return [];
}

// ── policy protocol marker ────────────────────────────────────────────────────

const PROTO_MARK = /^\[(tcp|udp|tcp_udp)\]\s*/;

/// Split a port-group description into (protocol, user description).
/// A group without a marker (created outside this UI) defaults to tcp_udp.
function decodePolicyDescription(desc: string | null): { protocol: PolicyProtocol; description: string | null } {
  if (!desc) return { protocol: "tcp_udp", description: null };
  const m = desc.match(PROTO_MARK);
  if (!m) return { protocol: "tcp_udp", description: desc };
  const rest = desc.slice(m[0].length).trim();
  return { protocol: m[1] as PolicyProtocol, description: rest === "" ? null : rest };
}

function encodePolicyDescription(protocol: PolicyProtocol, description: string | null): string {
  const d = description?.trim() ?? "";
  return d === "" ? `[${protocol}]` : `[${protocol}] ${d}`;
}

// ── alias display-name marker ─────────────────────────────────────────────────

/// VyOS group names can't contain spaces, so an alias entered as "Approved DNS
/// Servers" is stored as the group "Approved-DNS-Servers" with its friendly
/// name kept in a `[dn:…]` marker at the front of the group description. An
/// alias without a marker (created on the CLI) displays its group name.
const DN_MARK = /^\[dn:([^\]]+)\]\s*/;

function decodeAliasDescription(name: string, desc: string | null): { display: string; description: string | null } {
  if (!desc) return { display: name, description: null };
  const m = desc.match(DN_MARK);
  if (!m) return { display: name, description: desc };
  const rest = desc.slice(m[0].length).trim();
  return { display: m[1], description: rest === "" ? null : rest };
}

function encodeAliasDescription(name: string, display: string, description: string | null): string | null {
  const parts: string[] = [];
  if (display.trim() !== name) parts.push(`[dn:${display.trim()}]`);
  const d = description?.trim() ?? "";
  if (d !== "") parts.push(d);
  return parts.length ? parts.join(" ") : null;
}

/// The VyOS group name backing a friendly alias name — spaces become hyphens.
export function sanitizeAliasName(display: string): string {
  return display.trim().replace(/\s+/g, "-");
}

/// Display name of an alias group reference (falls back to the group name for
/// groups this UI doesn't model, e.g. inside a stale rule).
export function aliasDisplayName(aliases: FirewallAlias[], type: AliasType, name: string): string {
  return aliases.find((a) => a.type === type && a.name === name)?.display ?? name;
}

// ── reads ─────────────────────────────────────────────────────────────────────

/// The full running `firewall` config node ({} when nothing is configured).
async function fetchFirewallConfig(): Promise<Cfg> {
  const resp = await vyosApi<VyosResponse<Cfg | null>>("retrieve", {
    op: "showConfig",
    path: ["firewall"],
  });

  if (resp.success) return resp.data ?? {};
  // "Configuration under specified path is empty" just means no firewall yet.
  if ((resp.error ?? "").toLowerCase().includes("empty")) return {};
  throw new Error(resp.error || "Device returned an error reading the firewall.");
}

function parseAliases(group: Cfg): FirewallAlias[] {
  const out: FirewallAlias[] = [];
  for (const [node, type] of Object.entries(GROUP_NODE_TO_TYPE)) {
    const groups = childCfg(group, node) ?? {};
    for (const [name, raw] of Object.entries(groups)) {
      const cfg = (raw ?? {}) as Cfg;
      const rawDesc = childStr(cfg, "description");
      if (rawDesc?.startsWith(AUTO_MARK)) continue; // rule-editor internals
      const { display, description } = decodeAliasDescription(name, rawDesc);
      out.push({
        name,
        display,
        type,
        description,
        members: childList(cfg, ALIAS_GROUP[type].memberLeaf),
      });
    }
  }
  return out.sort((a, b) => a.display.localeCompare(b.display));
}

const AUTO_NODES = ["address-group", "network-group", "domain-group", "interface-group"] as const;

/// Leaf holding an auto group's literal members, per group node.
const AUTO_MEMBER_LEAF: Record<string, string> = {
  "address-group": "address",
  "network-group": "network",
  "domain-group": "address",
};

function parseAutoGroups(group: Cfg): AutoGroup[] {
  const out: AutoGroup[] = [];
  for (const node of AUTO_NODES) {
    const groups = childCfg(group, node) ?? {};
    for (const [name, raw] of Object.entries(groups)) {
      const cfg = (raw ?? {}) as Cfg;
      if (!(childStr(cfg, "description") ?? "").startsWith(AUTO_MARK)) continue;
      out.push({
        name,
        node,
        includes: childList(cfg, "include"),
        interfaces: childList(cfg, "interface"),
        members: node in AUTO_MEMBER_LEAF ? childList(cfg, AUTO_MEMBER_LEAF[node]) : [],
      });
    }
  }
  return out;
}

function parseGroupNames(group: Cfg): string[] {
  const out: string[] = [];
  for (const v of Object.values(group)) {
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...Object.keys(v as Cfg));
  }
  return out;
}

function parsePolicies(group: Cfg): FirewallPolicy[] {
  const groups = childCfg(group, "port-group") ?? {};
  return Object.entries(groups)
    .map(([name, raw]) => {
      const cfg = (raw ?? {}) as Cfg;
      const { protocol, description } = decodePolicyDescription(childStr(cfg, "description"));
      return { name, protocol, description, ports: childList(cfg, "port") };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── zones ─────────────────────────────────────────────────────────────────────

const asZoneDefault = (v: string | null): ZoneDefaultAction | null =>
  v === "drop" || v === "reject" ? v : null;

function parseZones(fw: Cfg): FirewallZone[] {
  const zones = childCfg(fw, "zone") ?? {};
  return Object.entries(zones)
    .map(([name, raw]) => {
      const cfg = (raw ?? {}) as Cfg;
      const { display, description } = decodeAliasDescription(name, childStr(cfg, "description"));
      return {
        name,
        display,
        description,
        local: "local-zone" in cfg,
        interfaces: childList(childCfg(cfg, "member") ?? {}, "interface"),
        default_action: asZoneDefault(childStr(cfg, "default-action")),
        default_log: "default-log" in cfg,
        intra_zone: asAction(childStr(childCfg(cfg, "intra-zone-filtering") ?? {}, "action")),
      };
    })
    .sort((a, b) => a.display.localeCompare(b.display));
}

/// Every zone-pair binding in the config, as (src, dst) → ruleset name. Read
/// from the `zone <dst> from <src> firewall name <ruleset>` nodes; the local
/// zone is just a zone here, because VyOS synthesizes the from-local direction
/// itself rather than exposing a separate node.
function parseZonePairs(fw: Cfg): ZonePair[] {
  const out: ZonePair[] = [];
  for (const [dst, raw] of Object.entries(childCfg(fw, "zone") ?? {})) {
    const from = childCfg((raw ?? {}) as Cfg, "from") ?? {};
    for (const [src, fraw] of Object.entries(from)) {
      const ruleset = childStr(childCfg((fraw ?? {}) as Cfg, "firewall") ?? {}, "name");
      if (ruleset) out.push({ src, dst, ruleset });
    }
  }
  return out;
}

/// The pair a rule's scope belongs to, or null when the scope is a base chain.
export function pairForChain(pairs: ZonePair[], chain: RuleChain): ZonePair | null {
  const name = rulesetName(chain);
  return name === null ? null : pairs.find((p) => p.ruleset === name) ?? null;
}


/// Whether `firewall global-options state-policy` lets replies through. Zone
/// chains hook at priority 1, after the base chains at priority 0 — a base
/// chain's established/related accept only means "carry on to the zone chain",
/// which has no state match of its own and would fall through to the zone's
/// default-action. State policy is the global jump the zone chains make, and
/// is what actually keeps reply traffic alive once zones are in use.
function parseStatePolicy(fw: Cfg): boolean {
  const sp = childCfg(childCfg(fw, "global-options") ?? {}, "state-policy") ?? {};
  const action = (state: string) => childStr(childCfg(sp, state) ?? {}, "action");
  return action("established") === "accept" && action("related") === "accept";
}

/// Group references a rule side can carry that the From/To model understands.
const REF_NODES = ["address-group", "network-group", "domain-group"] as const;

/// Rule-level interface-match node backing each side.
const IFACE_NODE: Record<"source" | "destination", string> = {
  source: "inbound-interface",
  destination: "outbound-interface",
};

function parseEndpoint(cfg: Cfg, side: "source" | "destination"): RuleEndpoint {
  const s = childCfg(cfg, side) ?? {};
  const g = childCfg(s, "group") ?? {};

  // Interface matches live at rule level (`inbound-interface name <if>` or
  // `inbound-interface group <g>`), not under source/destination.
  const ifNode = cfg[IFACE_NODE[side]];
  let iface: string | null = null;
  let iface_group: string | null = null;
  if (typeof ifNode === "string") iface = ifNode.trim() || null;
  else if (ifNode && typeof ifNode === "object") {
    iface = childStr(ifNode as Cfg, "name");
    iface_group = childStr(ifNode as Cfg, "group");
  }

  for (const node of REF_NODES) {
    const name = childStr(g, node);
    if (name) return { group_type: node, group_name: name, address: null, iface, iface_group };
  }
  return { group_type: null, group_name: null, address: childStr(s, "address"), iface, iface_group };
}

const asAction = (v: string | null): RuleAction | null =>
  v === "accept" || v === "drop" || v === "reject" ? v : null;

function parseChain(filter: Cfg, chain: RuleChain): { rules: FirewallRule[]; setup: ChainSetup } {
  const ruleCfg = childCfg(filter, "rule") ?? {};
  let sys = false;
  let ipsFlow = false;
  const rules: FirewallRule[] = [];
  for (const [num, raw] of Object.entries(ruleCfg)) {
    const cfg = (raw ?? {}) as Cfg;
    const name = childStr(cfg, "description");
    if (name?.startsWith(SYS_MARK)) {
      sys = true; // hidden baseline rule — not a user rule
      if ("connection-mark" in cfg && childStr(cfg, "action") === "queue") ipsFlow = true;
      continue;
    }
    const dstGroup = childCfg(childCfg(cfg, "destination") ?? {}, "group") ?? {};
    const rawAction = childStr(cfg, "action");
    rules.push({
      rule: Number(num) || 0,
      chain,
      name,
      // `queue` hands matches to the IPS engine for an inline verdict — the
      // GUI shows it as Allow with IPS on.
      action: rawAction === "queue" ? "accept" : asAction(rawAction),
      ips: rawAction === "queue",
      from: parseEndpoint(cfg, "source"),
      to: parseEndpoint(cfg, "destination"),
      policy: childStr(dstGroup, "port-group"),
      protocol: childStr(cfg, "protocol"),
      enabled: !("disable" in cfg),
      log: "log" in cfg,
      raw: cfg,
      scopes: [{ chain, raw: cfg }],
    });
  }
  return {
    rules,
    setup: {
      // CLI-created rules 1/2 also count — the baseline must never clobber them.
      baseline: sys || "1" in ruleCfg || "2" in ruleCfg,
      ips_flow: ipsFlow,
      default_action: childStr(filter, "default-action"),
      default_log: "default-log" in filter,
    },
  };
}

/// Collapse the per-pair copies of a zone rule back into one UI rule.
///
/// A rule spanning several zone pairs is stored once per pair, all copies
/// sharing the rule number (see FirewallRule.scopes). Grouping here — rather
/// than in the page — is what keeps one rule showing as one row, with one
/// position in the order and one set of controls.
///
/// Copies are ordered by ruleset name so the representative scope is stable
/// across reads; the first copy supplies the body (they're written identical).
function groupZoneRules(rules: FirewallRule[]): FirewallRule[] {
  const byNumber = new Map<number, FirewallRule[]>();
  for (const r of rules) {
    const list = byNumber.get(r.rule);
    if (list) list.push(r);
    else byNumber.set(r.rule, [r]);
  }
  return [...byNumber.values()].map((copies) => {
    copies.sort((a, b) => a.chain.localeCompare(b.chain));
    const head = copies[0];
    return { ...head, scopes: copies.map((c) => ({ chain: c.chain, raw: c.raw })) };
  });
}

/// Configured aliases, policies, zones, and filter rules — the three base
/// chains plus every zone pair's named ruleset — from the running config.
export async function fetchFirewall(): Promise<FirewallConfig> {
  const fw = await fetchFirewallConfig();
  const group = childCfg(fw, "group") ?? {};
  const ipv4 = childCfg(fw, "ipv4") ?? {};
  const chainFilter = (chain: BaseChain) => childCfg(childCfg(ipv4, chain) ?? {}, "filter") ?? {};
  const forward = parseChain(chainFilter("forward"), "forward");
  const input = parseChain(chainFilter("input"), "input");
  const output = parseChain(chainFilter("output"), "output");

  // Zone rules live in the named ruleset bound to their pair. Only rulesets a
  // pair actually points at are read — a stray `firewall ipv4 name` written on
  // the CLI isn't part of the zone model and stays invisible here.
  const named = childCfg(ipv4, "name") ?? {};
  const pairs = parseZonePairs(fw);
  const zoneRules = groupZoneRules(
    [...new Set(pairs.map((p) => p.ruleset))].flatMap(
      (ruleset) => parseChain(childCfg(named, ruleset) ?? {}, zoneRuleChain(ruleset)).rules,
    ),
  );

  return {
    aliases: parseAliases(group),
    policies: parsePolicies(group),
    rules: [...forward.rules, ...input.rules, ...output.rules, ...zoneRules].sort(
      (a, b) => a.rule - b.rule || chainRank(a.chain) - chainRank(b.chain),
    ),
    auto_groups: parseAutoGroups(group),
    group_names: parseGroupNames(group),
    default_action: forward.setup.default_action,
    setup: { forward: forward.setup, input: input.setup, output: output.setup },
    zones: parseZones(fw),
    zone_pairs: pairs,
    state_policy: parseStatePolicy(fw),
  };
}

// ── usage lookups (for "in use" counts and delete guards) ─────────────────────

/// Rule numbers referencing an alias in From or To, directly or through an
/// auto-managed OR group that includes it.
export function aliasUsage(rules: FirewallRule[], autoGroups: AutoGroup[], alias: FirewallAlias): number[] {
  // Interface aliases are matched at rule level (`inbound-interface group`),
  // not as a source/destination group ref. They stand alone on a side (no
  // include), so a direct reference is the only way a rule can use one.
  if (alias.type === "iface") {
    const matches = (e: RuleEndpoint) => e.iface_group === alias.name;
    return rules.filter((r) => matches(r.from) || matches(r.to)).map((r) => r.rule);
  }
  const node = ALIAS_GROUP[alias.type].node;
  const viaAuto = new Set(
    autoGroups.filter((g) => g.node === node && g.includes.includes(alias.name)).map((g) => g.name),
  );
  const matches = (e: RuleEndpoint) =>
    e.group_type === node && e.group_name !== null && (e.group_name === alias.name || viaAuto.has(e.group_name));
  return rules.filter((r) => matches(r.from) || matches(r.to)).map((r) => r.rule);
}

/// Rule numbers matching an interface in From or To, directly or through an
/// auto-managed OR group that holds it — backs the built-in interface aliases.
export function interfaceUsage(rules: FirewallRule[], autoGroups: AutoGroup[], iface: string): number[] {
  const viaAuto = new Set(
    autoGroups.filter((g) => g.node === "interface-group" && g.interfaces.includes(iface)).map((g) => g.name),
  );
  const matches = (e: RuleEndpoint) =>
    e.iface === iface || (e.iface_group !== null && viaAuto.has(e.iface_group));
  return rules.filter((r) => matches(r.from) || matches(r.to)).map((r) => r.rule);
}

/// Rule numbers referencing a policy (port-group).
export function policyUsage(rules: FirewallRule[], name: string): number[] {
  return rules.filter((r) => r.policy === name).map((r) => r.rule);
}

// ── writes: aliases ───────────────────────────────────────────────────────────

const groupBase = (type: AliasType, name: string) => ["firewall", "group", ALIAS_GROUP[type].node, name];

/// Desired alias. `original_*` identify the alias being edited; a change of
/// name or type is a move (old group deleted, new one built fresh).
export interface AliasUpdate {
  name: string;
  /** Friendly name (may contain spaces) — stored via the [dn:…] marker. */
  display: string;
  type: AliasType;
  description: string | null;
  members: string[];
  original_name: string | null;
  original_type: AliasType | null;
}

export function diffAlias(existing: FirewallAlias[], u: AliasUpdate): VyosCommand[] {
  const out: VyosCommand[] = [];

  const moved =
    u.original_name !== null &&
    u.original_type !== null &&
    (u.original_name !== u.name || u.original_type !== u.type);
  if (moved) {
    out.push({ op: "delete", path: groupBase(u.original_type!, u.original_name!) });
  }

  const live = moved
    ? null
    : existing.find((a) => a.name === u.name && a.type === u.type) ?? null;

  const base = groupBase(u.type, u.name);
  const leaf = ALIAS_GROUP[u.type].memberLeaf;
  const body: VyosCommand[] = [];

  // Compare descriptions in their encoded form so a display-name change alone
  // still writes the [dn:…] marker.
  const newDesc = encodeAliasDescription(u.name, u.display, u.description);
  const liveDesc = live ? encodeAliasDescription(live.name, live.display, live.description) : null;
  if (newDesc !== liveDesc) {
    if (newDesc !== null) body.push({ op: "set", path: [...base, "description", newDesc] });
    else body.push({ op: "delete", path: [...base, "description"] });
  }

  const liveMembers = live?.members ?? [];
  const newMembers = u.members.map((m) => m.trim()).filter(Boolean);
  for (const m of newMembers) if (!liveMembers.includes(m)) body.push({ op: "set", path: [...base, leaf, m] });
  for (const m of liveMembers) if (!newMembers.includes(m)) body.push({ op: "delete", path: [...base, leaf, m] });

  // A new group with nothing else set still needs the node created.
  if (live === null && !body.some((c) => c.op === "set")) {
    body.length = 0;
    body.push({ op: "set", path: base });
  }
  out.push(...body);
  return out;
}

/// Apply a desired alias. Returns the number of changes applied.
export function applyAlias(existing: FirewallAlias[], update: AliasUpdate): Promise<number> {
  return commitAndSave(diffAlias(existing, update));
}

/// Delete an alias (fails at commit if a rule still references it).
export function deleteAlias(alias: FirewallAlias): Promise<number> {
  return commitAndSave([{ op: "delete", path: groupBase(alias.type, alias.name) }]);
}

// ── writes: policies ──────────────────────────────────────────────────────────

const policyBase = (name: string) => ["firewall", "group", "port-group", name];

/// Desired policy. `original_name` identifies the policy being edited.
export interface PolicyUpdate {
  name: string;
  protocol: PolicyProtocol;
  ports: string[];
  description: string | null;
  original_name: string | null;
}

/// Diff a desired policy. `rules` is scanned so a protocol change also
/// updates the `protocol` leaf of every rule using this policy.
export function diffPolicy(
  existing: FirewallPolicy[],
  rules: FirewallRule[],
  u: PolicyUpdate,
): VyosCommand[] {
  const out: VyosCommand[] = [];

  const moved = u.original_name !== null && u.original_name !== u.name;
  if (moved) {
    out.push({ op: "delete", path: policyBase(u.original_name!) });
  }

  const live = moved ? null : existing.find((p) => p.name === u.name) ?? null;

  const base = policyBase(u.name);
  const body: VyosCommand[] = [];

  const newDesc = encodePolicyDescription(u.protocol, u.description);
  const liveDesc = live ? encodePolicyDescription(live.protocol, live.description) : null;
  if (newDesc !== liveDesc) body.push({ op: "set", path: [...base, "description", newDesc] });

  const livePorts = live?.ports ?? [];
  const newPorts = u.ports.map((p) => p.trim()).filter(Boolean);
  for (const p of newPorts) if (!livePorts.includes(p)) body.push({ op: "set", path: [...base, "port", p] });
  for (const p of livePorts) if (!newPorts.includes(p)) body.push({ op: "delete", path: [...base, "port", p] });

  out.push(...body);

  // Keep rules using this policy in sync with its protocol.
  if (live && live.protocol !== u.protocol) {
    for (const r of rules) {
      if (r.policy === u.name) out.push({ op: "set", path: [...ruleBase(r.chain, r.rule), "protocol", u.protocol] });
    }
  }

  return out;
}

/// Apply a desired policy. Returns the number of changes applied.
export function applyPolicy(
  existing: FirewallPolicy[],
  rules: FirewallRule[],
  update: PolicyUpdate,
): Promise<number> {
  return commitAndSave(diffPolicy(existing, rules, update));
}

/// Delete a policy (fails at commit if a rule still references it).
export function deletePolicy(name: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: policyBase(name) }]);
}

// ── writes: zones ─────────────────────────────────────────────────────────────

const zoneBase = (name: string) => ["firewall", "zone", name];

/// Desired zone. `original_name` identifies the zone being edited.
export interface ZoneUpdate {
  name: string;
  /** Friendly name (may contain spaces) — stored via the [dn:…] marker. */
  display: string;
  description: string | null;
  local: boolean;
  interfaces: string[];
  default_action: ZoneDefaultAction | null;
  default_log: boolean;
  intra_zone: RuleAction | null;
  original_name: string | null;
}

/// The zone an interface already belongs to, or null. VyOS rejects a commit
/// that puts one interface in two zones, so the form checks first.
export function interfaceZone(zones: FirewallZone[], iface: string, exclude?: string | null): FirewallZone | null {
  return zones.find((z) => z.name !== exclude && z.interfaces.includes(iface)) ?? null;
}

/// The configured local zone (the firewall itself), or null.
export const localZone = (zones: FirewallZone[]): FirewallZone | null =>
  zones.find((z) => z.local) ?? null;

/// Validate a desired zone against the rules VyOS enforces at commit, so the
/// form can say what's wrong instead of surfacing a commit failure. Returns an
/// error message, or null when the zone is acceptable.
export function validateZone(zones: FirewallZone[], u: ZoneUpdate): string | null {
  if (!u.name.trim()) return "Enter a zone name.";
  if (!/^[a-zA-Z0-9][\w\-.]*$/.test(u.name)) {
    return "A zone name must start with a letter or digit, and use only letters, digits, hyphens, dots, or underscores.";
  }
  if (u.local) {
    // A local zone is the firewall itself: it has no interfaces of its own, and
    // there can only be one.
    if (u.interfaces.length > 0) return "The Firewall zone can't have member interfaces.";
    if (u.intra_zone !== null) return "The Firewall zone can't use intra-zone filtering.";
    const other = zones.find((z) => z.local && z.name !== u.original_name);
    if (other) return `There's already a Firewall zone (${other.display}). Only one is allowed.`;
  } else {
    if (u.interfaces.length === 0) return "Add at least one interface, or make this the Firewall zone.";
    for (const iface of u.interfaces) {
      const owner = interfaceZone(zones, iface, u.original_name);
      if (owner) return `${iface} is already a member of ${owner.display}. An interface can only belong to one zone.`;
    }
  }
  return null;
}

/// Seed `firewall global-options state-policy` so replies survive once zones
/// are in use.
///
/// The zone chains hook at priority 1, i.e. after the base chains at priority
/// 0. An `accept` in a base chain doesn't end evaluation — it only means "carry
/// on to the next chain on this hook" — so the established/related baseline in
/// the forward chain does NOT spare reply packets from the zone chains. A zone
/// pair's ruleset matches only what its rules say, so without a global state
/// match every reply would fall through to the zone's default-action and die.
/// State policy is the jump the zone chains make for exactly this reason.
function ensureStatePolicy(out: VyosCommand[], cfg: FirewallConfig): void {
  if (cfg.state_policy) return;
  const sp = ["firewall", "global-options", "state-policy"];
  out.push({ op: "set", path: [...sp, "established", "action", "accept"] });
  out.push({ op: "set", path: [...sp, "related", "action", "accept"] });
}

export function diffZone(cfg: FirewallConfig, u: ZoneUpdate): VyosCommand[] {
  const err = validateZone(cfg.zones, u);
  if (err) throw new Error(err);

  const out: VyosCommand[] = [];
  const moved = u.original_name !== null && u.original_name !== u.name;
  if (moved) out.push({ op: "delete", path: zoneBase(u.original_name!) });

  const live = moved ? null : cfg.zones.find((z) => z.name === u.name) ?? null;
  const base = zoneBase(u.name);
  const body: VyosCommand[] = [];

  const newDesc = encodeAliasDescription(u.name, u.display, u.description);
  const liveDesc = live ? encodeAliasDescription(live.name, live.display, live.description) : null;
  if (newDesc !== liveDesc) {
    if (newDesc !== null) body.push({ op: "set", path: [...base, "description", newDesc] });
    else body.push({ op: "delete", path: [...base, "description"] });
  }

  if (u.local !== (live?.local ?? false)) {
    if (u.local) body.push({ op: "set", path: [...base, "local-zone"] });
    else body.push({ op: "delete", path: [...base, "local-zone"] });
  }

  // Interfaces hang off the `member` container — NOT directly under the zone.
  const liveIfaces = live?.interfaces ?? [];
  const newIfaces = u.interfaces.map((i) => i.trim()).filter(Boolean);
  for (const i of newIfaces) {
    if (!liveIfaces.includes(i)) body.push({ op: "set", path: [...base, "member", "interface", i] });
  }
  for (const i of liveIfaces) {
    if (!newIfaces.includes(i)) body.push({ op: "delete", path: [...base, "member", "interface", i] });
  }

  if (u.default_action !== (live?.default_action ?? null)) {
    if (u.default_action !== null) body.push({ op: "set", path: [...base, "default-action", u.default_action] });
    else body.push({ op: "delete", path: [...base, "default-action"] });
  }

  if (u.default_log !== (live?.default_log ?? false)) {
    if (u.default_log) body.push({ op: "set", path: [...base, "default-log"] });
    else body.push({ op: "delete", path: [...base, "default-log"] });
  }

  if (u.intra_zone !== (live?.intra_zone ?? null)) {
    if (u.intra_zone !== null) {
      body.push({ op: "set", path: [...base, "intra-zone-filtering", "action", u.intra_zone] });
    } else body.push({ op: "delete", path: [...base, "intra-zone-filtering"] });
  }

  // A new zone with nothing else set still needs the node created.
  if (live === null && !body.some((c) => c.op === "set")) {
    body.length = 0;
    body.push({ op: "set", path: base });
  }
  out.push(...body);

  // The first zone brings the global state match with it — see ensureStatePolicy.
  if (out.length > 0) ensureStatePolicy(out, cfg);
  return out;
}

/// Apply a desired zone. Returns the number of changes applied.
export function applyZone(cfg: FirewallConfig, update: ZoneUpdate): Promise<number> {
  return commitAndSave(diffZone(cfg, update));
}

/// Rules scoped to a zone — the rules of every pair the zone takes part in,
/// keyed `${chain}:${rule}`. Backs the "in use" count and the delete guard.
export function zoneUsage(cfg: FirewallConfig, zone: FirewallZone): FirewallRule[] {
  const rulesets = new Set(
    cfg.zone_pairs
      .filter((p) => p.src === zone.name || p.dst === zone.name)
      .map((p) => p.ruleset),
  );
  return cfg.rules.filter((r) => {
    const name = rulesetName(r.chain);
    return name !== null && rulesets.has(name);
  });
}

/// Delete a zone, along with every pair it takes part in and the rulesets
/// backing them (a pair ruleset belongs to exactly one pair, so nothing else
/// references it). Leaving a dangling `from` binding would fail the commit.
export function deleteZone(cfg: FirewallConfig, zone: FirewallZone): Promise<number> {
  const out: VyosCommand[] = [];
  for (const p of cfg.zone_pairs) {
    if (p.src !== zone.name && p.dst !== zone.name) continue;
    // The binding on the other zone has to go before the ruleset it points at.
    if (p.dst !== zone.name) {
      out.push({ op: "delete", path: [...zoneBase(p.dst), "from", p.src] });
    }
    out.push({ op: "delete", path: ["firewall", "ipv4", "name", p.ruleset] });
  }
  out.push({ op: "delete", path: zoneBase(zone.name) });
  return commitAndSave(out);
}

// ── writes: rules ─────────────────────────────────────────────────────────────

/// Config path holding a scope's rules — `firewall ipv4 <chain> filter` for a
/// base chain, `firewall ipv4 name <ruleset>` for a zone pair's ruleset.
const filterBase = (chain: RuleChain) => {
  const ruleset = rulesetName(chain);
  return ruleset === null
    ? ["firewall", "ipv4", chain, "filter"]
    : ["firewall", "ipv4", "name", ruleset];
};
const ruleBase = (chain: RuleChain, rule: number) => [...filterBase(chain), "rule", String(rule)];

/// One From/To list entry. `firewall` is the built-in endpoint for the box
/// itself — it writes no match node; its presence moves the rule into the
/// input (To) or output (From) chain. `address` and `ifgroup` are legacy —
/// kept so CLI-created rules stay editable, not offered for new selections.
export type EndpointEntry =
  | { kind: "interface"; name: string }
  /** A zone. Writes no match node of its own — like the Firewall endpoint, it
   *  picks where the rule lives: the ruleset bound to this side's zone pair.
   *  Aliases on the same side still narrow the match inside that ruleset. */
  | { kind: "zone"; name: string }
  | { kind: "alias"; type: AliasType; name: string }
  /** Inline value typed straight into the rule — an IPv4 host, network, or
   *  FQDN that isn't worth a named alias. Stored as a literal member of the
   *  side's auto group. */
  | { kind: "inline"; type: AliasType; value: string }
  | { kind: "firewall" }
  | { kind: "address"; address: string }
  | { kind: "ifgroup"; name: string };

/// A From/To selection: the entries the side matches (any of them, WatchGuard
/// style). Empty = Any.
export type EndpointSelection = EndpointEntry[];

const IPV4_OCTETS = (s: string) =>
  /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) &&
  s.split(".").every((o) => Number(o) <= 255 && String(Number(o)) === o);

/// Validate an inline From/To value. Returns an error message, or null when
/// the value is acceptable for its type.
export function validateInline(type: AliasType, value: string): string | null {
  const v = value.trim();
  if (!v) return "Enter a value.";
  switch (type) {
    case "host": {
      // Single IPv4 address or an a.b.c.d-e.f.g.h range (both valid
      // address-group members).
      const parts = v.split("-");
      if (parts.length > 2 || !parts.every(IPV4_OCTETS)) {
        return "Enter an IPv4 address like 192.168.1.10 (or a range like 192.168.1.10-192.168.1.20).";
      }
      return null;
    }
    case "network": {
      const m = v.match(/^(.+)\/(\d{1,2})$/);
      if (!m || !IPV4_OCTETS(m[1]) || Number(m[2]) > 32) {
        return "Enter an IPv4 network in CIDR form, like 192.168.1.0/24.";
      }
      return null;
    }
    case "fqdn": {
      if (!/^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]*[a-z0-9_])?\.)+[a-z]{2,}$/i.test(v)) {
        return "Enter a domain name like example.com.";
      }
      return null;
    }
    case "iface":
      // Interfaces are never typed inline — they're picked from the configured
      // list (rule form) or the alias editor. Reaching this is a UI bug.
      return "Pick interfaces from the list instead of typing them.";
  }
}

/// Expand a stored endpoint into its list form, resolving auto-managed OR
/// groups back into the aliases/interfaces they carry.
export function endpointToSelection(e: RuleEndpoint, autoGroups: AutoGroup[]): EndpointSelection {
  const out: EndpointEntry[] = [];

  if (e.group_type && e.group_name) {
    const type = GROUP_NODE_TO_TYPE[e.group_type];
    const auto = autoGroups.find((g) => g.node === e.group_type && g.name === e.group_name);
    if (type && auto) {
      for (const name of auto.includes) out.push({ kind: "alias", type, name });
      for (const value of auto.members) out.push({ kind: "inline", type, value });
    } else if (type) out.push({ kind: "alias", type, name: e.group_name });
  }
  if (e.iface) out.push({ kind: "interface", name: e.iface });
  if (e.iface_group) {
    const auto = autoGroups.find((g) => g.node === "interface-group" && g.name === e.iface_group);
    // A named (non-auto) interface-group is an interface alias — the user's or
    // one written on the CLI; either way the alias model covers it (its display
    // name falls back to the group name when it isn't a modeled alias).
    if (auto) for (const name of auto.interfaces) out.push({ kind: "interface", name });
    else out.push({ kind: "alias", type: "iface", name: e.iface_group });
  }
  if (e.address) out.push({ kind: "address", address: e.address });
  return out;
}

/// The From/To list for a rule side, including the synthetic entry implied by
/// where the rule lives: the Firewall endpoint for the input/output chains, or
/// the side's zone for a zone pair's ruleset. Neither is stored as a match node
/// — the rule's location is what expresses them.
/// `cfg` is required: a zone rule stores no zone match, so without it the
/// side would come back missing the zone it belongs to.
export function ruleSelection(
  rule: FirewallRule,
  side: "from" | "to",
  autoGroups: AutoGroup[],
  cfg: Pick<FirewallConfig, "zone_pairs" | "zones">,
): EndpointSelection {
  const sel = endpointToSelection(side === "from" ? rule.from : rule.to, autoGroups);
  if ((side === "to" && rule.chain === "input") || (side === "from" && rule.chain === "output")) {
    sel.unshift({ kind: "firewall" });
    return sel;
  }
  // A zone rule spans one scope per pair, so this side's zones are the distinct
  // src (or dst) across all of them — From [LAN, DMZ] To [WAN] is two scopes
  // whose srcs are LAN and DMZ.
  const names = new Set<string>();
  for (const scope of rule.scopes) {
    const pair = pairForChain(cfg.zone_pairs, scope.chain);
    if (pair) names.add(side === "from" ? pair.src : pair.dst);
  }
  // The local zone is the firewall itself — show it as the Firewall endpoint
  // rather than as a zone, so both ways of reaching the box read the same.
  const entries = [...names].map((name): EndpointEntry =>
    cfg.zones.find((z) => z.name === name)?.local ? { kind: "firewall" } : { kind: "zone", name },
  );
  sel.unshift(...entries);
  return sel;
}

/// The zones a side resolves to. The Firewall endpoint resolves to the local
/// zone, because that's what VyOS calls the box itself.
function sideZones(sel: EndpointSelection, zones: FirewallZone[]): string[] {
  const named = sel.filter((e) => e.kind === "zone").map((e) => (e as { name: string }).name);
  if (named.length > 0) return [...new Set(named)];
  if (sel.some((e) => e.kind === "firewall")) {
    const local = localZone(zones);
    return local ? [local.name] : [];
  }
  return [];
}

/// The zone pairs a rule with these sides spans — the cross product of its From
/// and To zones — or an empty list when neither side names a zone (an ordinary
/// base-chain rule).
///
/// VyOS has no way to OR zone pairs, so a rule From [LAN, DMZ] To [WAN] is two
/// pairs, and gets written once into each pair's ruleset (see
/// FirewallRule.scopes).
///
/// Throws when the sides describe something VyOS can't express — a zone on one
/// side only, or a zone appearing on both sides.
export function zonePairsFor(
  from: EndpointSelection,
  to: EndpointSelection,
  zones: FirewallZone[] = [],
): ZonePair[] {
  const namesZone = (sel: EndpointSelection) => sel.some((e) => e.kind === "zone");
  if (!namesZone(from) && !namesZone(to)) return [];

  // A zone on one side needs a zone (or the Firewall, which is the local zone)
  // on the other — there's nowhere to put a zone-to-anywhere rule.
  const srcs = sideZones(from, zones);
  const dsts = sideZones(to, zones);
  if (srcs.length === 0 || dsts.length === 0) {
    const emptySide = srcs.length === 0 ? from : to;
    if (emptySide.some((e) => e.kind === "firewall")) {
      throw new Error("Set a Firewall zone on the Zones page first — a zone rule to or from the firewall needs one.");
    }
    throw new Error(
      `Pick a zone for ${srcs.length === 0 ? "From" : "To"} too. A zone rule always goes from one zone to another.`,
    );
  }
  const both = srcs.filter((s) => dsts.includes(s));
  if (both.length > 0) {
    throw new Error(
      `${both.join(", ")} is on both sides of this rule. Traffic inside a zone is controlled by its intra-zone filtering, on the Zones page.`,
    );
  }
  return srcs.flatMap((src) => dsts.map((dst) => ({ src, dst, ruleset: pairRuleset(src, dst) })));
}

/// Where a rule with these sides lives — a base chain, or the ruleset bound to
/// its zone pair.
///
/// `zones` is optional so callers that predate zones keep working; without it a
/// zone entry can't be resolved and is rejected.
/// Every scope a rule with these sides occupies — one base chain, or one
/// ruleset per zone pair. `ruleChainFor` is the representative (first) scope.
export function ruleChainsFor(
  from: EndpointSelection,
  to: EndpointSelection,
  zones: FirewallZone[] = [],
): RuleChain[] {
  const f = from.some((e) => e.kind === "firewall");
  const t = to.some((e) => e.kind === "firewall");
  if (f && t) throw new Error("Only one side of a rule can be the Firewall itself.");
  const pairs = zonePairsFor(from, to, zones);
  if (pairs.length > 0) {
    // Sorted so the representative scope matches what groupZoneRules picks on
    // the way back in.
    return pairs.map((p) => zoneRuleChain(p.ruleset)).sort((a, b) => a.localeCompare(b));
  }
  return [t ? "input" : f ? "output" : "forward"];
}

export function ruleChainFor(
  from: EndpointSelection,
  to: EndpointSelection,
  zones: FirewallZone[] = [],
): RuleChain {
  return ruleChainsFor(from, to, zones)[0];
}

/// A rule's traffic match: a policy (port-group + protocol) or the built-in
/// Ping policy (protocol icmp — port-groups can't express ICMP).
export type RulePolicyChoice =
  | { kind: "policy"; name: string; protocol: PolicyProtocol }
  | { kind: "ping" };

/// Desired filter rule. The rule number is fixed here — ordering is changed
/// by drag-reorder, not by editing. The chain is implied by which side (if
/// any) carries the Firewall endpoint.
export interface RuleUpdate {
  rule: number;
  name: string | null;
  action: RuleAction;
  from: EndpointSelection;
  to: EndpointSelection;
  /** Traffic match, or null = any port/protocol. */
  policy: RulePolicyChoice | null;
  enabled: boolean;
  /** Log matches so they show in the Traffic Monitor. */
  log: boolean;
  /** Inspect matches with the IPS engine (only meaningful on Allow rules —
   *  see FirewallRule.ips). */
  ips: boolean;
}

/// Shared allocation context for both sides of a rule diff.
interface AutoCtx {
  autoGroups: AutoGroup[];
  /** Group names already in use (grows as new auto names are allocated). */
  taken: Set<string>;
}

/// A fresh, readable auto-group name. Names carry the rule number only as a
/// label — reorders don't rename groups, so collisions are avoided by suffix.
function allocAutoName(rule: number, side: "source" | "destination", taken: Set<string>): string {
  const base = `QZ-R${rule}-${side === "source" ? "FROM" : "TO"}`;
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  taken.add(name);
  return name;
}

/// Create/update an auto group's member leaf and delete stale members.
function diffAutoMembers(
  out: VyosCommand[],
  node: string,
  name: string,
  leaf: "include" | "interface",
  liveMembers: string[] | null,
  desired: string[],
): void {
  const gp = ["firewall", "group", node, name];
  if (liveMembers === null) out.push({ op: "set", path: [...gp, "description", AUTO_MARK] });
  for (const m of desired) if (!liveMembers?.includes(m)) out.push({ op: "set", path: [...gp, leaf, m] });
  for (const m of liveMembers ?? []) if (!desired.includes(m)) out.push({ op: "delete", path: [...gp, leaf, m] });
}

/// Create/update an alias-side auto group: alias includes plus literal
/// members (inline hosts/networks/FQDNs) in one group.
function diffAliasAutoGroup(
  out: VyosCommand[],
  node: string,
  name: string,
  live: AutoGroup | null,
  includes: string[],
  members: string[],
): void {
  const gp = ["firewall", "group", node, name];
  const leaf = AUTO_MEMBER_LEAF[node];
  if (live === null) out.push({ op: "set", path: [...gp, "description", AUTO_MARK] });
  for (const m of includes) if (!live?.includes.includes(m)) out.push({ op: "set", path: [...gp, "include", m] });
  for (const m of live?.includes ?? []) if (!includes.includes(m)) out.push({ op: "delete", path: [...gp, "include", m] });
  for (const v of members) if (!live?.members.includes(v)) out.push({ op: "set", path: [...gp, leaf, v] });
  for (const v of live?.members ?? []) if (!members.includes(v)) out.push({ op: "delete", path: [...gp, leaf, v] });
}

/// The match a rule side resolves to, as written on the rule itself.
///
/// Kept separate from the groups backing it: a rule spanning several zone pairs
/// exists once per pair, so these refs are written into each pair's copy while
/// the groups they point at are created once.
interface EndpointDesired {
  node: string | null;
  name: string | null;
  addr: string | null;
  iface: string | null;
  ifGroup: string | null;
}

/// Resolve a side's selection into the match it writes, emitting the
/// auto-group commands that back it. Emit once per rule, not per scope.
function planEndpoint(
  out: VyosCommand[],
  rule: number,
  side: "source" | "destination",
  live: RuleEndpoint | null,
  selIn: EndpointSelection,
  ctx: AutoCtx,
): EndpointDesired {
  // Neither the Firewall endpoint nor a zone writes a match node — both are
  // expressed by where the rule lives (its chain, or its pair's ruleset).
  const sel = selIn.filter((e) => e.kind !== "firewall" && e.kind !== "zone");
  const findAuto = (node: string | null, name: string | null) =>
    (node && name && ctx.autoGroups.find((g) => g.node === node && g.name === name)) || null;

  // Interface aliases live in the rule-level interface slot, not the
  // source/destination group ref — split them off before the family logic.
  // (Explicit predicates: TS doesn't infer one for compound conditions.)
  type AliasEntry = Extract<EndpointEntry, { kind: "alias" }>;
  const ifaceAliases = sel.filter((e): e is AliasEntry => e.kind === "alias" && e.type === "iface");

  // ── aliases & inline values: a single alias → direct group ref; anything
  //    else → auto OR group carrying alias includes and/or literal members.
  const aliases = sel.filter((e): e is AliasEntry => e.kind === "alias" && e.type !== "iface");
  const inline = sel.filter((e) => e.kind === "inline");
  const types = new Set([...aliases.map((a) => a.type), ...inline.map((i) => i.type)]);
  if (types.size > 1) throw new Error("From/To entries must all be of the same type (host, network, or FQDN).");
  const aliasType = aliases[0]?.type ?? inline[0]?.type ?? null;
  if (aliasType === "fqdn" && aliases.length > 0 && aliases.length + inline.length > 1) {
    throw new Error("An FQDN alias stands alone — VyOS domain groups don't support includes.");
  }
  for (const i of inline) {
    const err = validateInline(i.type, i.value);
    if (err) throw new Error(err);
  }

  const liveAuto = findAuto(live?.group_type ?? null, live?.group_name ?? null);

  let desiredNode: string | null = null;
  let desiredName: string | null = null;
  if (aliasType !== null) {
    desiredNode = ALIAS_GROUP[aliasType].node;
    if (aliases.length === 1 && inline.length === 0) {
      desiredName = aliases[0].name;
    } else {
      // Reuse the side's existing auto group while its type still matches.
      const reuse = liveAuto !== null && liveAuto.node === desiredNode;
      desiredName = reuse ? liveAuto!.name : allocAutoName(rule, side, ctx.taken);
      diffAliasAutoGroup(
        out,
        desiredNode,
        desiredName,
        reuse ? liveAuto : null,
        aliases.map((a) => a.name),
        inline.map((i) => i.value.trim()),
      );
    }
  }
  // A live auto group this side no longer references is deleted outright.
  if (liveAuto && liveAuto.name !== desiredName) {
    out.push({ op: "delete", path: ["firewall", "group", liveAuto.node, liveAuto.name] });
  }

  // ── literal address (legacy).
  const addrEntry = sel.find((e) => e.kind === "address");
  const desiredAddr = addrEntry?.address.trim() || null;

  // ── interfaces: an interface alias → `group <alias>` (it stands alone — the
  //    pinned rolling XML isn't verified to support interface-group include, so
  //    an alias can't be OR'd with more interfaces); one plain interface →
  //    `name <if>`; several → auto interface-group; a legacy ifgroup entry
  //    keeps its `group <g>` form.
  const ifaces = sel.filter((e) => e.kind === "interface").map((e) => e.name.trim()).filter(Boolean);
  const namedIfGroup =
    ifaceAliases[0]?.name ?? sel.find((e) => e.kind === "ifgroup")?.name ?? null;
  if (namedIfGroup !== null && (ifaceAliases.length + sel.filter((e) => e.kind === "ifgroup").length > 1 || ifaces.length > 0)) {
    throw new Error(
      "An interface alias stands alone on its side — add interfaces to the alias itself, or list individual interfaces instead.",
    );
  }
  const liveIfAuto = findAuto(live?.iface_group ? "interface-group" : null, live?.iface_group ?? null);

  let desiredIface: string | null = null;
  let desiredIfGroup: string | null = null;
  if (namedIfGroup !== null) {
    desiredIfGroup = namedIfGroup;
  } else if (ifaces.length === 1) {
    desiredIface = ifaces[0];
  } else if (ifaces.length > 1) {
    desiredIfGroup = liveIfAuto ? liveIfAuto.name : allocAutoName(rule, side, ctx.taken);
    diffAutoMembers(out, "interface-group", desiredIfGroup, "interface", liveIfAuto ? liveIfAuto.interfaces : null, ifaces);
  }
  if (liveIfAuto && liveIfAuto.name !== desiredIfGroup) {
    out.push({ op: "delete", path: ["firewall", "group", "interface-group", liveIfAuto.name] });
  }

  return { node: desiredNode, name: desiredName, addr: desiredAddr, iface: desiredIface, ifGroup: desiredIfGroup };
}

/// Write a side's resolved match into one scope's rule. `live` is that scope's
/// current match, or null for a scope the rule is only now landing in (every
/// copy of a rule is written identically, so the representative's match is a
/// sound baseline to diff against).
function endpointWrites(
  out: VyosCommand[],
  base: string[],
  side: "source" | "destination",
  live: RuleEndpoint | null,
  d: EndpointDesired,
): void {
  const liveType = live?.group_type ?? null;
  const liveName = live?.group_name ?? null;
  const refChanged = liveType !== d.node || liveName !== d.name;
  if (liveType && refChanged) out.push({ op: "delete", path: [...base, side, "group", liveType] });
  if (d.node && d.name && refChanged) {
    out.push({ op: "set", path: [...base, side, "group", d.node, d.name] });
  }

  const liveAddr = live?.address ?? null;
  if (d.addr !== liveAddr) {
    if (d.addr !== null) out.push({ op: "set", path: [...base, side, "address", d.addr] });
    else out.push({ op: "delete", path: [...base, side, "address"] });
  }

  // The interface match node holds either `name <if>` or `group <g>`.
  const liveIface = live?.iface ?? null;
  const liveIfGroup = live?.iface_group ?? null;
  if (d.iface !== liveIface || d.ifGroup !== liveIfGroup) {
    const key = IFACE_NODE[side];
    if (liveIface !== null || liveIfGroup !== null) out.push({ op: "delete", path: [...base, key] });
    if (d.iface !== null) out.push({ op: "set", path: [...base, key, "name", d.iface] });
    else if (d.ifGroup !== null) out.push({ op: "set", path: [...base, key, "group", d.ifGroup] });
  }
}

/// Seed safety defaults into a non-forward chain the first time a rule lands
/// there. Rule 1 accepts established/related (so a broad deny can't cut off
/// reply traffic of allowed or firewall-originated connections), rule 2
/// accepts loopback (the WebUI reaches the VyOS API over lo), and
/// default-action is pinned to accept so defining the chain can't lock the
/// box out on its own.
function ensureChainSetup(out: VyosCommand[], chain: "input" | "output", cfg: FirewallConfig): void {
  const setup = cfg.setup[chain];
  const fb = filterBase(chain);
  if (!setup.baseline) {
    const r1 = [...fb, "rule", "1"];
    out.push({ op: "set", path: [...r1, "action", "accept"] });
    out.push({ op: "set", path: [...r1, "state", "established"] });
    out.push({ op: "set", path: [...r1, "state", "related"] });
    out.push({ op: "set", path: [...r1, "description", `${SYS_MARK} allow established/related replies`] });
    const r2 = [...fb, "rule", "2"];
    const ifNode = chain === "input" ? IFACE_NODE.source : IFACE_NODE.destination;
    out.push({ op: "set", path: [...r2, "action", "accept"] });
    out.push({ op: "set", path: [...r2, ifNode, "name", "lo"] });
    out.push({ op: "set", path: [...r2, "description", `${SYS_MARK} allow loopback (WebUI/API)`] });
  }
  if (setup.default_action === null) {
    out.push({ op: "set", path: [...fb, "default-action", "accept"] });
  }
}

/// Seed the hidden two-rule baseline at the top of the forward chain (once):
/// rule 1 queues every packet of IPS-marked connections to the engine (both
/// directions — see IPS_CONNMARK), rule 2 accepts established/related. Logged
/// rules then only ever see each connection's first packet — one monitor line
/// per connection instead of one per packet — and replies of accepted flows
/// can't be cut off mid-connection by a later deny.
function ensureForwardBaseline(out: VyosCommand[], cfg: FirewallConfig): void {
  if (cfg.setup.forward.baseline) return;
  const fb = filterBase("forward");
  ipsFlowRuleCommands(out, fb);
  const r2 = [...fb, "rule", "2"];
  out.push({ op: "set", path: [...r2, "action", "accept"] });
  out.push({ op: "set", path: [...r2, "state", "established"] });
  out.push({ op: "set", path: [...r2, "state", "related"] });
  out.push({ op: "set", path: [...r2, "description", `${SYS_MARK} allow established/related replies`] });
}

/// Commands writing the hidden IPS flow rule at rule 1 of a chain.
function ipsFlowRuleCommands(out: VyosCommand[], fb: string[]): void {
  const r1 = [...fb, "rule", "1"];
  out.push({ op: "set", path: [...r1, "action", "queue"] });
  out.push({ op: "set", path: [...r1, "queue", "0"] });
  out.push({ op: "set", path: [...r1, "queue-options", "bypass"] });
  out.push({ op: "set", path: [...r1, "connection-mark", String(IPS_CONNMARK)] });
  out.push({ op: "set", path: [...r1, "description", `${SYS_MARK} IPS: inspect flows selected by IPS rules`] });
}

/// Make sure the forward chain inspects whole flows for IPS rules, upgrading
/// the pre-connmark baseline layout (rule 1 = established accept, no flow
/// rule) in place when the low rule numbers are ours to rebuild. Chains where
/// slots 1/2 hold CLI-created user rules are left alone rather than clobbered
/// — IPS there degrades to first-packet-only inspection.
function ensureIpsFlowBaseline(out: VyosCommand[], cfg: FirewallConfig): void {
  const setup = cfg.setup.forward;
  if (setup.ips_flow) return;
  // Already emitted into this batch (e.g. several rules toggled at once).
  if (out.some((c) => String(c.path[c.path.length - 1]).startsWith(`${SYS_MARK} IPS:`))) return;
  if (!setup.baseline) {
    ensureForwardBaseline(out, cfg);
    return;
  }
  if (cfg.rules.some((r) => r.chain === "forward" && (r.rule === 1 || r.rule === 2))) return;
  const fb = filterBase("forward");
  // Old layout: rule 1 is the sys-marked established/related accept. Rebuild
  // it as the flow rule and move the established accept to rule 2.
  out.push({ op: "delete", path: [...fb, "rule", "1"] });
  ipsFlowRuleCommands(out, fb);
  const r2 = [...fb, "rule", "2"];
  out.push({ op: "set", path: [...r2, "action", "accept"] });
  out.push({ op: "set", path: [...r2, "state", "established"] });
  out.push({ op: "set", path: [...r2, "state", "related"] });
  out.push({ op: "set", path: [...r2, "description", `${SYS_MARK} allow established/related replies`] });
}

/// Tear down a zone pair whose last rule is going away: the `from` binding and
/// the ruleset it points at. An empty bound ruleset isn't harmless — VyOS would
/// keep jumping into it, and a pair that exists but matches nothing reads as
/// "configured" on the Zones page while behaving as if it weren't.
///
/// `removing` are the rules being deleted in this same commit.
/// `vacating` are the rule numbers leaving this scope in the same commit.
function emptyPairCleanup(cfg: FirewallConfig, chain: RuleChain, vacating: number[]): VyosCommand[] {
  const pair = pairForChain(cfg.zone_pairs, chain);
  if (!pair) return [];
  const gone = new Set(vacating);
  // Any rule still occupying this scope keeps the pair alive. A rule occupies a
  // scope when that scope is among its own — checking `r.chain` alone would
  // miss the other pairs of a multi-zone rule.
  const left = cfg.rules.some(
    (r) => !gone.has(r.rule) && r.scopes.some((s) => s.chain === chain),
  );
  if (left) return [];
  return [
    { op: "delete", path: ["firewall", "zone", pair.dst, "from", pair.src] },
    { op: "delete", path: ["firewall", "ipv4", "name", pair.ruleset] },
  ];
}

/// Deletes for the auto-managed OR groups backing a rule's sides (auto groups
/// are per-side, so no other rule references them).
function autoGroupDeletes(rule: FirewallRule, autoGroups: AutoGroup[]): VyosCommand[] {
  const out: VyosCommand[] = [];
  for (const e of [rule.from, rule.to]) {
    const refs = [
      e.group_type && e.group_name ? { node: e.group_type, name: e.group_name } : null,
      e.iface_group ? { node: "interface-group", name: e.iface_group } : null,
    ];
    for (const ref of refs) {
      if (ref && autoGroups.some((g) => g.node === ref.node && g.name === ref.name)) {
        out.push({ op: "delete", path: ["firewall", "group", ref.node, ref.name] });
      }
    }
  }
  return out;
}

/// Bind a zone pair, seeding its ruleset and the global state match on first
/// use. The `from` binding is what makes VyOS jump into the ruleset at all —
/// without it the rules would sit in the config doing nothing.
///
/// The pair is passed in rather than parsed back out of the ruleset name: zone
/// names can contain hyphens, so `QZ-Z-LAN-TO-X-TO-WAN` is genuinely ambiguous
/// (LAN-TO-X → WAN, or LAN → X-TO-WAN?) and guessing would silently bind the
/// wrong pair.
/// State policy is seeded separately (once per commit, not once per pair).
function ensureZonePair(out: VyosCommand[], cfg: FirewallConfig, pair: ZonePair): void {
  if (cfg.zone_pairs.some((p) => p.ruleset === pair.ruleset)) return;
  const base = ["firewall", "ipv4", "name", pair.ruleset];
  out.push({ op: "set", path: [...base, "description", `${AUTO_MARK} ${pair.src} to ${pair.dst}`] });
  out.push({ op: "set", path: ["firewall", "zone", pair.dst, "from", pair.src, "firewall", "name", pair.ruleset] });
}

export function diffRule(liveIn: FirewallRule | null, u: RuleUpdate, cfg: FirewallConfig): VyosCommand[] {
  const pairs = zonePairsFor(u.from, u.to, cfg.zones);
  const chains = ruleChainsFor(u.from, u.to, cfg.zones);
  const chain = chains[0];
  const out: VyosCommand[] = [];

  let live = liveIn;
  let rule = u.rule;

  // Switching a rule between a base chain and zone pairs (or between base
  // chains) can't be edited in place: rule numbers are only unique per scope,
  // so the target may already have this number. Drop every copy — with its auto
  // groups — and rebuild at a fresh number. Changing only *which* pairs a zone
  // rule spans keeps its number: zone rule numbers are allocated across all
  // scopes at once, so they can't collide in a pair it moves into.
  const liveIsZone = live !== null && !isBaseChain(live.chain);
  const wantZone = pairs.length > 0;
  const baseMoved = live !== null && !liveIsZone && !wantZone && live.chain !== chain;
  if (live && (liveIsZone !== wantZone || baseMoved)) {
    for (const s of live.scopes) {
      out.push({ op: "delete", path: ruleBase(s.chain, live.rule) });
      out.push(...emptyPairCleanup(cfg, s.chain, [live.rule]));
    }
    out.push(...autoGroupDeletes(live, cfg.auto_groups));
    live = null;
    rule = nextRuleNumber(cfg.rules);
  }

  // ── scope set: keep, add, drop.
  const liveChains = live?.scopes.map((s) => s.chain) ?? [];
  for (const c of liveChains) {
    if (chains.includes(c)) continue;
    out.push({ op: "delete", path: ruleBase(c, rule) });
    out.push(...emptyPairCleanup(cfg, c, [rule]));
  }
  if (wantZone) {
    // Zones only filter reply traffic correctly with the global state match.
    ensureStatePolicy(out, cfg);
    for (const p of pairs) ensureZonePair(out, cfg, p);
  } else if (isBaseChain(chain) && chain !== "forward") {
    ensureChainSetup(out, chain, cfg);
  }

  // A scope the rule already occupies diffs against its live body; one it's
  // landing in is written in full. Every copy is written identically, so the
  // representative's body is the baseline for all of them.
  const added = chains.filter((c) => !liveChains.includes(c));
  const bodyLive = (c: RuleChain): FirewallRule | null => (added.includes(c) ? null : live);

  const base = ruleBase(chain, rule);
  const leaf = (sub: string[], liveOf: (r: FirewallRule | null) => string | null, desiredRaw: string | null) => {
    const desired = desiredRaw?.trim() || null;
    for (const c of chains) {
      const liveV = liveOf(bodyLive(c));
      if (desired === liveV) continue;
      const b = ruleBase(c, rule);
      if (desired !== null) out.push({ op: "set", path: [...b, ...sub, desired] });
      else if (liveV !== null) out.push({ op: "delete", path: [...b, ...sub] });
    }
  };

  // IPS-inspected Allow rules are stored as `action queue`: matches are queued
  // to Suricata for the inline accept/drop verdict. `queue 0` names the
  // NFQUEUE the IPS engine listens on; `queue-options bypass` fails open so
  // traffic still flows if Suricata is down. `set connection-mark` tags the
  // flow so the hidden flow rule keeps queueing its later packets (both
  // directions) — content signatures need more than the first packet.
  const wantIps = u.ips && u.action === "accept";
  const wireAction = (r: FirewallRule | null) =>
    r == null || r.action === null ? null : r.ips ? "queue" : r.action;
  leaf(["action"], wireAction, wantIps ? "queue" : u.action);
  for (const c of chains) {
    const l = bodyLive(c);
    const liveIps = l?.ips ?? false;
    const b = ruleBase(c, rule);
    if (wantIps && !liveIps) {
      out.push({ op: "set", path: [...b, "queue", "0"] });
      out.push({ op: "set", path: [...b, "queue-options", "bypass"] });
      out.push({ op: "set", path: [...b, "set", "connection-mark", String(IPS_CONNMARK)] });
    } else if (!wantIps && liveIps) {
      out.push({ op: "delete", path: [...b, "queue"] });
      out.push({ op: "delete", path: [...b, "queue-options"] });
      out.push({ op: "delete", path: [...b, "set", "connection-mark"] });
    }
  }
  // The connmark flow rule lives in the forward chain regardless of where the
  // IPS rule itself sits: a zone rule queues its first packet at priority 1 and
  // marks the flow, and the forward baseline at priority 0 then queues the rest.
  if (wantIps && !(live?.ips ?? false)) ensureIpsFlowBaseline(out, cfg);
  leaf(["description"], (r) => r?.name ?? null, u.name);

  const ctx: AutoCtx = { autoGroups: cfg.auto_groups, taken: new Set(cfg.group_names) };
  // Groups are shared by every copy of the rule, so they're planned once; only
  // the refs pointing at them are written per scope.
  const fromDesired = planEndpoint(out, rule, "source", live?.from ?? null, u.from, ctx);
  const toDesired = planEndpoint(out, rule, "destination", live?.to ?? null, u.to, ctx);
  for (const c of chains) {
    const l = bodyLive(c);
    const b = ruleBase(c, rule);
    endpointWrites(out, b, "source", l?.from ?? null, fromDesired);
    endpointWrites(out, b, "destination", l?.to ?? null, toDesired);
  }

  // Policy = destination port-group + matching protocol leaf; built-in Ping
  // is just the protocol leaf.
  const newPolicy = u.policy?.kind === "policy" ? u.policy.name : null;
  if (newPolicy !== null && !cfg.policies.some((p) => p.name === newPolicy)) {
    // First use of a built-in policy seeds its port-group (once, not per scope).
    const builtin = BUILTIN_POLICIES[newPolicy];
    if (builtin) {
      const gp = policyBase(newPolicy);
      out.push({ op: "set", path: [...gp, "description", encodePolicyDescription(builtin.protocol, "Built-in")] });
      for (const port of builtin.ports) out.push({ op: "set", path: [...gp, "port", port] });
    }
  }
  for (const c of chains) {
    const livePolicy = bodyLive(c)?.policy ?? null;
    if (newPolicy === livePolicy) continue;
    const b = ruleBase(c, rule);
    if (livePolicy !== null && newPolicy === null) {
      out.push({ op: "delete", path: [...b, "destination", "group", "port-group"] });
    }
    if (newPolicy !== null) {
      out.push({ op: "set", path: [...b, "destination", "group", "port-group", newPolicy] });
    }
  }
  const desiredProtocol = u.policy === null ? null : u.policy.kind === "policy" ? u.policy.protocol : "icmp";
  leaf(["protocol"], (r) => r?.protocol ?? null, desiredProtocol);

  // Enabled state — VyOS models "off" as a valueless `disable` leaf.
  for (const c of chains) {
    const liveEnabled = bodyLive(c)?.enabled ?? true;
    if (u.enabled === liveEnabled) continue;
    const b = ruleBase(c, rule);
    if (u.enabled) out.push({ op: "delete", path: [...b, "disable"] });
    else out.push({ op: "set", path: [...b, "disable"] });
  }

  // Traffic logging — a valueless `log` leaf; matches then reach the Traffic
  // Monitor through the kernel log.
  for (const c of chains) {
    const liveLog = bodyLive(c)?.log ?? false;
    if (u.log === liveLog) continue;
    const b = ruleBase(c, rule);
    if (u.log) out.push({ op: "set", path: [...b, "log"] });
    else out.push({ op: "delete", path: [...b, "log"] });
  }
  if (u.log && chain === "forward") ensureForwardBaseline(out, cfg);

  return out;
}

/// Apply a desired rule. Returns the number of changes applied.
export function applyRule(live: FirewallRule | null, update: RuleUpdate, cfg: FirewallConfig): Promise<number> {
  return commitAndSave(diffRule(live, update, cfg));
}

/// Commands toggling IPS inspection on an existing Allow rule (see
/// FirewallRule.ips). Empty when nothing would change or the rule isn't an
/// Allow rule.
export function ipsRuleCommands(rule: FirewallRule, enabled: boolean, cfg: FirewallConfig): VyosCommand[] {
  if (rule.action !== "accept" || rule.ips === enabled) return [];
  const out: VyosCommand[] = [];
  // Every copy of the rule has to be toggled, or the pairs would disagree.
  for (const s of rule.scopes) {
    const base = ruleBase(s.chain, rule.rule);
    if (enabled) {
      out.push({ op: "set", path: [...base, "action", "queue"] });
      out.push({ op: "set", path: [...base, "queue", "0"] });
      out.push({ op: "set", path: [...base, "queue-options", "bypass"] });
      out.push({ op: "set", path: [...base, "set", "connection-mark", String(IPS_CONNMARK)] });
    } else {
      out.push({ op: "set", path: [...base, "action", "accept"] });
      out.push({ op: "delete", path: [...base, "queue"] });
      out.push({ op: "delete", path: [...base, "queue-options"] });
      out.push({ op: "delete", path: [...base, "set", "connection-mark"] });
    }
  }
  // The connmark flow rule lives in the forward chain wherever the IPS rule
  // sits — a zone rule marks the flow at priority 1, the forward baseline at
  // priority 0 queues the rest of it.
  if (enabled) ensureIpsFlowBaseline(out, cfg);
  return out;
}

/// Toggle IPS inspection on one or more rules. Returns the number of changes.
export function applyRuleIps(
  changes: { rule: FirewallRule; enabled: boolean }[],
  cfg: FirewallConfig,
): Promise<number> {
  // The flow-baseline commands are idempotent sets — safe to emit per change.
  return commitAndSave(changes.flatMap((c) => ipsRuleCommands(c.rule, c.enabled, cfg)));
}

/// Delete a filter rule, along with the auto-managed OR groups backing its
/// sides and — when it was the last rule of a zone pair — the pair binding and
/// its ruleset. `extraCommands` ride the same commit — used by the delete
/// cascade to drop the security-feature config that referenced this rule
/// atomically with it (see lib/rule-cascade).
export function deleteRule(
  rule: FirewallRule,
  autoGroups: AutoGroup[],
  extraCommands: VyosCommand[] = [],
  cfg?: FirewallConfig,
): Promise<number> {
  // A zone rule exists once per pair — deleting only the representative would
  // leave the other copies enforcing.
  const out: VyosCommand[] = [];
  for (const s of rule.scopes) {
    out.push({ op: "delete", path: ruleBase(s.chain, rule.rule) });
    if (cfg) out.push(...emptyPairCleanup(cfg, s.chain, [rule.rule]));
  }
  out.push(...autoGroupDeletes(rule, autoGroups));
  out.push(...extraCommands);
  return commitAndSave(out);
}

/// Rule number for a newly created rule: appended after the last one. The max
/// spans all chains so a new rule sorts to the bottom of the merged table
/// (numbers only have to be unique within a chain).
export function nextRuleNumber(rules: FirewallRule[]): number {
  const max = rules.reduce((m, r) => Math.max(m, r.rule), 0);
  return max + 10;
}

// ── writes: reorder ───────────────────────────────────────────────────────────

/// Serialize a raw config subtree back into `set` commands. Used to rebuild a
/// rule at a new number without losing leaves this UI doesn't model.
function cfgToCommands(base: string[], cfg: Cfg, out: VyosCommand[]): void {
  const entries = Object.entries(cfg);
  if (entries.length === 0) {
    out.push({ op: "set", path: base });
    return;
  }
  for (const [k, v] of entries) {
    if (typeof v === "string") {
      if (v === "") out.push({ op: "set", path: [...base, k] });
      else out.push({ op: "set", path: [...base, k, v] });
    } else if (typeof v === "number" || typeof v === "boolean") {
      out.push({ op: "set", path: [...base, k, String(v)] });
    } else if (Array.isArray(v)) {
      for (const item of v) out.push({ op: "set", path: [...base, k, String(item)] });
    } else if (v && typeof v === "object") {
      cfgToCommands([...base, k], v as Cfg, out);
    } else {
      out.push({ op: "set", path: [...base, k] });
    }
  }
}

/// The rules whose number changes to match the given display order (position ×
/// 10), and the number each moves to. One target per UI rule — a rule spanning
/// several zone pairs keeps one number across all of them, so its position is
/// what decides, not the position of any individual copy.
function renumberTargets(orderedRules: FirewallRule[]): { rule: FirewallRule; target: number }[] {
  return orderedRules
    .map((rule, i) => ({ rule, target: (i + 1) * 10 }))
    .filter(({ rule, target }) => rule.rule !== target);
}

/// How many rules a reorder would renumber.
export const renumberedCount = (orderedRules: FirewallRule[]) => renumberTargets(orderedRules).length;

/// Old rule number → new number, for features that key on the number alone
/// (App Control bindings). Rule numbers are handed out across every scope at
/// once (nextRuleNumber), so the number identifies a rule on its own.
export function renumberByRule(orderedRules: FirewallRule[]): Map<number, number> {
  return new Map(renumberTargets(orderedRules).map(({ rule, target }) => [rule.rule, target]));
}

/// Where each moved rule's config rules end up, keyed `${chain}:${from}` → new
/// number — one entry per scope, so a multi-zone rule contributes one per pair.
/// Single source of truth for both the renumber commands and the cascade that
/// repoints security-feature references at the new numbers (see
/// lib/rule-cascade), which looks rules up by that same scope key.
export function renumberMap(orderedRules: FirewallRule[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const { rule, target } of renumberTargets(orderedRules)) {
    for (const s of rule.scopes) m.set(`${s.chain}:${rule.rule}`, target);
  }
  return m;
}

/// Renumber rules to match the given display order. Rules whose number already
/// matches are untouched; moved rules are deleted first (so a target number
/// freed by another move is safe to reuse), then rebuilt from their raw config
/// subtree. Deletes and sets stay globally phased across every scope, which is
/// what makes two rules swapping numbers safe.
export function reorderCommands(orderedRules: FirewallRule[]): VyosCommand[] {
  const deletes: VyosCommand[] = [];
  const sets: VyosCommand[] = [];
  for (const { rule, target } of renumberTargets(orderedRules)) {
    // Each copy is rebuilt from its own raw subtree, at the shared new number.
    for (const s of rule.scopes) {
      deletes.push({ op: "delete", path: ruleBase(s.chain, rule.rule) });
      cfgToCommands(ruleBase(s.chain, target), s.raw, sets);
    }
  }
  return [...deletes, ...sets];
}

/// Per-scope (chain, old number) → new number moves of a reorder, in the shape
/// the Traffic Flow attribution remap takes. Exported for tests.
export function attributionMoves(orderedRules: FirewallRule[]): AttributionMove[] {
  const out: AttributionMove[] = [];
  for (const { rule, target } of renumberTargets(orderedRules)) {
    for (const s of rule.scopes) out.push({ chain: s.chain, from: rule.rule, to: target });
  }
  return out;
}

/// Apply a new rule order. `extraCommands` ride the same commit — used by the
/// reorder cascade to repoint security-feature config at the new rule numbers
/// atomically with the renumber. Returns the number of rules renumbered.
export async function applyRuleOrder(
  orderedRules: FirewallRule[],
  extraCommands: VyosCommand[] = [],
): Promise<number> {
  // Rules, not config rules — a multi-zone rule moving is one renumber to the
  // user, however many pairs it spans.
  const renumbered = renumberedCount(orderedRules);
  const commands = [...reorderCommands(orderedRules), ...extraCommands];
  if (commands.length > 0) {
    await commitAndSave(commands);
    // Re-point the Traffic Flow attribution cache at the new numbers.
    // Best-effort: attribution is a display concern; a failure here must not
    // read as a failed reorder (the config commit already succeeded).
    remapFlowAttribution(attributionMoves(orderedRules)).catch(() => {});
  }
  return renumbered;
}

// ── writes: default action ────────────────────────────────────────────────────

/// Why the forward default-action can't be set to drop, or null when it can.
///
/// The zone chains hook at priority 1, i.e. after the forward chain at priority
/// 0. Traffic dropped there never reaches them, so a deny default would
/// black-hole every zone rule's traffic while the Zones page still showed the
/// rules as allowing it. Zones express their own denial through each zone's
/// default-action instead.
export function defaultDropBlockedReason(cfg: FirewallConfig): string | null {
  if (cfg.zones.length === 0) return null;
  return "Zones are configured. Deny by default is set per zone on the Zones page — denying here would block all zone traffic before any zone rule is consulted.";
}

/// Set `firewall ipv4 forward filter default-action` (what happens to traffic
/// no rule matches). Setting drop first seeds the hidden established/related
/// baseline — without it a deny default would cut off the reply half of every
/// connection already allowed out.
export function setDefaultAction(cfg: FirewallConfig, action: "accept" | "drop"): Promise<number> {
  const out: VyosCommand[] = [];
  if (action === "drop") {
    const blocked = defaultDropBlockedReason(cfg);
    if (blocked) throw new Error(blocked);
    ensureForwardBaseline(out, cfg);
  }
  out.push({ op: "set", path: [...filterBase("forward"), "default-action", action] });
  return commitAndSave(out);
}

// ── traffic logging (Traffic Monitor) ─────────────────────────────────────────

const ALL_CHAINS: BaseChain[] = ["forward", "input", "output"];

/// How completely traffic logging is enabled — drives the monitor page's
/// setup banner.
export interface LoggingStatus {
  total_rules: number;
  logged_rules: number;
  /** Chains still missing `default-log`. */
  chains_without_default_log: BaseChain[];
  forward_baseline: boolean;
  /** Every rule logs, every chain default-logs, and the forward baseline is in. */
  complete: boolean;
}

export function loggingStatus(cfg: FirewallConfig): LoggingStatus {
  const logged = cfg.rules.filter((r) => r.log).length;
  const noDefaultLog = ALL_CHAINS.filter((c) => !cfg.setup[c].default_log);
  return {
    total_rules: cfg.rules.length,
    logged_rules: logged,
    chains_without_default_log: noDefaultLog,
    forward_baseline: cfg.setup.forward.baseline,
    complete: logged === cfg.rules.length && noDefaultLog.length === 0 && cfg.setup.forward.baseline,
  };
}

/// Turn on traffic logging everywhere: the hidden established/related baseline
/// in every chain (so each connection logs once and default-log can't flood on
/// reply packets), `log` on every user rule, and `default-log` on every chain
/// so traffic matching no rule shows up too.
export function enableTrafficLoggingCommands(cfg: FirewallConfig): VyosCommand[] {
  const out: VyosCommand[] = [];
  ensureForwardBaseline(out, cfg);
  ensureChainSetup(out, "input", cfg);
  ensureChainSetup(out, "output", cfg);
  for (const chain of ALL_CHAINS) {
    if (!cfg.setup[chain].default_log) out.push({ op: "set", path: [...filterBase(chain), "default-log"] });
  }
  for (const r of cfg.rules) {
    if (!r.log) out.push({ op: "set", path: [...ruleBase(r.chain, r.rule), "log"] });
  }
  return out;
}

/// Enable logging on all rules and chains. Returns the number of changes.
export function enableTrafficLogging(cfg: FirewallConfig): Promise<number> {
  return commitAndSave(enableTrafficLoggingCommands(cfg));
}

// ── rule hit counters ─────────────────────────────────────────────────────────

export interface RuleCounter {
  packets: number;
  bytes: number;
}

/// Key into the counters map (`default` = the chain's default action).
export const counterKey = (chain: RuleChain, rule: number | "default") => `${chain}:${rule}`;

/// A data row of the op-mode rule table: rule number (or `default`), action,
/// protocol, then the packet and byte counters. Header/separator/condition
/// rows don't match the numeric columns.
const COUNTER_LINE = /^(\d+|default)\s+\S+\s+\S+\s+([\d,]+)\s+([\d,]+)/;

function parseCounters(chain: RuleChain, text: string, out: Map<string, RuleCounter>): void {
  for (const line of text.split("\n")) {
    const m = line.trim().match(COUNTER_LINE);
    if (!m) continue;
    const packets = Number(m[2].replace(/,/g, ""));
    const bytes = Number(m[3].replace(/,/g, ""));
    if (!Number.isFinite(packets) || !Number.isFinite(bytes)) continue;
    out.set(counterKey(chain, m[1] === "default" ? "default" : Number(m[1])), { packets, bytes });
  }
}

/// Live per-rule packet/byte counters, keyed by counterKey — read from `show
/// firewall ipv4 <chain> filter` for the base chains and `show firewall ipv4
/// name <ruleset>` for each zone pair. Best-effort: a scope that fails to read
/// or parse contributes nothing.
///
/// `zonePairs` comes from the fetched config; omit it to read base chains only.
export async function fetchRuleCounters(zonePairs: ZonePair[] = []): Promise<Map<string, RuleCounter>> {
  const scopes: { chain: RuleChain; path: string[] }[] = [
    ...ALL_CHAINS.map((c) => ({ chain: c as RuleChain, path: ["firewall", "ipv4", c, "filter"] })),
    ...[...new Set(zonePairs.map((p) => p.ruleset))].map((r) => ({
      chain: zoneRuleChain(r),
      path: ["firewall", "ipv4", "name", r],
    })),
  ];
  const texts = await Promise.all(scopes.map((s) => showText(s.path)));
  const out = new Map<string, RuleCounter>();
  scopes.forEach((s, i) => {
    const t = texts[i];
    if (t) parseCounters(s.chain, t, out);
  });
  return out;
}
