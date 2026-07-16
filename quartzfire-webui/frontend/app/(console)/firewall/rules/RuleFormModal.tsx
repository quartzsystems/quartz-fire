"use client";

import { useEffect, useMemo, useState } from "react";
import { ShieldCheck, X } from "lucide-react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import {
  ALIAS_GROUP,
  applyRule,
  AliasType,
  BUILTIN_POLICIES,
  EndpointEntry,
  EndpointSelection,
  FirewallConfig,
  FirewallRule,
  nextRuleNumber,
  PROTOCOL_LABEL,
  RuleAction,
  RuleChain,
  RulePolicyChoice,
  ruleChainFor,
  ruleSelection,
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

const inputCls = "w-full rounded-md px-3 py-[9px] text-[13px] text-[var(--qz-fg-1)] outline-none";
const inputSt = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;
const monoSt = { ...inputSt, fontFamily: "var(--qz-font-mono)" } as const;

function focusBorder(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) {
  e.currentTarget.style.borderColor = "var(--qz-accent)";
}
function blurBorder(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) {
  e.currentTarget.style.borderColor = "var(--qz-border)";
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[12px] text-[var(--qz-fg-3)] mb-[6px]">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-[var(--qz-fg-4)] m-0 mt-[5px]">{hint}</p>}
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
};

/// Built-in policy sentinels for the policy select — values no port-group can
/// be named (VyOS group names can't contain brackets). Ping writes `protocol
/// icmp`; the others seed a real port-group of that name on first use.
const PING_KEY = "[ping]";
const builtinKey = (name: string) => `[builtin:${name}]`;

const CHAIN_LABEL: Record<RuleChain, string> = {
  forward: "Forward filter",
  input: "Input filter",
  output: "Output filter",
};

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
      return { main: display, sub: ALIAS_GROUP[e.type].label };
    }
    case "zone":
      return { main: zones.find((z) => z.name === e.name)?.display ?? e.name, sub: "Zone" };
    case "interface": {
      const desc = descriptions?.[e.name];
      return desc ? { main: desc, sub: `${e.name} · Interface` } : { main: e.name, sub: "Interface" };
    }
    case "inline":
      return { main: e.value, sub: `Custom ${ALIAS_GROUP[e.type].label}` };
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
  value: EndpointSelection;
  onChange: (sel: EndpointSelection) => void;
}) {
  const hasIface = value.some((e) => e.kind === "interface" || e.kind === "ifgroup");
  const hasFirewall = value.some((e) => e.kind === "firewall");
  const hasZone = value.some((e) => e.kind === "zone");
  const aliasEntries = value.filter((e) => e.kind === "alias");
  const inlineEntries = value.filter((e) => e.kind === "inline");
  // Aliases and inline values share one family per side (they end up in one
  // VyOS group) — host, network, or FQDN.
  const familyType = aliasEntries[0]?.type ?? inlineEntries[0]?.type ?? null;
  // A legacy entry can't be OR-combined with anything — matches would AND.
  const hasLegacy = value.some((e) => e.kind === "ifgroup" || e.kind === "address");

  // A zone is an interface set, so the two can't be OR'd — the zone already
  // decides which interfaces match. Aliases can join a zone though: the zone
  // picks the ruleset, the alias narrows the match inside it.
  const addableIfaces =
    familyType || hasLegacy || hasFirewall || hasZone
      ? []
      : interfaces.filter((n) => !value.some((e) => e.kind === "interface" && e.name === n));
  const addableAliases = hasIface || hasLegacy || hasFirewall
    ? []
    : aliases.filter((a) => {
        if (value.some((e) => e.kind === "alias" && e.type === a.type && e.name === a.name)) return false;
        // FQDN aliases stand alone (domain groups have no include).
        if (familyType) return a.type === familyType && familyType !== "fqdn";
        return true;
      });
  const firewallAddable = allowFirewall && value.length === 0;
  // One zone per side: a rule belongs to exactly one zone pair. The local zone
  // isn't offered — it's the box itself, which the Firewall entry already says.
  const addableZones = hasIface || hasLegacy || hasFirewall || hasZone ? [] : zones.filter((z) => !z.local);

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
        className="rounded-md overflow-y-auto"
        style={{ ...monoSt, minHeight: 96, maxHeight: 160, padding: value.length ? "4px 0" : 0 }}
      >
        {value.length === 0 ? (
          <div className="flex items-center justify-center h-[96px] text-[13px] text-[var(--qz-fg-4)]">Any</div>
        ) : (
          value.map((e, i) => {
            const { main, sub } = entryLabel(e, descriptions, aliases, zones);
            return (
              <div
                key={`${e.kind}:${main}:${i}`}
                className="group flex items-center gap-2 px-3 py-[5px] text-[13px] text-[var(--qz-fg-1)]"
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{main}</span>
                <span className="text-[11px] text-[var(--qz-fg-4)] flex-shrink-0">{sub}</span>
                <button
                  type="button"
                  onClick={() => onChange(value.filter((_, idx) => idx !== i))}
                  title={`Remove ${main}`}
                  className="ml-auto flex-shrink-0 flex items-center justify-center w-[18px] h-[18px] rounded cursor-pointer border-0 text-[var(--qz-fg-4)] hover:text-[var(--qz-fg-1)]"
                  style={{ background: "transparent" }}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })
        )}
      </div>
      <select
        value=""
        onChange={(e) => add(e.target.value)}
        disabled={!canAdd}
        className={`${inputCls} cursor-pointer mt-2`}
        style={{ ...monoSt, opacity: canAdd ? 1 : 0.5 }}
        onFocus={focusBorder}
        onBlur={blurBorder}
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
                {a.display} ({ALIAS_GROUP[a.type].label})
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {inlineAllowed && (
        <>
          <div className="flex gap-2 mt-2">
            <select
              value={effInlineType}
              onChange={(e) => {
                setInlineType(e.target.value as AliasType);
                setInlineError("");
              }}
              className={`${inputCls} cursor-pointer`}
              style={{ ...monoSt, width: 110, flexShrink: 0 }}
              onFocus={focusBorder}
              onBlur={blurBorder}
            >
              {inlineTypes.map((t) => (
                <option key={t} value={t}>
                  {ALIAS_GROUP[t].label}
                </option>
              ))}
            </select>
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
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
            <button
              type="button"
              onClick={addInline}
              disabled={!inlineValue.trim()}
              className="px-3 rounded-md text-[13px] font-medium cursor-pointer flex-shrink-0"
              style={{
                background: "transparent",
                border: "1px solid var(--qz-border)",
                color: "var(--qz-fg-2)",
                opacity: inlineValue.trim() ? 1 : 0.5,
              }}
            >
              Add
            </button>
          </div>
          {inlineError && (
            <p className="text-[11px] m-0 mt-[5px]" style={{ color: "var(--qz-danger)" }}>
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
  const [from, setFrom] = useState<EndpointSelection>(
    initial ? ruleSelection(initial, "from", config.auto_groups) : [],
  );
  const [to, setTo] = useState<EndpointSelection>(
    initial ? ruleSelection(initial, "to", config.auto_groups) : [],
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
      if (initial) setSvc(serviceStateForRule(initial.rule, "forward", cfgs));
      setSvcLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [initial]);

  // Services attach only to forward Allow rules (matching the SSL / App Control
  // Policies tabs). A Firewall-endpoint side steers the rule out of the forward
  // chain, and a zone puts it in that pair's ruleset, so both are ineligible.
  const chain = useMemo<RuleChain>(() => {
    try {
      return ruleChainFor(from, to, config.zones);
    } catch {
      return "forward";
    }
  }, [from, to, config.zones]);
  const servicesEligible = action === "accept" && chain === "forward";

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
            servicesEligible ? svc : emptyRuleServiceState(),
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
    <ModalShell onClose={onClose} maxWidth={640}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Create"} Rule`}
        subtitle={isEdit ? `${CHAIN_LABEL[initial!.chain]} rule ${initial!.rule}` : "New rules are added at the bottom — drag to reorder"}
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Allow LAN to Web"
            className={inputCls}
            style={inputSt}
            onFocus={focusBorder}
            onBlur={blurBorder}
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

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <EndpointField
            label="From"
            interfaces={interfaces}
            descriptions={descriptions}
            aliases={aliases}
            zones={config.zones}
            allowFirewall={!to.some((e) => e.kind === "firewall")}
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
            value={to}
            onChange={setTo}
          />
        </div>
        <p className="text-[11px] text-[var(--qz-fg-4)] m-0 -mt-2">
          Traffic matches any entry in a list; an empty list matches everything. Hosts, networks, and FQDNs can be
          typed in directly or come from aliases, but one list holds a single kind — and interfaces can&apos;t be mixed
          with addresses. The built-in Firewall entry matches this device itself — use it to control management
          access, pings, and other traffic to or from the firewall.
        </p>

        <Field
          label="Policy"
          hint={policies.length === 0 ? "No policies defined yet — create them under Firewall › Policies." : "The ports and protocol this rule matches."}
        >
          <select
            value={policyName}
            onChange={(e) => setPolicyName(e.target.value)}
            className={`${inputCls} cursor-pointer`}
            style={monoSt}
            onFocus={focusBorder}
            onBlur={blurBorder}
          >
            <option value="">Any</option>
            <option value={PING_KEY}>Ping</option>
            {/* Built-ins step aside for a user policy of the same name. */}
            {Object.entries(BUILTIN_POLICIES)
              .filter(([n]) => !policies.some((p) => p.name === n))
              .map(([n, b]) => (
                <option key={builtinKey(n)} value={builtinKey(n)}>
                  {n} — {PROTOCOL_LABEL[b.protocol].toLowerCase()}:{b.ports.join(",")}
                </option>
              ))}
            {policies.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name} — {PROTOCOL_LABEL[p.protocol].toLowerCase()}:{p.ports.join(",")}
              </option>
            ))}
          </select>
        </Field>

        <div className="flex items-center gap-6">
          <label className="flex items-center gap-[10px] cursor-pointer select-none">
            <Switch on={enabled} onChange={setEnabled} />
            <span className="text-[13px] text-[var(--qz-fg-2)]">Enabled</span>
          </label>
          <label className="flex items-center gap-[10px] cursor-pointer select-none">
            <Switch on={log} onChange={setLog} />
            <span className="text-[13px] text-[var(--qz-fg-2)]">Log traffic (Traffic Monitor)</span>
          </label>
        </div>

        {action === "accept" && (
          <div
            className="flex flex-col gap-3 rounded-md px-4 py-3"
            style={{ background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" }}
          >
            <div className="flex items-center gap-2">
              <ShieldCheck size={14} className="text-[var(--qz-fg-3)]" />
              <span className="text-[12px] font-semibold text-[var(--qz-fg-1)]">Security services</span>
            </div>
            {/* IPS lives on the rule itself, so it's available on any Allow rule
                (input/output/forward) — unlike the forward-only siblings below. */}
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <span className="text-[12px] text-[var(--qz-fg-3)] w-[132px] flex-shrink-0">IPS</span>
              <Switch on={ips} onChange={setIps} />
            </label>
            {servicesEligible &&
              (!svcLoaded ? (
                <span className="text-[12px] text-[var(--qz-fg-4)]">Loading…</span>
              ) : (
                <div className="flex flex-col gap-[10px]">
                  {/* SSL Inspection — inspect / splice / off (no named policies). */}
                <div className="flex items-center gap-3">
                  <span className="text-[12px] text-[var(--qz-fg-3)] w-[132px] flex-shrink-0">SSL Inspection</span>
                  <select
                    value={svc.ssl}
                    onChange={(e) => setSvc((s) => ({ ...s, ssl: e.target.value as SslServiceChoice }))}
                    className="flex-1 rounded-md px-3 py-[7px] text-[13px] text-[var(--qz-fg-1)] outline-none cursor-pointer"
                    style={inputSt}
                    onFocus={focusBorder}
                    onBlur={blurBorder}
                  >
                    <option value="off">Off</option>
                    <option value="inspect">Inspect</option>
                    <option value="splice">Splice</option>
                  </select>
                </div>

                {/* Geolocation — a named action plus a match direction. */}
                <div className="flex items-center gap-3">
                  <span className="text-[12px] text-[var(--qz-fg-3)] w-[132px] flex-shrink-0">Geolocation</span>
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
                    className="flex-1 rounded-md px-3 py-[7px] text-[13px] text-[var(--qz-fg-1)] outline-none cursor-pointer"
                    style={inputSt}
                    onFocus={focusBorder}
                    onBlur={blurBorder}
                  >
                    <option value="">None</option>
                    {geoActions.map((a) => (
                      <option key={a.name} value={a.name}>
                        {a.name}
                      </option>
                    ))}
                  </select>
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
                <div className="flex items-center gap-3">
                  <span className="text-[12px] text-[var(--qz-fg-3)] w-[132px] flex-shrink-0">Application Control</span>
                  <select
                    value={svc.appcontrol ?? ""}
                    onChange={(e) => setSvc((s) => ({ ...s, appcontrol: e.target.value || null }))}
                    className="flex-1 rounded-md px-3 py-[7px] text-[13px] text-[var(--qz-fg-1)] outline-none cursor-pointer"
                    style={inputSt}
                    onFocus={focusBorder}
                    onBlur={blurBorder}
                  >
                    <option value="">None</option>
                    {acActions.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>

                {(geoActions.length === 0 || acActions.length === 0) && (
                  <p className="text-[11px] text-[var(--qz-fg-4)] m-0">
                    Define actions on the Geolocation and Application Control pages to attach them here.
                  </p>
                )}
                </div>
              ))}
          </div>
        )}

        {error && (
          <p className="text-[12px] m-0" style={{ color: "var(--qz-danger)" }}>
            {error}
          </p>
        )}

        <div className="flex gap-2 justify-end mt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-[9px] rounded-md text-[13px] font-medium cursor-pointer"
            style={{ background: "transparent", border: "1px solid var(--qz-border)", color: "var(--qz-fg-2)" }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-[9px] rounded-md text-[13px] font-semibold cursor-pointer border-0"
            style={{ background: "var(--qz-accent)", color: "var(--qz-fg-on-accent)", opacity: saving ? 0.7 : 1 }}
          >
            {saving ? "Applying…" : isEdit ? "Apply changes" : "Create rule"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
