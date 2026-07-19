// Per-rule security services — attach IPS's siblings (SSL Inspection,
// Geolocation, Application Control) to a firewall rule from the rule editor.
//
// Each service stores its per-rule binding in a different place, all keyed by
// the firewall rule number:
//   * SSL Inspection → VyOS `service quartzfire ssl-inspection policy <rule>`
//   * Geolocation    → VyOS `service geolocation policy <id>` (its own id,
//                      referencing rule + ruleset)
//   * App Control    → backend desired-state JSON binding (id = rule number)
//
// The catch is commit-confirm: guardedCommitAndSave arms a single server-side
// revert timer, so a second guarded commit while one is pending 409s. The
// firewall rule and the two VyOS-backed services must therefore land in ONE
// guarded commit — we compose their pure `diff*` command lists and apply them
// together. Application Control is a separate, non-guarded backend PUT.

// Type-only imports must say so: the test runner strips types without a
// bundler, so a type imported as a value fails to resolve at runtime.
import type {
  BaseChain,
  EndpointSelection,
  FirewallConfig,
  FirewallRule,
  RuleChain,
  RuleUpdate,
} from "./firewall";
import { diffRule, isBaseChain, nextRuleNumber, ruleChainFor, ruleChainsFor } from "./firewall";
import type { SslInspectionConfig, SslPolicyAction } from "./ssl-inspection";
import { diffSslInspection } from "./ssl-inspection";
import type { GeoDirection, GeolocationConfig, GeoPolicyUpdate } from "./geolocation";
import { diffGeoPoliciesForRule, diffGeoPolicy, nextPolicyId } from "./geolocation";
import type { AcConfig, AcMatch } from "./appcontrol";
import { saveAcConfig } from "./appcontrol";
import { guardedCommitAndSave } from "./guard";
import type { VyosCommand } from "./interfaces";

/// The ct-mark ACTION_ID field is 3 bits → at most 7 App Control actions bound
/// at once (mirrors MAX_BOUND_ACTIONS on the Application Control page).
export const MAX_BOUND_AC_ACTIONS = 7;

/// SSL inspection's per-rule choice — no named policies, just how matched HTTPS
/// is treated. "off" = no binding.
export type SslServiceChoice = "off" | SslPolicyAction;

/// The three selectable service attachments for one rule (IPS lives on the rule
/// itself and is handled by RuleUpdate).
export interface RuleServiceState {
  ssl: SslServiceChoice;
  /** null = not attached. */
  geo: { action: string; direction: GeoDirection } | null;
  /** App Control action name, or null = not attached. */
  appcontrol: string | null;
}

export function emptyRuleServiceState(): RuleServiceState {
  return { ssl: "off", geo: null, appcontrol: null };
}

/// The live service configs the rule editor reads to seed and diff against.
export interface RuleServiceConfigs {
  ssl: SslInspectionConfig;
  geo: GeolocationConfig;
  ac: AcConfig;
}

/// Derive a rule's current service attachment from the live configs.
/// `scopes` are every scope the rule occupies — a zone rule carries a geo
/// policy per pair, and they're written together, so any one reports the state.
export function serviceStateForRule(
  rule: number,
  scopes: RuleChain[],
  cfgs: RuleServiceConfigs,
): RuleServiceState {
  const sslPolicy = cfgs.ssl.policies.find((p) => p.rule === rule);
  const geoPolicy = cfgs.geo.policies.find((p) => p.rule === rule && scopes.includes(p.ruleset));
  const acBinding = cfgs.ac.bindings.find((b) => b.id === rule);
  return {
    ssl: sslPolicy && sslPolicy.enabled ? sslPolicy.action : "off",
    geo: geoPolicy ? { action: geoPolicy.action, direction: geoPolicy.direction } : null,
    appcontrol: acBinding ? acBinding.action : null,
  };
}

// ── App Control match derivation ──────────────────────────────────────────────

/// qfappd matches addresses with a CIDR parser, so an address-group range
/// (192.0.2.10-192.0.2.20) can't be expressed. A rejected binding fails the
/// WHOLE policy, so these are caught here rather than shipped.
const AC_ADDR = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/;

/// What one side of a rule contributes to an App Control match.
///
/// This fails CLOSED. An App Control binding is an independent nft match in
/// qfappd's own table — it doesn't inherit the firewall rule's criteria — so
/// anything dropped here silently WIDENS enforcement (an empty match means
/// every forwarded connection). Where a side can't be expressed, the binding
/// is refused instead.
function sideMatch(
  sel: EndpointSelection,
  cfg: Pick<FirewallConfig, "aliases" | "zones">,
  side: "From" | "To",
): { ifaces: string[]; addrs: string[] } {
  const ifaces: string[] = [];
  const addrs: string[] = [];
  const reject = (why: string) => {
    throw new Error(`Application Control can't be attached to this rule: ${side} ${why}.`);
  };

  for (const e of sel) {
    switch (e.kind) {
      case "interface":
        ifaces.push(e.name);
        break;
      case "zone": {
        const zone = cfg.zones.find((z) => z.name === e.name);
        if (!zone) reject(`references zone ${e.name}, which no longer exists`);
        // The local zone is the box itself — not an interface set, and its
        // traffic never reaches qfappd's forward hook anyway.
        if (zone!.local) reject("is the firewall itself, which Application Control doesn't classify");
        ifaces.push(...zone!.interfaces);
        break;
      }
      case "alias": {
        const alias = cfg.aliases.find((a) => a.type === e.type && a.name === e.name);
        if (!alias) reject(`references alias ${e.name}, which no longer exists`);
        if (e.type === "fqdn") reject(`uses the FQDN alias ${e.name}, and qfappd matches addresses, not names`);
        if (alias!.members.length === 0) reject(`uses alias ${e.name}, which has no members`);
        // An interface alias resolves to its member interfaces, same as a zone.
        if (e.type === "iface") ifaces.push(...alias!.members);
        else addrs.push(...alias!.members);
        break;
      }
      case "inline":
        if (e.type === "fqdn") reject(`includes the domain ${e.value}, and qfappd matches addresses, not names`);
        addrs.push(e.value);
        break;
      case "address":
        addrs.push(e.address);
        break;
      case "ifgroup":
        reject(`uses interface group ${e.name}, which this editor can't resolve`);
        break;
      case "firewall":
        reject("is the firewall itself, which Application Control doesn't classify");
        break;
    }
  }

  for (const a of addrs) if (!AC_ADDR.test(a)) reject(`includes ${a}, which isn't an IPv4 address or network`);
  // qfappd rejects over-long interface names outright (nft's limit).
  for (const i of ifaces) if (i.length > 15) reject(`includes interface ${i}, whose name is too long`);
  return { ifaces: [...new Set(ifaces)], addrs: [...new Set(addrs)] };
}

/// Build an App Control binding match from a rule's From/To selections.
///
/// Throws when the rule can't be expressed — see sideMatch. A rule spanning
/// several zone pairs still needs only ONE binding: the match is derived from
/// the zones' interfaces, and qfappd classifies in its own forward-hook table
/// regardless of which ruleset accepted the traffic.
export function acMatchFromSelections(
  from: EndpointSelection,
  to: EndpointSelection,
  cfg: Pick<FirewallConfig, "aliases" | "zones">,
): AcMatch {
  const f = sideMatch(from, cfg, "From");
  const t = sideMatch(to, cfg, "To");
  const m: AcMatch = {};
  if (f.ifaces.length) m.iifname = f.ifaces;
  if (t.ifaces.length) m.oifname = t.ifaces;
  if (f.addrs.length) m.saddr = f.addrs;
  if (t.addrs.length) m.daddr = t.addrs;
  return m;
}

// ── command composition ───────────────────────────────────────────────────────

/// SSL inspection commands: drop this rule's entry at every number in
/// `removeRules`, then re-add it at `add.rule` when a choice is set. The remove
/// list carries a rule that changed number (chain switch) so nothing stale is
/// left behind.
function sslCommands(
  live: SslInspectionConfig,
  removeRules: number[],
  add: { rule: number; action: SslPolicyAction } | null,
): VyosCommand[] {
  const drop = new Set(removeRules);
  if (add) drop.add(add.rule);
  const policies = live.policies.filter((p) => !drop.has(p.rule));
  if (add) policies.push({ rule: add.rule, ruleset: "forward", action: add.action, enabled: true });
  policies.sort((a, b) => a.rule - b.rule);
  return diffSslInspection(live, { ...live, policies });
}

/// Geolocation commands: drop the policies left at any number this rule has
/// vacated, then bring its attachment in line with `add` (null = detached).
///
/// A rule spanning several zone pairs carries one policy per pair, so this
/// delegates to the per-rule diff rather than assuming a single policy.
function geoCommands(
  live: GeolocationConfig,
  removeRules: number[],
  rule: number,
  scopes: RuleChain[],
  add: { action: string; direction: GeoDirection } | null,
): VyosCommand[] {
  const out: VyosCommand[] = [];
  const stale = new Set(removeRules.filter((n) => n !== rule));
  for (const p of live.policies) {
    if (stale.has(p.rule)) {
      out.push({ op: "delete", path: ["service", "geolocation", "policy", String(p.id)] });
    }
  }
  out.push(
    ...diffGeoPoliciesForRule(
      live.policies,
      { rule, scopes: scopes.map((chain) => ({ chain })) },
      add?.action ?? null,
      add?.direction ?? "both",
    ),
  );
  return out;
}

/// Next App Control config with this rule's binding cleared at every number in
/// `removeRules` (and at `rule`) then re-added at `rule` when an action is set.
/// `changed` is false when the result is identical, so the PUT can be skipped.
function nextAcConfig(
  live: AcConfig,
  removeRules: number[],
  rule: number,
  description: string,
  match: AcMatch,
  action: string | null,
): { next: AcConfig; changed: boolean } | { error: string } {
  const drop = new Set(removeRules);
  drop.add(rule);
  const others = live.bindings.filter((b) => !drop.has(b.id));
  const bindings = [...others];
  if (action) {
    const wouldBind = new Set([...others.map((b) => b.action), action]);
    if (wouldBind.size > MAX_BOUND_AC_ACTIONS) {
      return {
        error: `At most ${MAX_BOUND_AC_ACTIONS} Application Control actions can be active at once. Reuse an action already in use.`,
      };
    }
    bindings.push({ id: rule, action, description, match });
  }
  bindings.sort((a, b) => a.id - b.id);
  const sortedLive = [...live.bindings].sort((a, b) => a.id - b.id);
  const changed = JSON.stringify(sortedLive) !== JSON.stringify(bindings);
  return { next: { ...live, bindings }, changed };
}

/// Effective scope a rule with these sides lands in — forward unless a Firewall
/// endpoint steers it into input/output, or a zone pair puts it in that pair's
/// ruleset. Falls back to forward for a selection diffRule will reject anyway
/// (both sides Firewall, a zone on one side only), which it reports with a
/// clear error at apply time.
function effectiveChain(u: RuleUpdate, cfg: FirewallConfig): RuleChain {
  try {
    return ruleChainFor(u.from, u.to, cfg.zones);
  } catch {
    return "forward";
  }
}

/// Apply a rule together with its SSL / Geolocation / App Control attachments.
///
/// The firewall rule plus the two VyOS-backed services go in a single guarded
/// commit (commit-confirm allows only one pending change at a time); App Control
/// is saved separately. Returns the number of applied changes (0 = no-op).
export async function applyRuleAndServices(
  live: FirewallRule | null,
  ruleUpdate: RuleUpdate,
  fwConfig: FirewallConfig,
  cfgs: RuleServiceConfigs,
  desired: RuleServiceState,
): Promise<number> {
  const chain = effectiveChain(ruleUpdate, fwConfig);
  // diffRule renumbers a rule that changes chain — mirror that so the bindings
  // key onto the number the rule actually lands at, and clean up the old one.
  const chainChanged = live != null && live.chain !== chain;
  const rule = chainChanged ? nextRuleNumber(fwConfig.rules) : ruleUpdate.rule;
  const removeRules = live && live.rule !== rule ? [live.rule] : [];

  // SSL binds forward Allow rules only; anything else detaches whatever was
  // there (the caller already forces `desired` empty when ineligible). Zone
  // rules are permanently ineligible for SSL: inspection steers in the NAT
  // prerouting hook, before the routing decision, so it can't match a pair's
  // destination zone (see quartzfire-ssl-inspection matchrepl.rs).
  const onForward = chain === "forward";
  const sslAdd = onForward && desired.ssl !== "off" ? { rule, action: desired.ssl } : null;
  // Geolocation follows the rule wherever it lives — qzgeo resolves a zone
  // pair's ruleset and folds the pair's interfaces into its replicated match.
  const geoAdd = desired.geo
    ? { action: desired.geo.action, direction: desired.geo.direction }
    : null;
  const scopes = ruleChainsFor(ruleUpdate.from, ruleUpdate.to, fwConfig.zones);

  // App Control classifies in its own forward-hook table, so it follows routed
  // rules — including zone rules between two network zones. Traffic to or from
  // the firewall never reaches that hook (sideMatch rejects it).
  const acAction = chain === "forward" || !isBaseChain(chain) ? desired.appcontrol : null;
  // Only derive the match when something is actually being bound: the
  // derivation throws on rules it can't express, and a rule with (say) an FQDN
  // alias must still be saveable without App Control on it.
  const acMatch = acAction ? acMatchFromSelections(ruleUpdate.from, ruleUpdate.to, fwConfig) : {};

  // App Control (non-guarded PUT) is validated first so a ceiling breach aborts
  // before we commit any firewall change.
  const acResult = nextAcConfig(
    cfgs.ac,
    removeRules,
    rule,
    ruleUpdate.name ?? `rule ${rule}`,
    acMatch,
    acAction,
  );
  if ("error" in acResult) throw new Error(acResult.error);

  const cmds: VyosCommand[] = [
    ...diffRule(live, ruleUpdate, fwConfig),
    ...sslCommands(cfgs.ssl, [rule, ...removeRules], sslAdd),
    ...geoCommands(cfgs.geo, removeRules, rule, scopes, geoAdd),
  ];

  const applied = await guardedCommitAndSave(cmds, "Firewall rule change");

  if (acResult.changed) {
    await saveAcConfig(acResult.next);
    return applied + 1;
  }
  return applied;
}
