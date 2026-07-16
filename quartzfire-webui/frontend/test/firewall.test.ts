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
  ruleChainFor,
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

test("one zone per side", () => {
  assert.throws(
    () => ruleChainFor([{ kind: "zone", name: "LAN" }, { kind: "zone", name: "WAN" }], ZONE_WAN, zonedConfig().zones),
    /only carry one zone/,
  );
});

test("rules without zones are untouched by the zone model", () => {
  const cmds = diffRule(null, baseRuleUpdate({ from: [{ kind: "interface", name: "eth1" }] }), zonedConfig());
  assert.ok(has(cmds, "set firewall ipv4 forward filter rule 10 action accept"));
  assert.ok(has(cmds, "set firewall ipv4 forward filter rule 10 inbound-interface name eth1"));
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
