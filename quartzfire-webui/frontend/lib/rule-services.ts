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

import {
  BaseChain,
  diffRule,
  EndpointSelection,
  FirewallConfig,
  FirewallRule,
  nextRuleNumber,
  RuleChain,
  ruleChainFor,
  RuleUpdate,
} from "./firewall";
import {
  diffSslInspection,
  SslInspectionConfig,
  SslPolicyAction,
} from "./ssl-inspection";
import {
  diffGeoPolicy,
  GeoDirection,
  GeolocationConfig,
  GeoPolicyUpdate,
  nextPolicyId,
} from "./geolocation";
import { AcConfig, AcMatch, saveAcConfig } from "./appcontrol";
import { guardedCommitAndSave } from "./guard";
import { VyosCommand } from "./interfaces";

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
export function serviceStateForRule(
  rule: number,
  chain: RuleChain,
  cfgs: RuleServiceConfigs,
): RuleServiceState {
  const sslPolicy = cfgs.ssl.policies.find((p) => p.rule === rule);
  const geoPolicy = cfgs.geo.policies.find((p) => p.rule === rule && p.ruleset === chain);
  const acBinding = cfgs.ac.bindings.find((b) => b.id === rule);
  return {
    ssl: sslPolicy && sslPolicy.enabled ? sslPolicy.action : "off",
    geo: geoPolicy ? { action: geoPolicy.action, direction: geoPolicy.direction } : null,
    appcontrol: acBinding ? acBinding.action : null,
  };
}

// ── App Control match derivation ──────────────────────────────────────────────

/// Coarse match extracted from one side of a rule — a single interface and/or a
/// single literal address. Alias/multi-entry sides can't be expressed here (same
/// best-effort limitation as the Application Control Policies tab).
function endpointMatch(sel: EndpointSelection): { iface?: string; addr?: string } {
  const ifaces = sel.filter((e) => e.kind === "interface");
  const addrs = sel.filter((e) => e.kind === "inline" || e.kind === "address");
  const out: { iface?: string; addr?: string } = {};
  if (ifaces.length === 1 && ifaces[0].kind === "interface") out.iface = ifaces[0].name;
  if (addrs.length === 1) {
    const a = addrs[0];
    out.addr = a.kind === "inline" ? a.value : a.kind === "address" ? a.address : undefined;
  }
  return out;
}

/// Build an App Control binding match from a rule's From/To selections.
export function acMatchFromSelections(from: EndpointSelection, to: EndpointSelection): AcMatch {
  const f = endpointMatch(from);
  const t = endpointMatch(to);
  const m: AcMatch = {};
  if (f.iface) m.iifname = [f.iface];
  if (t.iface) m.oifname = [t.iface];
  if (f.addr) m.saddr = [f.addr];
  if (t.addr) m.daddr = [t.addr];
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

/// Geolocation commands: delete the policies for every rule in `removeRules`
/// (except the one reused for the add), then attach/update `add`.
function geoCommands(
  live: GeolocationConfig,
  removeRules: number[],
  chain: BaseChain,
  add: { rule: number; action: string; direction: GeoDirection } | null,
): VyosCommand[] {
  const out: VyosCommand[] = [];
  const reuse = add
    ? live.policies.find((p) => p.rule === add.rule && p.ruleset === chain) ?? null
    : null;
  const drop = new Set(removeRules);
  if (add) drop.add(add.rule);
  for (const p of live.policies) {
    if (drop.has(p.rule) && p !== reuse) {
      out.push({ op: "delete", path: ["service", "geolocation", "policy", String(p.id)] });
    }
  }
  if (add) {
    const update: GeoPolicyUpdate = {
      id: reuse?.id ?? nextPolicyId(live.policies),
      action: add.action,
      ruleset: chain,
      rule: add.rule,
      direction: add.direction,
      enabled: true,
      original_id: reuse?.id ?? null,
    };
    out.push(...diffGeoPolicy(live.policies, update));
  }
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

  // Services bind forward Allow rules only; anything else detaches whatever was
  // there (the caller already forces `desired` empty when ineligible). Zone
  // rules are never eligible: qzgeo can only target `firewall ipv4 <chain>
  // filter`, and an App Control binding is keyed by forward rule number.
  const onForward = chain === "forward";
  const sslAdd = onForward && desired.ssl !== "off" ? { rule, action: desired.ssl } : null;
  const geoAdd =
    onForward && desired.geo
      ? { rule, action: desired.geo.action, direction: desired.geo.direction }
      : null;

  // App Control (non-guarded PUT) is validated first so a ceiling breach aborts
  // before we commit any firewall change.
  const acResult = nextAcConfig(
    cfgs.ac,
    removeRules,
    rule,
    ruleUpdate.name ?? `forward rule ${rule}`,
    acMatchFromSelections(ruleUpdate.from, ruleUpdate.to),
    onForward ? desired.appcontrol : null,
  );
  if ("error" in acResult) throw new Error(acResult.error);

  const cmds: VyosCommand[] = [
    ...diffRule(live, ruleUpdate, fwConfig),
    ...sslCommands(cfgs.ssl, [rule, ...removeRules], sslAdd),
    // Geolocation only ever attaches to forward rules (geoAdd is null for any
    // other scope), so forward is the only chain this can bind to — for a
    // non-forward rule the call just detaches stale policies by rule number.
    ...geoCommands(cfgs.geo, [rule, ...removeRules], "forward", geoAdd),
  ];

  const applied = await guardedCommitAndSave(cmds, "Firewall rule change");

  if (acResult.changed) {
    await saveAcConfig(acResult.next);
    return applied + 1;
  }
  return applied;
}
