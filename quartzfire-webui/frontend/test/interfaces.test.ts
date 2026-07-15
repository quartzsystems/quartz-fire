// Config-generation tests for the VXLAN SVD + VLAN-aware bridge work.
//
// These exercise the REAL diff functions (no mocks, no bundler) via Node's
// built-in test runner with `--experimental-strip-types`; the sibling
// `register.mjs` resolve hook lets the app's extensionless imports load. Run
// with `npm test` (see package.json).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  diffVxlan,
  diffBridge,
  bridgeVifInterfaceNames,
  type VxlanConfigUpdate,
  type BridgeConfigUpdate,
  type BridgeInterface,
  type VyosCommand,
} from "../lib/interfaces.ts";
import { diffGroup, emptyGroup } from "../lib/vrrp.ts";
import {
  diffRule,
  emptyFirewallConfig,
  type RuleUpdate,
  type EndpointSelection,
} from "../lib/firewall.ts";

// ── helpers ─────────────────────────────────────────────────────────────────

/// A command's path joined with the op, e.g. "set interfaces vxlan vxlan0 …".
const line = (c: VyosCommand) => `${c.op} ${c.path.join(" ")}`;
const lines = (cmds: VyosCommand[]) => cmds.map(line);
const has = (cmds: VyosCommand[], s: string) => lines(cmds).includes(s);

const baseVxlan = (over: Partial<VxlanConfigUpdate>): VxlanConfigUpdate => ({
  name: "vxlan0",
  description: null,
  addresses: [],
  mtu: null,
  enabled: true,
  vnis: [],
  source_address: null,
  source_interface: null,
  remotes: [],
  group: null,
  port: null,
  external: false,
  nolearning: false,
  neighbor_suppress: false,
  bridge: null,
  ...over,
});

const baseBridge = (over: Partial<BridgeConfigUpdate>): BridgeConfigUpdate => ({
  name: "br0",
  description: null,
  addresses: [],
  mtu: null,
  members: [],
  enabled: true,
  vlan_aware: false,
  vifs: [],
  ...over,
});

// ── VXLAN SVD (Bug 1) ─────────────────────────────────────────────────────────

test("VXLAN SVD: multiple VNI↔VLAN rows emit vlan-to-vni paths in the right order", () => {
  const cmds = diffVxlan(
    null,
    baseVxlan({
      source_interface: "dum0",
      bridge: "br0",
      vnis: [
        { vni: 10010, vlan: 10 },
        { vni: 10011, vlan: 11 },
        { vni: 10030, vlan: 30 },
      ],
    }),
  );

  // Path is `vlan-to-vni <vlan> vni <vni>` — vlan first, then the `vni` child.
  assert.ok(has(cmds, "set interfaces vxlan vxlan0 vlan-to-vni 10 vni 10010"));
  assert.ok(has(cmds, "set interfaces vxlan vxlan0 vlan-to-vni 11 vni 10011"));
  assert.ok(has(cmds, "set interfaces vxlan vxlan0 vlan-to-vni 30 vni 10030"));

  // The old broken form must never appear.
  assert.ok(!lines(cmds).some((l) => /vni \d+ vlan \d+/.test(l)), "must not emit `vni <n> vlan <id>`");
});

test("VXLAN SVD: parameters external is forced on whenever a VLAN mapping exists", () => {
  // external explicitly false in the update — the diff must still set it.
  const cmds = diffVxlan(null, baseVxlan({ external: false, vnis: [{ vni: 10010, vlan: 10 }] }));
  assert.ok(has(cmds, "set interfaces vxlan vxlan0 parameters external"));
});

test("VXLAN SVD: the VTEP is added to its bridge as a member", () => {
  const cmds = diffVxlan(null, baseVxlan({ bridge: "br0", vnis: [{ vni: 10010, vlan: 10 }] }));
  assert.ok(has(cmds, "set interfaces bridge br0 member interface vxlan0"));
});

test("VXLAN single unmapped VNI: scalar `vni`, no external, no vlan-to-vni", () => {
  const cmds = diffVxlan(null, baseVxlan({ vnis: [{ vni: 5000, vlan: null }] }));
  assert.ok(has(cmds, "set interfaces vxlan vxlan0 vni 5000"));
  assert.ok(!lines(cmds).some((l) => l.includes("vlan-to-vni")), "no SVD mapping for a scalar VNI");
  assert.ok(!has(cmds, "set interfaces vxlan vxlan0 parameters external"), "scalar VNI must not force external");
});

test("VXLAN SVD: removing a VLAN mapping deletes the whole vlan-to-vni node", () => {
  const live = {
    name: "vxlan0",
    description: null,
    addresses: [],
    mtu: null,
    enabled: true,
    vnis: [
      { vni: 10010, vlan: 10 },
      { vni: 10011, vlan: 11 },
    ],
    source_address: null,
    source_interface: "dum0",
    remotes: [],
    group: null,
    port: null,
    external: true,
    nolearning: false,
    neighbor_suppress: false,
    bridge: "br0",
  };
  const cmds = diffVxlan(live, baseVxlan({ source_interface: "dum0", bridge: "br0", external: true, vnis: [{ vni: 10010, vlan: 10 }] }));
  assert.ok(has(cmds, "delete interfaces vxlan vxlan0 vlan-to-vni 11"));
  assert.ok(!has(cmds, "set interfaces vxlan vxlan0 vlan-to-vni 10 vni 10010"), "unchanged mapping is a no-op");
});

// ── VLAN-aware bridge + VIFs (Bug 2 & 3) ───────────────────────────────────────

test("Bridge: VLAN-aware mode maps to enable-vlan and carries a VXLAN member", () => {
  const cmds = diffBridge(null, baseBridge({ vlan_aware: true, members: ["vxlan0"] }));
  assert.ok(has(cmds, "set interfaces bridge br0 enable-vlan"));
  assert.ok(has(cmds, "set interfaces bridge br0 member interface vxlan0"));
});

test("Bridge: VIFs emit vif <id> address/description and imply VLAN-aware", () => {
  const cmds = diffBridge(
    null,
    baseBridge({
      vlan_aware: true,
      vifs: [
        { vlan_id: 10, description: "Blue", addresses: ["10.0.10.1/24"] },
        { vlan_id: 20, description: null, addresses: ["10.0.20.1/24", "fd00:20::1/64"] },
        { vlan_id: 30, description: null, addresses: [] },
      ],
    }),
  );
  assert.ok(has(cmds, "set interfaces bridge br0 enable-vlan"));
  assert.ok(has(cmds, "set interfaces bridge br0 vif 10 address 10.0.10.1/24"));
  assert.ok(has(cmds, "set interfaces bridge br0 vif 10 description Blue"));
  assert.ok(has(cmds, "set interfaces bridge br0 vif 20 address 10.0.20.1/24"));
  assert.ok(has(cmds, "set interfaces bridge br0 vif 20 address fd00:20::1/64"));
  // A VIF with no address/description still needs its node created.
  assert.ok(has(cmds, "set interfaces bridge br0 vif 30"));
});

test("Bridge: turning VLAN-aware off deletes enable-vlan; removed VIF is deleted", () => {
  const live: BridgeInterface = {
    name: "br0",
    description: null,
    addresses: [],
    mtu: null,
    members: [],
    enabled: true,
    vlan_aware: true,
    vifs: [{ vlan_id: 10, description: null, addresses: ["10.0.10.1/24"] }],
  };
  const cmds = diffBridge(live, baseBridge({ vlan_aware: false, vifs: [] }));
  assert.ok(has(cmds, "delete interfaces bridge br0 enable-vlan"));
  assert.ok(has(cmds, "delete interfaces bridge br0 vif 10"));
});

test("bridgeVifInterfaceNames yields <bridge>.<vlan> names", () => {
  const bridges: BridgeInterface[] = [
    {
      name: "br0",
      description: null,
      addresses: [],
      mtu: null,
      members: [],
      enabled: true,
      vlan_aware: true,
      vifs: [
        { vlan_id: 20, description: null, addresses: [] },
        { vlan_id: 10, description: null, addresses: [] },
      ],
    },
  ];
  assert.deepEqual(bridgeVifInterfaceNames(bridges), ["br0.10", "br0.20"]);
});

// ── VRRP + firewall reference bridge VIFs ──────────────────────────────────────

test("VRRP group can bind to a bridge VIF interface (br0.10)", () => {
  const group = {
    ...emptyGroup(),
    name: "LAN",
    interface: "br0.10",
    vrid: 10,
    priority: 100,
    addresses: [{ address: "10.0.10.254/24", interface: null }],
  };
  const cmds = diffGroup(null, group);
  assert.ok(has(cmds, "set high-availability vrrp group LAN interface br0.10"));
});

test("Firewall rule can match a bridge VIF interface (inbound-interface name br0.10)", () => {
  const cfg = emptyFirewallConfig();
  const from: EndpointSelection = [{ kind: "interface", name: "br0.10" }];
  const update: RuleUpdate = {
    rule: 10,
    name: "Allow VLAN10",
    action: "accept",
    from,
    to: [],
    policy: null,
    enabled: true,
    log: false,
    ips: false,
  };
  const cmds = diffRule(null, update, cfg);
  assert.ok(has(cmds, "set firewall ipv4 forward filter rule 10 inbound-interface name br0.10"));
});
