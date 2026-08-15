"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { applyNatRule, NatRule, NatSection } from "@/lib/nat";
import { ALIAS_GROUP, FirewallAlias, InterfaceAlias } from "@/lib/firewall";

const mono = { fontFamily: "var(--qz-font-mono)" } as const;
const wide = { maxWidth: "none" } as const;
const wideMono = { ...wide, ...mono } as const;

const PROTOCOLS = ["all", "tcp", "udp", "tcp_udp", "icmp", "esp", "gre"];

/// Built-in interface aliases resolve to the interface's connected IPv4
/// network — VyOS NAT has no interface match under `source`, so selecting one
/// writes `source address <network>`. The prefix keeps these apart from
/// `<type> <name>` group references in the same select.
const NET_PREFIX = "network:";

/// Clarity field: label + control + optional helper sentence.
function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="clr-form-control" style={{ marginTop: 0 }}>
      <label className="clr-control-label">
        {label}
        {required && <span className="clr-required">*</span>}
      </label>
      {children}
      {hint && <div className="clr-subtext">{hint}</div>}
    </div>
  );
}

/// Create/edit a single NAT44 source (SNAT) or destination (DNAT) rule.
/// Diffs against the live config and commits immediately (the boot-config save runs in the background).
export function NatRuleFormModal({
  section,
  initial,
  interfaces,
  descriptions,
  aliases,
  builtins,
  existing,
  takenRules,
  onClose,
  onSaved,
}: {
  section: NatSection;
  /** Present when editing an existing rule; absent when creating. */
  initial?: NatRule;
  /** Interface names offered in the interface picker. */
  interfaces: string[];
  /** Interface descriptions by name, shown next to the picker entries. */
  descriptions?: Record<string, string>;
  /** Firewall aliases offered as source matches (host/network only). */
  aliases: FirewallAlias[];
  /** Built-in interface aliases, offered as their connected IPv4 networks. */
  builtins: InterfaceAlias[];
  /** Existing rules in this section, for duplicate detection and diffing. */
  existing: NatRule[];
  /** Rule numbers used by 1-to-1 mappings (unavailable here). */
  takenRules: number[];
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const isSource = section === "source";

  const [rule, setRule] = useState(initial ? String(initial.rule) : "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [iface, setIface] = useState(initial?.interface ?? interfaces[0] ?? "");
  const [sourceAddress, setSourceAddress] = useState(initial?.source ?? "");
  // A rule whose source address is exactly a built-in interface network opens
  // showing that alias, so a rule created from one round-trips.
  const initialNet =
    initial?.source && builtins.some((b) => b.networks.includes(initial.source!))
      ? `${NET_PREFIX}${initial.source}`
      : null;
  // Source match is an address or an alias (a firewall-group reference stored
  // as `<type> <name>`, or a built-in interface network), mutually exclusive.
  const [sourceMode, setSourceMode] = useState<"address" | "alias">(
    initial?.source_group || initialNet ? "alias" : "address",
  );
  const [sourceGroup, setSourceGroup] = useState(initial?.source_group ?? initialNet ?? "");
  const [sourcePort, setSourcePort] = useState(initial?.source_port ?? "");
  const [destAddress, setDestAddress] = useState(initial?.destination ?? "");
  const [destPort, setDestPort] = useState(initial?.destination_port ?? "");
  // Source rules default to masquerade; anything else translates to an address.
  const [masquerade, setMasquerade] = useState(
    isSource && (initial ? initial.translation === "masquerade" || initial.translation === null : true),
  );
  const [translationAddress, setTranslationAddress] = useState(
    initial?.translation && initial.translation !== "masquerade" ? initial.translation : "",
  );
  const [translationPort, setTranslationPort] = useState(initial?.translation_port ?? "");
  // VyOS treats an unset protocol as "all"; show that explicitly so the field is never blank.
  const [protocol, setProtocol] = useState(initial?.protocol ?? "all");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Keep the current value selectable even if it's missing from the list.
  const ifaceOptions = [...new Set([iface, ...interfaces].filter(Boolean))];

  // Built-in interface aliases, one option per connected IPv4 network (an
  // unaddressed or DHCP interface has none to offer).
  const builtinOptions = builtins.flatMap((b) =>
    b.networks.map((net) => ({ value: `${NET_PREFIX}${net}`, label: `${b.display} — ${net}` })),
  );
  // Host/network aliases as `<type> <name>` group references. VyOS NAT also
  // accepts domain/mac groups, but subnets and hosts are what SNAT wants.
  const aliasOptions = aliases
    .filter((a) => a.type === "host" || a.type === "network")
    .map((a) => ({
      value: `${ALIAS_GROUP[a.type].node} ${a.name}`,
      label: `${a.display} (${ALIAS_GROUP[a.type].label})`,
    }));
  // Keep a group configured outside the Aliases page (CLI, other type) selectable.
  if (
    sourceGroup &&
    !sourceGroup.startsWith(NET_PREFIX) &&
    !aliasOptions.some((o) => o.value === sourceGroup)
  ) {
    aliasOptions.unshift({ value: sourceGroup, label: sourceGroup });
  }
  const hasAliasOptions = builtinOptions.length > 0 || aliasOptions.length > 0;

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const num = Number(rule);
    if (!Number.isInteger(num) || num < 1 || num > 999999) {
      setError("Rule number must be a whole number between 1 and 999999.");
      return;
    }
    // Block collisions with another rule in this section (allow re-saving the edited one).
    const clash = existing.some((r) => r.rule === num && !(isEdit && r.rule === initial!.rule));
    if (clash) {
      setError(`Rule ${num} already exists in this section.`);
      return;
    }
    if (takenRules.includes(num)) {
      setError(`Rule ${num} is already used by a 1-to-1 NAT mapping.`);
      return;
    }
    if (!masquerade && translationAddress.trim() === "") {
      setError(isSource ? "Enter a translation address, or use masquerade." : "Enter a forward-to address.");
      return;
    }
    if (sourceMode === "alias" && !sourceGroup) {
      setError("Choose a source alias, or switch the source match to an address.");
      return;
    }

    // A built-in interface alias is stored as a plain source address (its
    // network); only user aliases become group references.
    const netAlias = sourceGroup.startsWith(NET_PREFIX) ? sourceGroup.slice(NET_PREFIX.length) : null;

    setSaving(true);
    try {
      const applied = await applyNatRule(existing, {
        section,
        rule: num,
        description: description.trim() || null,
        interface: iface.trim() || null,
        source_address: sourceMode === "address" ? sourceAddress.trim() || null : netAlias,
        source_group: sourceMode === "alias" && !netAlias ? sourceGroup || null : null,
        source_port: sourcePort.trim() || null,
        destination_address: destAddress.trim() || null,
        destination_port: destPort.trim() || null,
        translation_address: masquerade ? "masquerade" : translationAddress.trim(),
        translation_port: masquerade ? null : translationPort.trim() || null,
        // "all" is the VyOS default — store it as unset rather than an explicit leaf.
        protocol: protocol.trim() && protocol.trim().toLowerCase() !== "all" ? protocol.trim() : null,
        enabled,
        original_rule: initial?.rule ?? null,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to ${section} NAT rule ${num}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply NAT rule.");
    } finally {
      setSaving(false);
    }
  };

  const ifaceLabel = isSource ? "Outbound interface" : "Inbound interface";

  return (
    <ModalShell onClose={onClose} maxWidth={560}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Create"} ${isSource ? "Source" : "Destination"} NAT Rule`}
        subtitle={isSource ? "IPv4 SNAT / Masquerade" : "IPv4 DNAT / Port-Forward"}
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <datalist id="nat44-protocols">
          {PROTOCOLS.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>

        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Rule number" required>
            <input
              type="number"
              min={1}
              max={999999}
              value={rule}
              onChange={(e) => setRule(e.target.value)}
              placeholder="100"
              className="clr-input"
              style={wideMono}
            />
          </Field>
          <Field label="Protocol">
            <input
              list="nat44-protocols"
              value={protocol}
              onChange={(e) => setProtocol(e.target.value)}
              placeholder="all"
              className="clr-input"
              style={wideMono}
            />
          </Field>
        </div>

        <Field label="Description">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={isSource ? "Office Outbound NAT" : "Web Server Port-Forward"}
            className="clr-input"
            style={wide}
          />
        </Field>

        <Field label={ifaceLabel} hint="Interface this rule applies to.">
          {ifaceOptions.length > 0 ? (
            <div className="clr-select-wrapper" style={wide}>
              <select
                value={iface}
                onChange={(e) => setIface(e.target.value)}
                className="clr-select"
                style={wideMono}
              >
                {ifaceOptions.map((n) => (
                  <option key={n} value={n}>
                    {descriptions?.[n] ? `${n} — ${descriptions[n]}` : n}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <input
              value={iface}
              onChange={(e) => setIface(e.target.value)}
              placeholder="eth0"
              className="clr-input"
              style={wideMono}
            />
          )}
        </Field>

        <div className="grid" style={{ gridTemplateColumns: "2fr 1fr", gap: 12 }}>
          <Field
            label="Source"
            hint={
              sourceMode === "alias"
                ? "Interface networks come from each interface's address; aliases are managed under Firewall → Aliases."
                : undefined
            }
          >
            <div className="flex gap-2">
              <div style={{ flexShrink: 0 }}>
                <Segmented
                  items={[
                    { value: "address", label: "Address" },
                    { value: "alias", label: "Alias" },
                  ]}
                  value={sourceMode}
                  onChange={(v) => setSourceMode(v as "address" | "alias")}
                />
              </div>
              <div className="flex-1 min-w-0">
                {sourceMode === "address" ? (
                  <input
                    value={sourceAddress}
                    onChange={(e) => setSourceAddress(e.target.value)}
                    placeholder={isSource ? "10.0.0.0/24" : "any"}
                    className="clr-input"
                    style={wideMono}
                  />
                ) : (
                  <div className="clr-select-wrapper" style={wide}>
                    <select
                      value={sourceGroup}
                      onChange={(e) => setSourceGroup(e.target.value)}
                      className="clr-select"
                      style={wideMono}
                    >
                      <option value="" disabled>
                        {hasAliasOptions ? "Select alias…" : "No aliases defined"}
                      </option>
                      {builtinOptions.length > 0 && (
                        <optgroup label="Interface networks">
                          {builtinOptions.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {aliasOptions.length > 0 && (
                        <optgroup label="Aliases">
                          {aliasOptions.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  </div>
                )}
              </div>
            </div>
          </Field>
          <Field label="Source port">
            <input
              value={sourcePort}
              onChange={(e) => setSourcePort(e.target.value)}
              placeholder="any"
              className="clr-input"
              style={wideMono}
            />
          </Field>
        </div>

        <div className="grid" style={{ gridTemplateColumns: "2fr 1fr", gap: 12 }}>
          <Field label="Destination address">
            <input
              value={destAddress}
              onChange={(e) => setDestAddress(e.target.value)}
              placeholder={isSource ? "any" : "203.0.113.5"}
              className="clr-input"
              style={wideMono}
            />
          </Field>
          <Field label="Destination port">
            <input
              value={destPort}
              onChange={(e) => setDestPort(e.target.value)}
              placeholder={isSource ? "any" : "443"}
              className="clr-input"
              style={wideMono}
            />
          </Field>
        </div>

        {isSource && (
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <Switch on={masquerade} onChange={setMasquerade} />
            <span style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>
              Masquerade (use the outbound interface address)
            </span>
          </label>
        )}

        {!masquerade && (
          <div className="grid" style={{ gridTemplateColumns: "2fr 1fr", gap: 12 }}>
            <Field
              label={isSource ? "Translation address" : "Forward-to address"}
              required
              hint="An IP, CIDR block, or range (192.168.1.10-192.168.1.20)."
            >
              <input
                value={translationAddress}
                onChange={(e) => setTranslationAddress(e.target.value)}
                placeholder="192.168.1.10"
                className="clr-input"
                style={wideMono}
              />
            </Field>
            <Field label="Translation port">
              <input
                value={translationPort}
                onChange={(e) => setTranslationPort(e.target.value)}
                placeholder="keep original"
                className="clr-input"
                style={wideMono}
              />
            </Field>
          </div>
        )}

        <label className="flex items-center gap-2 cursor-pointer select-none">
          <Switch on={enabled} onChange={setEnabled} />
          <span style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>Enabled</span>
        </label>

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
