// Cascade cleanup when a firewall rule is deleted. The security features that
// attach to a rule reference it by number, so deleting the rule alone leaves
// dangling references (a stale Application Control "Policies" count, a
// Geolocation policy pointing at a rule that no longer exists):
//
//   * Geolocation — `service geolocation policy N { rule M ruleset <chain> }`
//     is real VyOS config, so its deletes ride the SAME commit as the rule
//     (atomic; they revert together under commit-confirm).
//   * Application Control — bindings live in appcontrol.json (a desired-state
//     file edited through its own API), so that cleanup runs after the commit
//     lands. Only forward Allow rules are ever bound, so the binding id is the
//     forward rule number.
//   * IPS needs nothing here: it is enabled by the rule's own `action queue`,
//     which the rule delete already removes.
//
// This lives in its own module (not firewall.ts) because it imports the
// geolocation and appcontrol data layers, which themselves import firewall.ts —
// keeping it here avoids an import cycle.

import type { AutoGroup, FirewallConfig, FirewallRule } from "./firewall";
import { applyRuleOrder, deleteRule, isBaseChain, renumberByRule, renumberMap } from "./firewall";
import type { VyosCommand } from "./interfaces";
import { fetchGeolocation, policyBase } from "./geolocation";
import { fetchAcStatus, saveAcConfig } from "./appcontrol";

export interface RuleDeleteResult {
  /** Geolocation policy numbers removed alongside the rule. */
  removedGeoPolicies: number[];
  /** Whether an Application Control binding for the rule was removed. */
  removedAcBinding: boolean;
}

/// Delete a firewall rule and clean up the security-feature config that
/// referenced it. Feature cleanups are best-effort: a feature that isn't
/// installed (or is momentarily unreadable) is skipped, and only the App
/// Control step — which runs after the rule is already gone — can fail without
/// affecting the delete itself. If the rule delete throws, it propagates and no
/// App Control change is made.
export async function deleteRuleWithCascade(
  rule: FirewallRule,
  autoGroups: AutoGroup[],
  cfg?: FirewallConfig,
): Promise<RuleDeleteResult> {
  // 1. Geolocation policies targeting this exact (scope, rule) — a rule number
  //    is only unique within a scope, so match on both. A zone rule spans one
  //    scope per pair and carries a policy on each, so every scope is checked;
  //    matching only the representative would strand the rest. Deleted in the
  //    same commit as the rule.
  let geoDeletes: VyosCommand[] = [];
  let removedGeoPolicies: number[] = [];
  try {
    const geo = await fetchGeolocation();
    const orphans = geo.policies.filter(
      (p) => p.rule === rule.rule && rule.scopes.some((s) => s.chain === p.ruleset),
    );
    removedGeoPolicies = orphans.map((p) => p.id);
    geoDeletes = orphans.map((p) => ({ op: "delete", path: policyBase(p.id) }));
  } catch {
    /* geolocation feature absent/unreadable — nothing to clean up */
  }

  // `cfg` lets the delete also retire a zone pair whose last rule this was.
  await deleteRule(rule, autoGroups, geoDeletes, cfg);

  // 2. Application Control binding (separate JSON store). Routed rules can
  //    carry one — forward, and zone rules — so only traffic to/from the box
  //    itself is skipped. Best-effort: a failure here must not surface as a
  //    failed delete, since the rule is already gone.
  let removedAcBinding = false;
  if (rule.chain === "forward" || !isBaseChain(rule.chain)) {
    try {
      const { settings } = await fetchAcStatus();
      const bindings = settings.bindings.filter((b) => b.id !== rule.rule);
      if (bindings.length !== settings.bindings.length) {
        await saveAcConfig({ ...settings, bindings });
        removedAcBinding = true;
      }
    } catch {
      /* app-control feature absent/unreadable — skip */
    }
  }

  return { removedGeoPolicies, removedAcBinding };
}

export interface RuleReorderResult {
  /** Rules whose number changed. */
  renumbered: number;
  /** Geolocation policies repointed at a new rule number. */
  repointedGeoPolicies: number;
  /** Application Control bindings repointed at a new rule number. */
  repointedAcBindings: number;
}

/// Apply a new rule order and follow the renumber through the security features
/// that reference rules by number, so a reorder MOVES their config to the new
/// numbers instead of stranding it:
///
///   * Geolocation — each `service geolocation policy` keeps its own number;
///     only its `rule` leaf is re-set, in the SAME commit as the renumber.
///   * Application Control — binding ids are remapped afterward (separate JSON
///     store). Reading old ids and writing new ones in one pass handles the
///     two-rules-swap-numbers case correctly.
///   * IPS rides along on the rule's own `action queue`, rebuilt by the reorder.
export async function applyRuleOrderWithCascade(
  orderedRules: FirewallRule[],
): Promise<RuleReorderResult> {
  const moves = renumberMap(orderedRules);
  if (moves.size === 0) {
    return { renumbered: 0, repointedGeoPolicies: 0, repointedAcBindings: 0 };
  }

  // 1. Geolocation policy repoints → same commit as the renumber.
  const geoSets: VyosCommand[] = [];
  let repointedGeoPolicies = 0;
  try {
    const geo = await fetchGeolocation();
    for (const p of geo.policies) {
      const to = moves.get(`${p.ruleset}:${p.rule}`);
      if (to !== undefined) {
        geoSets.push({ op: "set", path: [...policyBase(p.id), "rule", String(to)] });
        repointedGeoPolicies++;
      }
    }
  } catch {
    /* geolocation feature absent/unreadable — skip */
  }

  const renumbered = await applyRuleOrder(orderedRules, geoSets);

  // 2. Application Control binding ids. A binding is keyed by rule NUMBER, not
  //    by scope — so it's repointed from the by-number map. (The old lookup
  //    hardcoded a `forward:` scope, which silently left a zone rule's binding
  //    pointing at whatever rule later took its number.)
  const byRule = renumberByRule(orderedRules);
  let repointedAcBindings = 0;
  try {
    const { settings } = await fetchAcStatus();
    let changed = false;
    const bindings = settings.bindings.map((b) => {
      const to = byRule.get(b.id);
      if (to === undefined) return b;
      changed = true;
      repointedAcBindings++;
      return { ...b, id: to };
    });
    if (changed) await saveAcConfig({ ...settings, bindings });
  } catch {
    /* app-control feature absent/unreadable — skip */
  }

  return { renumbered, repointedGeoPolicies, repointedAcBindings };
}
