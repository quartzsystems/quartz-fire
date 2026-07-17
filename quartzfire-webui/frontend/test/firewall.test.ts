// Config-generation tests for zone-based firewalling.
//
// These exercise the REAL diff functions (no mocks, no bundler) via Node's
// built-in test runner with `--experimental-strip-types`; the sibling
// `register.mjs` resolve hook lets the app's extensionless imports load. Run
// with `npm test` (see package.json).
//
// The assertions below encode facts checked against vyos-1x@rolling (the ref
// scripts/package-build/vyos-1x pins), because several of them contradict the
// published 1.5 docs — see the `member interface` and state-policy tests.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  diffRule,
  diffZone,
  emptyFirewallConfig,
  defaultDropBlockedReason,
  pairRuleset,
  renumberedCount,
  renumberMap,
  reorderCommands,
  ruleChainsFor,
  ruleSelection,
  rulesetName,
  zoneRuleChain,
  zoneUsage,
  type EndpointSelection,
  type FirewallConfig,
  type FirewallRule,
  type FirewallZone,
  type RuleUpdate,
  type ZoneUpdate,
} from "../lib/firewall.ts";
import type { VyosCommand } from "../lib/interfaces.ts";
import { acMatchFromSelections } from "../lib/rule-services.ts";
import { diffGeoPoliciesForRule } from "../lib/geolocation.ts";

// ── helpers ─────────────────────────────────────────────────────────────────

const line = (c: VyosCommand) => `${c.op} ${c.path.join(" ")}`;
const lines = (cmds: VyosCommand[]) => cmds.map(line);
const has = (cmds: VyosCommand[], s: string) => lines(cmds).includes(s);

const baseZoneUpdate = (over: Partial<ZoneUpdate>): ZoneUpdate => ({
  name: "LAN",
  display: "LAN",
  description: null,
  local: false,
  interfaces: ["eth1"],
  default_action: null,
  default_log: false,
  intra_zone: null,
  original_name: null,
  ...over,
});

const baseZone = (over: Partial<FirewallZone>): FirewallZone => ({
  name: "LAN",
  display: "LAN",
  description: null,
  local: false,
  interfaces: ["eth1"],
  default_action: null,
  default_log: false,
  intra_zone: null,
  ...over,
});

const baseRuleUpdate = (over: Partial<RuleUpdate>): RuleUpdate => ({
  rule: 10,
  name: null,
  action: "accept",
  from: [],
  to: [],
  policy: null,
  enabled: true,
  log: false,
  ips: false,
  ...over,
});

/// A config with LAN + WAN zones and (optionally) their pair already bound.
const zonedConfig = (over: Partial<FirewallConfig> = {}): FirewallConfig => ({
  ...emptyFirewallConfig(),
  zones: [baseZone({ name: "LAN" }), baseZone({ name: "WAN", display: "WAN", interfaces: ["eth0"] })],
  ...over,
});

const noEndpoint = () => ({ group_type: null, group_name: null, address: null, iface: null, iface_group: null });

/// A stored rule. `scopes` defaults to the single representative chain, which
/// is what a base-chain rule always has.
const baseRule = (over: Partial<FirewallRule> = {}): FirewallRule => {
  const chain = over.chain ?? "forward";
  return {
    rule: 10,
    chain,
    scopes: [{ chain, raw: {} }],
    name: null,
    action: "accept",
    ips: false,
    from: noEndpoint(),
    to: noEndpoint(),
    policy: null,
    protocol: null,
    enabled: true,
    log: false,
    raw: {},
    ...over,
  };
};

/// A stored zone rule spanning `pairs`, all copies at one number.
const zoneRule = (pairs: [string, string][], over: Partial<FirewallRule> = {}): FirewallRule => {
  const chains = pairs.map(([s, d]) => zoneRuleChain(pairRuleset(s, d))).sort((a, b) => a.localeCompare(b));
  return baseRule({ chain: chains[0], scopes: chains.map((chain) => ({ chain, raw: {} })), ...over });
};

// ── zone config ─────────────────────────────────────────────────────────────

test("a zone's interfaces go under `member` — not directly under the zone", () => {
  // The published 1.5 docs say `set firewall zone LAN interface eth1`, but the
  // rolling XML this build pins requires the `member` container. Getting this
  // wrong produces config that won't commit.
  const cmds = diffZone(emptyFirewallConfig(), baseZoneUpdate({ interfaces: ["eth1", "eth2"] }));
  assert.ok(has(cmds, "set firewall zone LAN member interface eth1"));
  assert.ok(has(cmds, "set firewall zone LAN member interface eth2"));
  assert.ok(!has(cmds, "set firewall zone LAN interface eth1"));
});

test("the first zone seeds the global state match, so replies survive", () => {
  // Zone chains hook at priority 1, after the base chains at priority 0. A base
  // chain's established/related accept only means "carry on to the zone chain",
  // which has no state match of its own — without state policy every reply
  // falls through to the zone default-action and dies.
  const cmds = diffZone(emptyFirewallConfig(), baseZoneUpdate({}));
  assert.ok(has(cmds, "set firewall global-options state-policy established action accept"));
  assert.ok(has(cmds, "set firewall global-options state-policy related action accept"));
});

test("state policy isn't rewritten once it's already in place", () => {
  const cmds = diffZone(zonedConfig({ state_policy: true }), baseZoneUpdate({ name: "DMZ", display: "DMZ", interfaces: ["eth2"] }));
  assert.ok(!lines(cmds).some((l) => l.includes("state-policy")));
});

test("a zone carries default-action, default-log, and intra-zone filtering", () => {
  const cmds = diffZone(
    emptyFirewallConfig(),
    baseZoneUpdate({ default_action: "drop", default_log: true, intra_zone: "accept" }),
  );
  assert.ok(has(cmds, "set firewall zone LAN default-action drop"));
  assert.ok(has(cmds, "set firewall zone LAN default-log"));
  assert.ok(has(cmds, "set firewall zone LAN intra-zone-filtering action accept"));
});

test("a friendly zone name is kept in the description marker", () => {
  const cmds = diffZone(emptyFirewallConfig(), baseZoneUpdate({ name: "DMZ-Servers", display: "DMZ Servers" }));
  assert.ok(has(cmds, "set firewall zone DMZ-Servers description [dn:DMZ Servers]"));
});

test("the local zone is the firewall itself and takes no interfaces", () => {
  const cmds = diffZone(
    emptyFirewallConfig(),
    baseZoneUpdate({ name: "LOCAL", display: "Firewall", local: true, interfaces: [] }),
  );
  assert.ok(has(cmds, "set firewall zone LOCAL local-zone"));
  assert.ok(!lines(cmds).some((l) => l.includes("member interface")));
});

// ── zone validation (mirrors what VyOS verify() rejects at commit) ──────────

test("a local zone can't have member interfaces", () => {
  assert.throws(
    () => diffZone(emptyFirewallConfig(), baseZoneUpdate({ local: true, interfaces: ["eth1"] })),
    /can't have member interfaces/,
  );
});

test("only one local zone is allowed", () => {
  const cfg = zonedConfig({ zones: [baseZone({ name: "LOCAL", display: "Firewall", local: true, interfaces: [] })] });
  assert.throws(
    () => diffZone(cfg, baseZoneUpdate({ name: "OTHER", display: "Other", local: true, interfaces: [] })),
    /already a Firewall zone/,
  );
});

test("an interface can only belong to one zone", () => {
  assert.throws(
    () => diffZone(zonedConfig(), baseZoneUpdate({ name: "DMZ", display: "DMZ", interfaces: ["eth1"] })),
    /already a member of LAN/,
  );
});

test("a non-local zone needs at least one interface", () => {
  assert.throws(
    () => diffZone(emptyFirewallConfig(), baseZoneUpdate({ interfaces: [] })),
    /at least one interface/,
  );
});

test("editing a zone doesn't report its own interfaces as taken", () => {
  const cmds = diffZone(zonedConfig(), baseZoneUpdate({ interfaces: ["eth1", "eth3"], original_name: "LAN" }));
  assert.ok(has(cmds, "set firewall zone LAN member interface eth3"));
});

// ── zone rules ──────────────────────────────────────────────────────────────

const ZONE_LAN: EndpointSelection = [{ kind: "zone", name: "LAN" }];
const ZONE_WAN: EndpointSelection = [{ kind: "zone", name: "WAN" }];

test("a zone pair puts the rule in that pair's ruleset, and binds it", () => {
  const cmds = diffRule(null, baseRuleUpdate({ from: ZONE_LAN, to: ZONE_WAN }), zonedConfig());
  assert.ok(has(cmds, "set firewall ipv4 name QZ-Z-LAN-TO-WAN rule 10 action accept"));
  // Without the `from` binding VyOS never jumps into the ruleset — the rules
  // would sit in the config doing nothing.
  assert.ok(has(cmds, "set firewall zone WAN from LAN firewall name QZ-Z-LAN-TO-WAN"));
});

test("a zone writes no match node of its own — the ruleset expresses it", () => {
  const cmds = diffRule(null, baseRuleUpdate({ from: ZONE_LAN, to: ZONE_WAN }), zonedConfig());
  assert.ok(!lines(cmds).some((l) => l.includes("inbound-interface") || l.includes("outbound-interface")));
});

test("an alias alongside a zone still narrows the match inside the ruleset", () => {
  const cfg = zonedConfig();
  const cmds = diffRule(
    null,
    baseRuleUpdate({ from: [...ZONE_LAN, { kind: "alias", type: "host", name: "Admins" }], to: ZONE_WAN }),
    cfg,
  );
  assert.ok(has(cmds, "set firewall ipv4 name QZ-Z-LAN-TO-WAN rule 10 source group address-group Admins"));
});

test("the pair binding isn't rewritten once the pair exists", () => {
  const cfg = zonedConfig({
    zone_pairs: [{ src: "LAN", dst: "WAN", ruleset: pairRuleset("LAN", "WAN") }],
    state_policy: true,
  });
  const cmds = diffRule(null, baseRuleUpdate({ rule: 20, from: ZONE_LAN, to: ZONE_WAN }), cfg);
  assert.ok(!lines(cmds).some((l) => l.includes("from LAN firewall name")));
  assert.ok(has(cmds, "set firewall ipv4 name QZ-Z-LAN-TO-WAN rule 20 action accept"));
});

test("a zone whose name contains -TO- still binds the right pair", () => {
  // Zone names can hold hyphens ("X to WAN" → X-TO-WAN), which makes the
  // ruleset name QZ-Z-LAN-TO-X-TO-WAN ambiguous: LAN → X-TO-WAN, or LAN-TO-X →
  // WAN? Parsing the pair back out of the name resolves that wrong (greedy
  // matching yields LAN-TO-X → WAN) and would bind a pair of zones that don't
  // exist. The pair is carried alongside the scope instead.
  const cfg = zonedConfig({
    zones: [baseZone({ name: "LAN" }), baseZone({ name: "X-TO-WAN", display: "X to WAN", interfaces: ["eth0"] })],
  });
  const cmds = diffRule(
    null,
    baseRuleUpdate({ from: ZONE_LAN, to: [{ kind: "zone", name: "X-TO-WAN" }] }),
    cfg,
  );
  assert.ok(has(cmds, "set firewall zone X-TO-WAN from LAN firewall name QZ-Z-LAN-TO-X-TO-WAN"));
  assert.ok(!has(cmds, "set firewall zone WAN from LAN-TO-X firewall name QZ-Z-LAN-TO-X-TO-WAN"));
});

test("To Firewall from a zone resolves to the local zone's pair", () => {
  const cfg = zonedConfig({
    zones: [
      baseZone({ name: "LAN" }),
      baseZone({ name: "LOCAL", display: "Firewall", local: true, interfaces: [] }),
    ],
  });
  const cmds = diffRule(null, baseRuleUpdate({ from: ZONE_LAN, to: [{ kind: "firewall" }] }), cfg);
  assert.ok(has(cmds, "set firewall zone LOCAL from LAN firewall name QZ-Z-LAN-TO-LOCAL"));
  assert.ok(has(cmds, "set firewall ipv4 name QZ-Z-LAN-TO-LOCAL rule 10 action accept"));
});

test("a zone on one side only is rejected — a pair needs both", () => {
  assert.throws(
    () => diffRule(null, baseRuleUpdate({ from: ZONE_LAN, to: [] }), zonedConfig()),
    /always goes from one zone to another/,
  );
});

test("a zone to the Firewall without a local zone explains what's missing", () => {
  assert.throws(
    () => diffRule(null, baseRuleUpdate({ from: ZONE_LAN, to: [{ kind: "firewall" }] }), zonedConfig()),
    /Set a Firewall zone on the Zones page/,
  );
});

test("a rule from a zone to itself is rejected", () => {
  assert.throws(
    () => diffRule(null, baseRuleUpdate({ from: ZONE_LAN, to: [{ kind: "zone", name: "LAN" }] }), zonedConfig()),
    /intra-zone filtering/,
  );
});

// ── multi-zone rules ────────────────────────────────────────────────────────

/// LAN + DMZ + WAN, so a rule can span more than one pair.
const threeZones = (over: Partial<FirewallConfig> = {}): FirewallConfig => ({
  ...emptyFirewallConfig(),
  zones: [
    baseZone({ name: "LAN", interfaces: ["eth1"] }),
    baseZone({ name: "DMZ", display: "DMZ", interfaces: ["eth2"] }),
    baseZone({ name: "WAN", display: "WAN", interfaces: ["eth0"] }),
  ],
  ...over,
});

test("a rule From two zones writes one copy per pair, at one number", () => {
  // VyOS can't OR zone pairs, so From [LAN, DMZ] To [WAN] is two rules — one in
  // each pair's ruleset. They share a number so they read back as one rule.
  const cmds = diffRule(
    null,
    baseRuleUpdate({
      rule: 20,
      from: [{ kind: "zone", name: "LAN" }, { kind: "zone", name: "DMZ" }],
      to: ZONE_WAN,
    }),
    threeZones(),
  );
  assert.ok(has(cmds, "set firewall ipv4 name QZ-Z-LAN-TO-WAN rule 20 action accept"));
  assert.ok(has(cmds, "set firewall ipv4 name QZ-Z-DMZ-TO-WAN rule 20 action accept"));
  assert.ok(has(cmds, "set firewall zone WAN from LAN firewall name QZ-Z-LAN-TO-WAN"));
  assert.ok(has(cmds, "set firewall zone WAN from DMZ firewall name QZ-Z-DMZ-TO-WAN"));
});

test("a 2x2 rule spans four pairs", () => {
  const cfg: FirewallConfig = {
    ...emptyFirewallConfig(),
    zones: [
      baseZone({ name: "LAN", interfaces: ["eth1"] }),
      baseZone({ name: "DMZ", display: "DMZ", interfaces: ["eth2"] }),
      baseZone({ name: "WAN", display: "WAN", interfaces: ["eth0"] }),
      baseZone({ name: "GUEST", display: "Guest", interfaces: ["eth3"] }),
    ],
  };
  const chains = ruleChainsFor(
    [{ kind: "zone", name: "LAN" }, { kind: "zone", name: "DMZ" }],
    [{ kind: "zone", name: "WAN" }, { kind: "zone", name: "GUEST" }],
    cfg.zones,
  );
  assert.deepEqual(chains.slice().sort(), [
    "name:QZ-Z-DMZ-TO-GUEST",
    "name:QZ-Z-DMZ-TO-WAN",
    "name:QZ-Z-LAN-TO-GUEST",
    "name:QZ-Z-LAN-TO-WAN",
  ]);
});

test("the state match is seeded once, not once per pair", () => {
  const cmds = diffRule(
    null,
    baseRuleUpdate({ from: [{ kind: "zone", name: "LAN" }, { kind: "zone", name: "DMZ" }], to: ZONE_WAN }),
    threeZones(),
  );
  const seeds = lines(cmds).filter((l) => l.includes("state-policy established"));
  assert.equal(seeds.length, 1);
});

test("the auto group behind a multi-entry side is created once, and referenced per pair", () => {
  const cfg = threeZones({ aliases: [] });
  const cmds = diffRule(
    null,
    baseRuleUpdate({
      rule: 20,
      from: [{ kind: "zone", name: "LAN" }, { kind: "zone", name: "DMZ" }],
      to: [
        { kind: "zone", name: "WAN" },
        { kind: "inline", type: "host", value: "192.0.2.1" },
        { kind: "inline", type: "host", value: "192.0.2.2" },
      ],
    }),
    cfg,
  );
  // One group, however many pairs point at it.
  const created = lines(cmds).filter((l) => l.endsWith("description [qz-rule]"));
  assert.equal(created.length, 1);
  assert.ok(has(cmds, "set firewall ipv4 name QZ-Z-LAN-TO-WAN rule 20 destination group address-group QZ-R20-TO"));
  assert.ok(has(cmds, "set firewall ipv4 name QZ-Z-DMZ-TO-WAN rule 20 destination group address-group QZ-R20-TO"));
});

test("a zone on both sides is rejected", () => {
  assert.throws(
    () =>
      ruleChainsFor(
        [{ kind: "zone", name: "LAN" }, { kind: "zone", name: "WAN" }],
        ZONE_WAN,
        zonedConfig().zones,
      ),
    /WAN is on both sides/,
  );
});

test("dropping one zone from a rule removes only that pair's copy", () => {
  const cfg = threeZones({
    zone_pairs: [
      { src: "LAN", dst: "WAN", ruleset: pairRuleset("LAN", "WAN") },
      { src: "DMZ", dst: "WAN", ruleset: pairRuleset("DMZ", "WAN") },
    ],
    state_policy: true,
  });
  const live = zoneRule([["LAN", "WAN"], ["DMZ", "WAN"]], { rule: 20 });
  cfg.rules = [live];
  // From [LAN, DMZ] → From [LAN]: the DMZ copy goes, and the number is kept.
  const cmds = diffRule(live, baseRuleUpdate({ rule: 20, from: ZONE_LAN, to: ZONE_WAN }), cfg);
  assert.ok(has(cmds, "delete firewall ipv4 name QZ-Z-DMZ-TO-WAN rule 20"));
  assert.ok(!lines(cmds).some((l) => l.startsWith("delete firewall ipv4 name QZ-Z-LAN-TO-WAN rule 20")));
  // Its pair had no other rules, so the binding and ruleset retire with it.
  assert.ok(has(cmds, "delete firewall zone WAN from DMZ"));
  assert.ok(has(cmds, "delete firewall ipv4 name QZ-Z-DMZ-TO-WAN"));
});

// ── reorder ─────────────────────────────────────────────────────────────────

test("a multi-zone rule gets ONE target number across all its pairs", () => {
  // The copies sit at consecutive positions in no list — the rule has one
  // position, so one target. Numbering off per-copy positions would split the
  // shared number and silently break the rule.
  const a = baseRule({ rule: 50, chain: "forward" });
  const b = zoneRule([["LAN", "WAN"], ["DMZ", "WAN"]], { rule: 90 });
  const moves = renumberMap([a, b]);
  assert.equal(moves.get("forward:50"), 10);
  assert.equal(moves.get("name:QZ-Z-DMZ-TO-WAN:90"), 20);
  assert.equal(moves.get("name:QZ-Z-LAN-TO-WAN:90"), 20);
  assert.equal(renumberedCount([a, b]), 2);
});

test("reorder rebuilds every copy of a multi-zone rule at the new number", () => {
  const b = zoneRule([["LAN", "WAN"], ["DMZ", "WAN"]], { rule: 90 });
  b.scopes = b.scopes.map((s) => ({ ...s, raw: { action: "accept" } }));
  const cmds = reorderCommands([b]);
  assert.ok(has(cmds, "delete firewall ipv4 name QZ-Z-LAN-TO-WAN rule 90"));
  assert.ok(has(cmds, "delete firewall ipv4 name QZ-Z-DMZ-TO-WAN rule 90"));
  assert.ok(has(cmds, "set firewall ipv4 name QZ-Z-LAN-TO-WAN rule 10 action accept"));
  assert.ok(has(cmds, "set firewall ipv4 name QZ-Z-DMZ-TO-WAN rule 10 action accept"));
  // Every delete precedes every set, so a number another rule vacates is safe.
  const l = lines(cmds);
  assert.ok(l.findLastIndex((x) => x.startsWith("delete ")) < l.findIndex((x) => x.startsWith("set ")));
});

test("rules without zones are untouched by the zone model", () => {
  const cmds = diffRule(null, baseRuleUpdate({ from: [{ kind: "interface", name: "eth1" }] }), zonedConfig());
  assert.ok(has(cmds, "set firewall ipv4 forward filter rule 10 action accept"));
  assert.ok(has(cmds, "set firewall ipv4 forward filter rule 10 inbound-interface name eth1"));
});

test("a saved zone rule reopens with its zones on both sides", () => {
  // A zone rule stores no zone match — the ruleset it lives in is the only
  // record of its pair. If the sides didn't resolve it back, editing a saved
  // zone rule would silently drop it to a plain forward rule on save.
  const cfg = zonedConfig({ zone_pairs: [{ src: "LAN", dst: "WAN", ruleset: pairRuleset("LAN", "WAN") }] });
  const rule = zoneRule([["LAN", "WAN"]]);
  assert.deepEqual(ruleSelection(rule, "from", cfg.auto_groups, cfg), [{ kind: "zone", name: "LAN" }]);
  assert.deepEqual(ruleSelection(rule, "to", cfg.auto_groups, cfg), [{ kind: "zone", name: "WAN" }]);
});

test("a multi-zone rule reopens with every zone on each side", () => {
  const cfg = threeZones({
    zone_pairs: [
      { src: "LAN", dst: "WAN", ruleset: pairRuleset("LAN", "WAN") },
      { src: "DMZ", dst: "WAN", ruleset: pairRuleset("DMZ", "WAN") },
    ],
  });
  const rule = zoneRule([["LAN", "WAN"], ["DMZ", "WAN"]], { rule: 20 });
  const from = ruleSelection(rule, "from", cfg.auto_groups, cfg);
  assert.deepEqual(
    from.map((e) => (e.kind === "zone" ? e.name : e.kind)).sort(),
    ["DMZ", "LAN"],
  );
  assert.deepEqual(ruleSelection(rule, "to", cfg.auto_groups, cfg), [{ kind: "zone", name: "WAN" }]);
});

test("the local zone side reopens as the Firewall endpoint, not a zone", () => {
  const cfg = zonedConfig({
    zones: [baseZone({ name: "LAN" }), baseZone({ name: "LOCAL", display: "Firewall", local: true, interfaces: [] })],
    zone_pairs: [{ src: "LAN", dst: "LOCAL", ruleset: pairRuleset("LAN", "LOCAL") }],
  });
  assert.deepEqual(ruleSelection(zoneRule([["LAN", "LOCAL"]]), "to", cfg.auto_groups, cfg), [{ kind: "firewall" }]);
});

// ── the priority-0 / priority-1 guardrail ───────────────────────────────────

test("denying by default is blocked while zones exist", () => {
  // The forward chain runs at priority 0, before the zone chains at priority 1.
  // A drop there never reaches them, so it would black-hole every zone rule's
  // traffic while the Rules page still showed the rules as allowing it.
  assert.ok(defaultDropBlockedReason(zonedConfig()) !== null);
  assert.equal(defaultDropBlockedReason(emptyFirewallConfig()), null);
});

// ── scope keys ──────────────────────────────────────────────────────────────

test("a zone scope round-trips through its key", () => {
  const chain = zoneRuleChain("QZ-Z-LAN-TO-WAN");
  assert.equal(chain, "name:QZ-Z-LAN-TO-WAN");
  assert.equal(rulesetName(chain), "QZ-Z-LAN-TO-WAN");
  assert.equal(rulesetName("forward"), null);
});

// ── usage ───────────────────────────────────────────────────────────────────

test("a zone's usage counts the rules of every pair it takes part in", () => {
  const rule = (over: Partial<FirewallRule>): FirewallRule => ({
    rule: 10,
    chain: zoneRuleChain(pairRuleset("LAN", "WAN")),
    name: null,
    action: "accept",
    ips: false,
    from: { group_type: null, group_name: null, address: null, iface: null, iface_group: null },
    to: { group_type: null, group_name: null, address: null, iface: null, iface_group: null },
    policy: null,
    protocol: null,
    enabled: true,
    log: false,
    raw: {},
    ...over,
  });
  const cfg = zonedConfig({
    zone_pairs: [{ src: "LAN", dst: "WAN", ruleset: pairRuleset("LAN", "WAN") }],
    rules: [rule({}), rule({ rule: 20, chain: "forward" })],
  });
  assert.equal(zoneUsage(cfg, cfg.zones[0]).length, 1);
});

// ── App Control match derivation (fails closed) ──────────────────────────────

test("a zone side expands into that zone's interfaces", () => {
  // The binding is an independent nft match in qfappd's own table — it does
  // NOT inherit the rule's criteria — so the zones have to be spelled out.
  const cfg = threeZones();
  const m = acMatchFromSelections(
    [{ kind: "zone", name: "LAN" }, { kind: "zone", name: "DMZ" }],
    [{ kind: "zone", name: "WAN" }],
    cfg,
  );
  assert.deepEqual(m.iifname, ["eth1", "eth2"]);
  assert.deepEqual(m.oifname, ["eth0"]);
});

test("an alias side expands into its members", () => {
  const cfg = zonedConfig({
    aliases: [
      { name: "Admins", display: "Admins", type: "host", description: null, members: ["10.0.0.5", "10.0.0.6"] },
    ],
  });
  const m = acMatchFromSelections([{ kind: "alias", type: "host", name: "Admins" }], [], cfg);
  assert.deepEqual(m.saddr, ["10.0.0.5", "10.0.0.6"]);
});

test("a side qfappd can't match is refused, not silently widened", () => {
  // An empty AcMatch means "every forwarded connection", so dropping what can't
  // be expressed would enforce the action far beyond the rule.
  const cfg = zonedConfig({
    aliases: [
      { name: "Sites", display: "Sites", type: "fqdn", description: null, members: ["example.com"] },
      { name: "Range", display: "Range", type: "host", description: null, members: ["10.0.0.1-10.0.0.9"] },
    ],
  });
  assert.throws(
    () => acMatchFromSelections([{ kind: "alias", type: "fqdn", name: "Sites" }], [], cfg),
    /addresses, not names/,
  );
  assert.throws(
    () => acMatchFromSelections([{ kind: "inline", type: "fqdn", value: "example.com" }], [], cfg),
    /addresses, not names/,
  );
  // qfappd parses addresses as CIDRs, so a group range can't be expressed —
  // and a refused binding fails the WHOLE policy, not just this one.
  assert.throws(
    () => acMatchFromSelections([{ kind: "alias", type: "host", name: "Range" }], [], cfg),
    /isn't an IPv4 address or network/,
  );
  assert.throws(
    () => acMatchFromSelections([{ kind: "firewall" }], [], cfg),
    /firewall itself/,
  );
});

test("the local zone can't carry an App Control binding", () => {
  // Traffic to or from the box never reaches qfappd's forward hook.
  const cfg = zonedConfig({
    zones: [baseZone({ name: "LAN" }), baseZone({ name: "LOCAL", display: "Firewall", local: true, interfaces: [] })],
  });
  assert.throws(
    () => acMatchFromSelections([{ kind: "zone", name: "LOCAL" }], [], cfg),
    /firewall itself/,
  );
});

// ── Geolocation policies follow a rule's scopes ──────────────────────────────

test("a multi-zone rule gets one geolocation policy per pair", () => {
  // qzgeo binds a policy to (ruleset, rule), so a rule in two rulesets needs
  // two policies — and they must ride one commit (commit-confirm allows one
  // pending change).
  const rule = { rule: 20, scopes: [{ chain: zoneRuleChain(pairRuleset("LAN", "WAN")) }, { chain: zoneRuleChain(pairRuleset("DMZ", "WAN")) }] };
  const cmds = diffGeoPoliciesForRule([], rule, "Block_CN", "source");
  assert.ok(has(cmds, "set service geolocation policy 10 ruleset name:QZ-Z-LAN-TO-WAN"));
  assert.ok(has(cmds, "set service geolocation policy 20 ruleset name:QZ-Z-DMZ-TO-WAN"));
  assert.ok(has(cmds, "set service geolocation policy 10 rule 20"));
  assert.ok(has(cmds, "set service geolocation policy 20 rule 20"));
});

test("detaching removes every one of a rule's geolocation policies", () => {
  const live = [
    { id: 10, action: "Block_CN", ruleset: zoneRuleChain(pairRuleset("LAN", "WAN")), rule: 20, direction: "source" as const, enabled: true },
    { id: 20, action: "Block_CN", ruleset: zoneRuleChain(pairRuleset("DMZ", "WAN")), rule: 20, direction: "source" as const, enabled: true },
  ];
  const rule = { rule: 20, scopes: live.map((p) => ({ chain: p.ruleset })) };
  const cmds = diffGeoPoliciesForRule(live, rule, null, "source");
  assert.deepEqual(lines(cmds).sort(), [
    "delete service geolocation policy 10",
    "delete service geolocation policy 20",
  ]);
});

test("a pair a rule no longer spans loses its geolocation policy", () => {
  const live = [
    { id: 10, action: "Block_CN", ruleset: zoneRuleChain(pairRuleset("LAN", "WAN")), rule: 20, direction: "source" as const, enabled: true },
    { id: 20, action: "Block_CN", ruleset: zoneRuleChain(pairRuleset("DMZ", "WAN")), rule: 20, direction: "source" as const, enabled: true },
  ];
  // The rule drops DMZ — its policy would otherwise target a rule that's gone.
  const rule = { rule: 20, scopes: [{ chain: zoneRuleChain(pairRuleset("LAN", "WAN")) }] };
  const cmds = diffGeoPoliciesForRule(live, rule, "Block_CN", "source");
  assert.ok(has(cmds, "delete service geolocation policy 20"));
});
