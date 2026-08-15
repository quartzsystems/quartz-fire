"use client";

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import {
  ALIAS_GROUP,
  applyRule,
  AliasType,
  BaseChain,
  BUILTIN_POLICIES,
  EndpointEntry,
  EndpointSelection,
  FirewallConfig,
  FirewallRule,
  isBaseChain,
  nextRuleNumber,
  pairForChain,
  RuleAction,
  RuleChain,
  RulePolicyChoice,
  ruleChainFor,
  ruleSelection,
  rulesetName,
  RuleUpdate,
  validateInline,
} from "@/lib/firewall";
import {
  applyRuleAndServices,
  emptyRuleServiceState,
  RuleServiceConfigs,
  RuleServiceState,
  serviceStateForRule,
  SslServiceChoice,
} from "@/lib/rule-services";
import { emptySslInspectionConfig, fetchSslInspection } from "@/lib/ssl-inspection";
import { emptyGeolocationConfig, fetchGeolocation, GeoDirection } from "@/lib/geolocation";
import { emptyAcConfig, fetchAcStatus } from "@/lib/appcontrol";

const monoFont = { fontFamily: "var(--qz-font-mono)" } as const;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="clr-form-control" style={{ marginTop: 0 }}>
      <label className="clr-control-label">{label}</label>
      {children}
      {hint && <div className="clr-subtext">{hint}</div>}
    </div>
  );
}

const aliasKey = (type: AliasType, name: string) => `alias:${type}:${name}`;
const ifaceKey = (name: string) => `iface:${name}`;
const zoneKey = (name: string) => `zone:${name}`;
const FIREWALL_KEY = "builtin:firewall";

const INLINE_PLACEHOLDER: Record<AliasType, string> = {
  host: "192.168.1.10",
  network: "192.168.1.0/24",
  fqdn: "example.com",
  iface: "", // interfaces are never typed inline (picker only)
};

/// Add-menu / kind-line casing per the DC mock (IPv4 host, Interface group) —
/// ALIAS_GROUP keeps the short labels used by the inline-type select.
const ALIAS_TYPE_DISPLAY: Record<AliasType, string> = {
  host: "IPv4 host",
  network: "IPv4 network",
  fqdn: "FQDN",
  iface: "Interface group",
};

/// Built-in policy sentinels for the policy select — values no port-group can
/// be named (VyOS group names can't contain brackets). Ping writes `protocol
/// icmp`; the others seed a real port-group of that name on first use.
const PING_KEY = "[ping]";
const builtinKey = (name: string) => `[builtin:${name}]`;

const CHAIN_LABEL: Record<BaseChain, string> = {
  forward: "Forward filter",
  input: "Input filter",
  output: "Output filter",
};

/// Where a rule lives, in words — the base chain, or the zone pair whose
/// ruleset holds it ("IBM → WAN").
function chainLabel(chain: RuleChain, cfg: FirewallConfig): string {
  if (isBaseChain(chain)) return CHAIN_LABEL[chain];
  const pair = pairForChain(cfg.zone_pairs, chain);
  if (!pair) return rulesetName(chain) ?? "Zone";
  const name = (n: string) => cfg.zones.find((z) => z.name === n)?.display ?? n;
  return `${name(pair.src)} → ${name(pair.dst)}`;
}

/// List-entry label: friendly name first (interface description or alias
/// display name), with the technical name in the sub line.
function entryLabel(
  e: EndpointEntry,
  descriptions: Record<string, string> | undefined,
  aliases: FirewallConfig["aliases"],
  zones: FirewallConfig["zones"] = [],
): { main: string; sub: string } {
  switch (e.kind) {
    case "alias": {
      const display = aliases.find((a) => a.type === e.type && a.name === e.name)?.display ?? e.name;
      return { main: display, sub: ALIAS_TYPE_DISPLAY[e.type] };
    }
    case "zone":
      return { main: zones.find((z) => z.name === e.name)?.display ?? e.name, sub: "Zone" };
    case "interface": {
      const desc = descriptions?.[e.name];
      return desc ? { main: desc, sub: `${e.name} · Interface` } : { main: e.name, sub: "Interface" };
    }
    case "inline":
      return { main: e.value, sub: `Custom ${ALIAS_TYPE_DISPLAY[e.type]}` };
    case "firewall":
      return { main: "Firewall", sub: "This device" };
    case "ifgroup":
      return { main: e.name, sub: "Interface group" };
    case "address":
      return { main: e.address, sub: "Custom address" };
  }
}

/// From/To picker, WatchGuard style: a list of the entries the side matches
/// (any of them; empty = Any) with add/remove controls. The add dropdown only
/// offers entries VyOS can OR with what's already listed — interfaces and
/// addresses can't be mixed, host/network/FQDN kinds can't be combined, and
/// FQDN aliases stand alone (domain groups have no include). Below the
/// dropdown, a free-form input adds one-off hosts, networks, or FQDNs without
/// requiring an alias. The built-in Firewall entry (this device itself)
/// stands alone too, and only one side can carry it. Legacy entries (a
/// literal address or an interface-group written on the CLI) stay removable
/// but can't be newly added.
function EndpointField({
  label,
  interfaces,
  descriptions,
  aliases,
  zones,
  allowFirewall,
  otherSideZones,
  value,
  onChange,
}: {
  label: string;
  interfaces: string[];
  descriptions?: Record<string, string>;
  aliases: FirewallConfig["aliases"];
  zones: FirewallConfig["zones"];
  /** False when the other side already carries the Firewall entry. */
  allowFirewall: boolean;
  /** Zones on the other side — a rule can't go from a zone to itself. */
  otherSideZones: string[];
  value: EndpointSelection;
  onChange: (sel: EndpointSelection) => void;
}) {
  // An interface alias (a named interface-group) occupies the side's one
  // interface-match slot and stands alone — it can't be OR'd with more
  // interfaces (include support isn't verified) nor with address entries
  // (those would AND, not OR).
  const hasIfaceAlias = value.some((e) => e.kind === "alias" && e.type === "iface");
  const hasIface = value.some((e) => e.kind === "interface" || e.kind === "ifgroup") || hasIfaceAlias;
  const hasFirewall = value.some((e) => e.kind === "firewall");
  const hasZone = value.some((e) => e.kind === "zone");
  const aliasEntries = value.filter(
    (e): e is Extract<EndpointEntry, { kind: "alias" }> => e.kind === "alias" && e.type !== "iface",
  );
  const inlineEntries = value.filter((e) => e.kind === "inline");
  // Aliases and inline values share one family per side (they end up in one
  // VyOS group) — host, network, or FQDN.
  const familyType = aliasEntries[0]?.type ?? inlineEntries[0]?.type ?? null;
  // A legacy entry can't be OR-combined with anything — matches would AND.
  const hasLegacy = value.some((e) => e.kind === "ifgroup" || e.kind === "address");

  // A zone is an interface set, so the two can't be OR'd — the zone already
  // decides which interfaces match. Aliases can join a zone though: the zone
  // picks the ruleset, the alias narrows the match inside it.
  const zoneNames = value.filter((e) => e.kind === "zone").map((e) => (e as { name: string }).name);
  const addableIfaces =
    familyType || hasLegacy || hasFirewall || hasZone || hasIfaceAlias
      ? []
      : interfaces.filter((n) => !value.some((e) => e.kind === "interface" && e.name === n));
  const addableAliases = hasIface || hasLegacy || hasFirewall
    ? []
    : aliases.filter((a) => {
        if (value.some((e) => e.kind === "alias" && e.type === a.type && e.name === a.name)) return false;
        // An interface alias stands alone — only offered on an empty side.
        if (a.type === "iface") return value.length === 0;
        // FQDN aliases stand alone (domain groups have no include).
        if (familyType) return a.type === familyType && familyType !== "fqdn";
        return true;
      });
  const firewallAddable = allowFirewall && value.length === 0;
  // A side can carry several zones — the rule then spans one pair per
  // combination. A zone already on the other side isn't offered: that pair
  // would be zone-to-itself, which is intra-zone filtering, not a rule. The
  // local zone isn't offered either — it's the box itself, which the built-in
  // Firewall entry already says.
  const addableZones =
    hasIface || hasLegacy || hasFirewall
      ? []
      : zones.filter((z) => !z.local && !zoneNames.includes(z.name) && !otherSideZones.includes(z.name));

  // Inline values can join anything in the same family; an FQDN *alias*
  // blocks further FQDN entries (its domain group can't be included).
  const inlineAllowed =
    !hasIface && !hasLegacy && !hasFirewall && !(familyType === "fqdn" && aliasEntries.length > 0);

  const inlineTypes: AliasType[] = familyType ? [familyType] : ["host", "network", "fqdn"];
  const [inlineType, setInlineType] = useState<AliasType>("host");
  const [inlineValue, setInlineValue] = useState("");
  const [inlineError, setInlineError] = useState("");
  const effInlineType = inlineTypes.includes(inlineType) ? inlineType : inlineTypes[0];

  const canAdd =
    addableIfaces.length > 0 || addableAliases.length > 0 || addableZones.length > 0 || firewallAddable;

  const add = (v: string) => {
    if (v === FIREWALL_KEY) onChange([...value, { kind: "firewall" }]);
    else if (v.startsWith("zone:")) onChange([...value, { kind: "zone", name: v.slice("zone:".length) }]);
    else if (v.startsWith("iface:")) onChange([...value, { kind: "interface", name: v.slice("iface:".length) }]);
    else if (v.startsWith("alias:")) {
      const [, type, ...rest] = v.split(":");
      onChange([...value, { kind: "alias", type: type as AliasType, name: rest.join(":") }]);
    }
  };

  const addInline = () => {
    const v = inlineValue.trim();
    const err = validateInline(effInlineType, v);
    if (err) {
      setInlineError(err);
      return;
    }
    if (value.some((e) => e.kind === "inline" && e.type === effInlineType && e.value === v)) {
      setInlineError("Already in the list.");
      return;
    }
    setInlineError("");
    setInlineValue("");
    onChange([...value, { kind: "inline", type: effInlineType, value: v }]);
  };

  return (
    <Field label={label}>
      <div
        className="overflow-y-auto"
        style={{
          border: "1px solid var(--cds-alias-object-border-color)",
          borderRadius: 4,
          ...monoFont,
          minHeight: 88,
          maxHeight: 160,
          padding: value.length ? "4px 0" : 0,
        }}
      >
        {value.length === 0 ? (
          <div
            className="flex items-center justify-center h-[88px]"
            style={{ fontSize: 13, color: "var(--cds-alias-typography-color-200)" }}
          >
            Any
          </div>
        ) : (
          value.map((e, i) => {
            const { main, sub } = entryLabel(e, descriptions, aliases, zones);
            return (
              <div
                key={`${e.kind}:${main}:${i}`}
                className="group flex items-center gap-2 px-3 py-[5px]"
                style={{ fontSize: 13, color: "var(--cds-alias-typography-color-450)" }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{main}</span>
                <span
                  className="flex-shrink-0"
                  style={{ fontSize: 11, color: "var(--cds-alias-typography-color-200)" }}
                >
                  {sub}
                </span>
                <button
                  type="button"
                  onClick={() => onChange(value.filter((_, idx) => idx !== i))}
                  title={`Remove ${main}`}
                  className="btn btn-sm btn-link-neutral btn-icon ml-auto flex-shrink-0"
                  style={{ margin: "0 0 0 auto" }}
                >
                  <Icon shape="times" size={12} />
                </button>
              </div>
            );
          })
        )}
      </div>
      <div className="clr-select-wrapper" style={{ maxWidth: "none", marginTop: 8 }}>
        <select
          value=""
          onChange={(e) => add(e.target.value)}
          disabled={!canAdd}
          className="clr-select"
          style={{ maxWidth: "none", width: "100%", ...monoFont }}
        >
          <option value="" disabled>
            {canAdd ? "Add…" : "Nothing more can be added"}
          </option>
          {firewallAddable && (
            <optgroup label="Built-in">
              <option value={FIREWALL_KEY}>Firewall — this device itself</option>
            </optgroup>
          )}
          {addableZones.length > 0 && (
            <optgroup label="Zones">
              {addableZones.map((z) => (
                <option key={zoneKey(z.name)} value={zoneKey(z.name)}>
                  {z.display}
                </option>
              ))}
            </optgroup>
          )}
          {addableIfaces.length > 0 && (
            <optgroup label="Interfaces">
              {addableIfaces.map((n) => (
                <option key={ifaceKey(n)} value={ifaceKey(n)}>
                  {descriptions?.[n] ? `${descriptions[n]} (${n})` : n}
                </option>
              ))}
            </optgroup>
          )}
          {addableAliases.length > 0 && (
            <optgroup label="Aliases">
              {addableAliases.map((a) => (
                <option key={aliasKey(a.type, a.name)} value={aliasKey(a.type, a.name)}>
                  {a.display} ({ALIAS_TYPE_DISPLAY[a.type]})
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>
      {inlineAllowed && (
        <>
          <div className="flex gap-2 mt-2">
            <span className="clr-select-wrapper" style={{ width: 110, maxWidth: 110, flexShrink: 0 }}>
              <select
                value={effInlineType}
                onChange={(e) => {
                  setInlineType(e.target.value as AliasType);
                  setInlineError("");
                }}
                className="clr-select"
                style={{ maxWidth: "none", ...monoFont }}
              >
                {inlineTypes.map((t) => (
                  <option key={t} value={t}>
                    {ALIAS_GROUP[t].label}
                  </option>
                ))}
              </select>
            </span>
            <input
              value={inlineValue}
              onChange={(e) => setInlineValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addInline();
                }
              }}
              placeholder={INLINE_PLACEHOLDER[effInlineType]}
              className="clr-input"
              style={{ maxWidth: "none", flex: 1, ...monoFont }}
            />
            <button
              type="button"
              onClick={addInline}
              disabled={!inlineValue.trim()}
              className="btn btn-sm flex-shrink-0"
              style={{ margin: 0 }}
            >
              Add
            </button>
          </div>
          {inlineError && (
            <p className="m-0 mt-[5px]" style={{ fontSize: 11, color: "var(--cds-alias-status-danger)" }}>
              {inlineError}
            </p>
          )}
        </>
      )}
    </Field>
  );
}

/// Create/edit a filter rule (From → To with an action and a policy). Diffs
/// against the live config and commits immediately (the boot-config save runs in the background).
/// New rules are appended at the bottom — drag the table to reorder. A side
/// set to the built-in Firewall entry places the rule in the input/output
/// chain instead of forward.
export function RuleFormModal({
  initial,
  interfaces,
  descriptions,
  config,
  onClose,
  onSaved,
}: {
  /** Present when editing an existing rule; absent when creating. */
  initial?: FirewallRule;
  /** Firewall interface names offered in the From/To pickers. */
  interfaces: string[];
  /** Interface descriptions by name, shown next to the picker entries. */
  descriptions?: Record<string, string>;
  /** The full firewall config — aliases and policies for the pickers, rules
   *  for numbering, auto groups and group names for the endpoint diff. */
  config: FirewallConfig;
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const { aliases, policies, rules } = config;

  const [name, setName] = useState(initial?.name ?? "");
  const [action, setAction] = useState<RuleAction>(initial?.action ?? "accept");
  // `config` resolves the synthetic entries a rule's location implies — the
  // Firewall endpoint, and the zones of a pair rule. Without it a saved zone
  // rule would reopen with its zones missing from From/To.
  const [from, setFrom] = useState<EndpointSelection>(
    initial ? ruleSelection(initial, "from", config.auto_groups, config) : [],
  );
  const [to, setTo] = useState<EndpointSelection>(
    initial ? ruleSelection(initial, "to", config.auto_groups, config) : [],
  );
  const [policyName, setPolicyName] = useState(
    initial?.policy ?? (initial?.protocol === "icmp" ? PING_KEY : ""),
  );
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  // New rules log by default so they show in the Traffic Monitor.
  const [log, setLog] = useState(initial?.log ?? true);
  const [ips, setIps] = useState(initial?.ips ?? false);

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Per-rule security services (SSL Inspection, Geolocation, Application
  // Control) — the IPS siblings, each attachable to a forward Allow rule. Their
  // live configs are read once when the modal opens; the desired attachment
  // seeds from the rule's current bindings when editing.
  const [svcConfigs, setSvcConfigs] = useState<RuleServiceConfigs | null>(null);
  const [svc, setSvc] = useState<RuleServiceState>(emptyRuleServiceState());
  const [svcLoaded, setSvcLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [ssl, geo, ac] = await Promise.all([
        fetchSslInspection().catch(() => emptySslInspectionConfig()),
        fetchGeolocation().catch(() => emptyGeolocationConfig()),
        fetchAcStatus()
          .then((s) => s.settings ?? emptyAcConfig())
          .catch(() => emptyAcConfig()),
      ]);
      if (cancelled) return;
      const cfgs: RuleServiceConfigs = { ssl, geo, ac };
      setSvcConfigs(cfgs);
      // The rule's own scopes — a zone rule's geo policy hangs off its pairs'
      // rulesets, not off "forward".
      if (initial) {
        setSvc(serviceStateForRule(initial.rule, initial.scopes.map((s) => s.chain), cfgs));
      }
      setSvcLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [initial]);

  const chain = useMemo<RuleChain>(() => {
    try {
      return ruleChainFor(from, to, config.zones);
    } catch {
      return "forward";
    }
  }, [from, to, config.zones]);

  // Every service needs an Allow rule; where they diverge is scope.
  //   * Geolocation follows the rule anywhere — qzgeo resolves a zone pair's
  //     ruleset and folds the pair's interfaces into its replicated match.
  //   * App Control classifies in its own forward-hook table, so it covers
  //     routed rules: forward, and zone rules between two network zones.
  //   * SSL Inspection is forward-only, and structurally so — it steers in the
  //     NAT prerouting hook, before the routing decision, so it can't tell one
  //     destination zone from another (quartzfire-ssl-inspection matchrepl.rs).
  const isAllow = action === "accept";
  const geoEligible = isAllow;
  const acEligible = isAllow && (chain === "forward" || !isBaseChain(chain));
  const sslEligible = isAllow && chain === "forward";
  const servicesEligible = geoEligible || acEligible || sslEligible;

  const geoActions = svcConfigs?.geo.actions ?? [];
  const acActions = svcConfigs ? Object.keys(svcConfigs.ac.actions) : [];

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    let policy: RulePolicyChoice | null = null;
    const builtin = Object.keys(BUILTIN_POLICIES).find((n) => builtinKey(n) === policyName);
    if (policyName === PING_KEY) {
      policy = { kind: "ping" };
    } else if (builtin) {
      // The diff seeds the port-group itself when it doesn't exist yet.
      policy = { kind: "policy", name: builtin, protocol: BUILTIN_POLICIES[builtin].protocol };
    } else if (policyName) {
      const p = policies.find((pol) => pol.name === policyName);
      if (!p) {
        setError(`Policy ${policyName} no longer exists — refresh and try again.`);
        return;
      }
      policy = { kind: "policy", name: p.name, protocol: p.protocol };
    }

    setSaving(true);
    try {
      const rule = initial?.rule ?? nextRuleNumber(rules);
      const ruleUpdate: RuleUpdate = {
        rule,
        name: name.trim() || null,
        action,
        from,
        to,
        policy,
        enabled,
        log,
        ips,
      };
      // With the service configs in hand, apply the rule and its SSL / Geo / App
      // Control attachments in one shot (a single guarded commit for the
      // VyOS-backed ones, plus the App Control PUT). A rule that can't carry
      // services detaches any it previously had. Fall back to a plain rule apply
      // only if the service configs never loaded.
      const applied = svcConfigs
        ? await applyRuleAndServices(
            initial ?? null,
            ruleUpdate,
            config,
            svcConfigs,
            // Each service is filtered to what this rule's scope can carry, so
            // moving a rule into a zone detaches the ones that can't follow.
            {
              ssl: sslEligible ? svc.ssl : "off",
              geo: geoEligible ? svc.geo : null,
              appcontrol: acEligible ? svc.appcontrol : null,
            },
          )
        : await applyRule(initial ?? null, ruleUpdate, config);
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to rule ${rule}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply rule.");
    } finally {
      setSaving(false);
    }
  };

  return (
    // The DC mock renders this modal at the DS lg size (--clr-modal-lg-width).
    <ModalShell onClose={onClose} maxWidth={864}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Create"} Rule`}
        subtitle={isEdit ? `${chainLabel(initial!.chain, config)} rule ${initial!.rule}` : "New rules are added at the bottom — drag to reorder"}
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        {/* Name and Action share one row (name stretches, action hugs), per the DC mock. */}
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr auto", alignItems: "end" }}>
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Allow LAN to web"
              className="clr-input"
              style={{ maxWidth: "none" }}
            />
          </Field>

          <Field label="Action">
            <Segmented
              items={[
                { value: "accept", label: "Allow" },
                { value: "drop", label: "Deny" },
                { value: "reject", label: "Reject" },
              ]}
              value={action}
              onChange={(v) => setAction(v as RuleAction)}
            />
          </Field>
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <EndpointField
            label="From"
            interfaces={interfaces}
            descriptions={descriptions}
            aliases={aliases}
            zones={config.zones}
            allowFirewall={!to.some((e) => e.kind === "firewall")}
            otherSideZones={to.filter((e) => e.kind === "zone").map((e) => (e as { name: string }).name)}
            value={from}
            onChange={setFrom}
          />
          <EndpointField
            label="To"
            interfaces={interfaces}
            descriptions={descriptions}
            aliases={aliases}
            zones={config.zones}
            allowFirewall={!from.some((e) => e.kind === "firewall")}
            otherSideZones={from.filter((e) => e.kind === "zone").map((e) => (e as { name: string }).name)}
            value={to}
            onChange={setTo}
          />
        </div>
        <p className="m-0 -mt-2" style={{ fontSize: 11, lineHeight: "16px", color: "var(--cds-alias-typography-color-200)" }}>
          Traffic matches any entry in a list; an empty list matches everything. One list holds a single kind — hosts,
          networks, or FQDNs — and interfaces can&apos;t be mixed with addresses. The built-in Firewall entry matches
          this device itself.
        </p>

        <Field label="Policy" hint="The ports and protocol this rule matches. Manage sets under Firewall → Policies.">
          <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
            <select
              value={policyName}
              onChange={(e) => setPolicyName(e.target.value)}
              className="clr-select"
              style={{ maxWidth: "none", width: "100%", ...monoFont }}
            >
              <option value="">Any</option>
              <option value={PING_KEY}>Ping</option>
              {/* Built-ins step aside for a user policy of the same name. */}
              {Object.entries(BUILTIN_POLICIES)
                .filter(([n]) => !policies.some((p) => p.name === n))
                .map(([n, b]) => (
                  <option key={builtinKey(n)} value={builtinKey(n)}>
                    {n} — {b.protocol === "tcp_udp" ? "tcp+udp" : b.protocol}:{b.ports.join(",")}
                  </option>
                ))}
              {policies.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} — {p.protocol === "tcp_udp" ? "tcp+udp" : p.protocol}:{p.ports.join(",")}
                </option>
              ))}
            </select>
          </div>
        </Field>

        <div className="flex items-center gap-6">
          <label className="flex items-center gap-[10px] cursor-pointer select-none">
            <Switch on={enabled} onChange={setEnabled} />
            <span style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>Enabled</span>
          </label>
          <label className="flex items-center gap-[10px] cursor-pointer select-none">
            <Switch on={log} onChange={setLog} />
            <span style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>
              Log traffic (Traffic Monitor)
            </span>
          </label>
        </div>

        {action === "accept" && (
          <div
            className="flex flex-col gap-[10px] px-4 py-3"
            style={{ border: "1px solid var(--cds-alias-object-border-color)", borderRadius: 4 }}
          >
            <div className="flex items-center gap-2">
              <Icon shape="shield-check" size={14} style={{ color: "var(--cds-alias-typography-color-300)" }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--cds-alias-typography-color-450)" }}>
                Security services{" "}
                <span style={{ fontWeight: 400, color: "var(--cds-alias-typography-color-200)" }}>
                  — Allow rules only
                </span>
              </span>
            </div>
            {/* IPS lives on the rule itself, so it's available on any Allow rule
                (input/output/forward) — unlike the forward-only siblings below. */}
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <span
                className="w-[140px] flex-shrink-0"
                style={{ fontSize: 12, color: "var(--cds-alias-typography-color-300)" }}
              >
                IPS
              </span>
              <Switch on={ips} onChange={setIps} />
            </label>
            {servicesEligible &&
              (!svcLoaded ? (
                <span style={{ fontSize: 12, color: "var(--cds-alias-typography-color-200)" }}>Loading…</span>
              ) : (
                <div className="flex flex-col gap-[10px]">
                  {/* SSL Inspection — inspect / splice / off (no named policies). */}
                {sslEligible && (
                <div className="flex items-center gap-3">
                  <span
                    className="w-[140px] flex-shrink-0"
                    style={{ fontSize: 12, color: "var(--cds-alias-typography-color-300)" }}
                  >
                    SSL Inspection
                  </span>
                  <span className="clr-select-wrapper" style={{ maxWidth: "none", flex: 1 }}>
                    <select
                      value={svc.ssl}
                      onChange={(e) => setSvc((s) => ({ ...s, ssl: e.target.value as SslServiceChoice }))}
                      className="clr-select"
                      style={{ maxWidth: "none", width: "100%" }}
                    >
                      <option value="off">Off</option>
                      <option value="inspect">Inspect</option>
                      <option value="splice">Splice</option>
                    </select>
                  </span>
                </div>
                )}

                {/* Geolocation — a named action plus a match direction. */}
                <div className="flex items-center gap-3">
                  <span
                    className="w-[140px] flex-shrink-0"
                    style={{ fontSize: 12, color: "var(--cds-alias-typography-color-300)" }}
                  >
                    Geolocation
                  </span>
                  <span className="clr-select-wrapper" style={{ maxWidth: "none", flex: 1 }}>
                    <select
                      value={svc.geo?.action ?? ""}
                      onChange={(e) =>
                        setSvc((s) => ({
                          ...s,
                          geo: e.target.value
                            ? { action: e.target.value, direction: s.geo?.direction ?? "both" }
                            : null,
                        }))
                      }
                      className="clr-select"
                      style={{ maxWidth: "none", width: "100%" }}
                    >
                      <option value="">None</option>
                      {geoActions.map((a) => (
                        <option key={a.name} value={a.name}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </span>
                  {svc.geo && (
                    <Segmented
                      items={[
                        { value: "source", label: "Source" },
                        { value: "destination", label: "Dest" },
                        { value: "both", label: "Both" },
                      ]}
                      value={svc.geo.direction}
                      onChange={(v) =>
                        setSvc((s) => (s.geo ? { ...s, geo: { ...s.geo, direction: v as GeoDirection } } : s))
                      }
                    />
                  )}
                </div>

                {/* Application Control — a named action. */}
                {acEligible && (
                <div className="flex items-center gap-3">
                  <span
                    className="w-[140px] flex-shrink-0"
                    style={{ fontSize: 12, color: "var(--cds-alias-typography-color-300)" }}
                  >
                    Application Control
                  </span>
                  <span className="clr-select-wrapper" style={{ maxWidth: "none", flex: 1 }}>
                    <select
                      value={svc.appcontrol ?? ""}
                      onChange={(e) => setSvc((s) => ({ ...s, appcontrol: e.target.value || null }))}
                      className="clr-select"
                      style={{ maxWidth: "none", width: "100%" }}
                    >
                      <option value="">None</option>
                      {acActions.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </span>
                </div>
                )}

                {(geoActions.length === 0 || (acEligible && acActions.length === 0)) && (
                  <p className="m-0" style={{ fontSize: 11, color: "var(--cds-alias-typography-color-200)" }}>
                    Define actions on the Geolocation and Application Control pages to attach them here.
                  </p>
                )}
                </div>
              ))}
            {/* Standing scope explainer, per the DC mock. */}
            <p className="m-0" style={{ fontSize: 11, color: "var(--cds-alias-typography-color-200)" }}>
              SSL Inspection decides what to decrypt before the route is chosen, so it applies only to rules between
              interfaces or zones (forward). IPS follows the rule anywhere.
            </p>
          </div>
        )}

        {error && (
          <div className="alert alert-danger alert-sm">
            <Icon shape="exclamation-circle" size={14} className="alert-icon" />
            <div className="alert-text">{error}</div>
          </div>
        )}

        <ModalFooter>
          <button type="button" className="btn btn-neutral" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "Applying…" : isEdit ? "Apply Changes" : "Create Rule"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
