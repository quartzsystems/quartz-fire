"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { ALIAS_GROUP, AliasType, applyAlias, FirewallAlias, sanitizeAliasName } from "@/lib/firewall";

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

// Friendly names may contain spaces — the backing VyOS group name can't, so
// spaces become hyphens on save (see sanitizeAliasName).
const NAME_RE = /^[A-Za-z][A-Za-z0-9 _-]*$/;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV4_RANGE_RE = /^(\d{1,3}\.){3}\d{1,3}-(\d{1,3}\.){3}\d{1,3}$/;
const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/([0-9]|[12][0-9]|3[0-2])$/;
const FQDN_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

const MEMBER_INFO: Record<AliasType, { placeholder: string; hint: string; valid: (m: string) => boolean }> = {
  host: {
    placeholder: "172.16.20.2\n172.16.20.10-172.16.20.20",
    hint: "One IPv4 address or range per line.",
    valid: (m) => IPV4_RE.test(m) || IPV4_RANGE_RE.test(m),
  },
  network: {
    placeholder: "172.16.20.0/24",
    hint: "One IPv4 network in CIDR notation per line.",
    valid: (m) => CIDR_RE.test(m),
  },
  fqdn: {
    placeholder: "vpn.example.com",
    hint: "One fully-qualified domain name per line. No wildcards — VyOS resolves each name to its DNS addresses, and subdomains are not covered.",
    valid: (m) => FQDN_RE.test(m),
  },
  // Interface members come from the checkbox picker, never the textarea — this
  // entry only satisfies the Record and validates leftovers defensively.
  iface: {
    placeholder: "eth9.20",
    hint: "Pick the member interfaces below.",
    valid: (m) => /^[a-z][a-z0-9.-]*$/i.test(m),
  },
};

/// Create/edit an alias (a named host / network / FQDN group). Diffs against
/// the live config and commits immediately (the boot-config save runs in the background).
export function AliasFormModal({
  initial,
  existing,
  usedByRules,
  interfaces,
  onClose,
  onSaved,
}: {
  /** Present when editing an existing alias; absent when creating. */
  initial?: FirewallAlias;
  /** All existing aliases, for duplicate detection and diffing. */
  existing: FirewallAlias[];
  /** Rule numbers referencing the edited alias — locks name/type changes. */
  usedByRules: number[];
  /** Configured interfaces offered as interface-group members. */
  interfaces: { name: string; label: string }[];
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const locked = isEdit && usedByRules.length > 0;

  const [name, setName] = useState(initial?.display ?? "");
  const [type, setType] = useState<AliasType>(initial?.type ?? "host");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [membersText, setMembersText] = useState(
    initial && initial.type !== "iface" ? initial.members.join("\n") : "",
  );
  // Interface members are picked, not typed. A member no longer configured
  // (e.g. a deleted VLAN) still shows so it can be seen and unchecked.
  const [ifaceMembers, setIfaceMembers] = useState<string[]>(
    initial?.type === "iface" ? initial.members : [],
  );
  const ifaceOptions = [
    ...interfaces,
    ...ifaceMembers
      .filter((m) => !interfaces.some((i) => i.name === m))
      .map((m) => ({ name: m, label: `${m} (not configured)` })),
  ];
  const toggleIface = (n: string) =>
    setIfaceMembers((prev) => (prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n]));

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const display = name.trim().replace(/\s+/g, " ");
    if (!NAME_RE.test(display)) {
      setError("Name must start with a letter and use only letters, digits, spaces, hyphens, and underscores.");
      return;
    }
    // The device name is the hyphenated form — VyOS group names can't hold spaces.
    const n = sanitizeAliasName(display);
    // Same VyOS group node = same namespace; different alias types don't clash.
    const clash = existing.some(
      (a) => a.name === n && a.type === type && !(isEdit && a.name === initial!.name && a.type === initial!.type),
    );
    if (clash) {
      setError(`A ${ALIAS_GROUP[type].label.toLowerCase()} alias named ${display} already exists (device name ${n}).`);
      return;
    }

    const members =
      type === "iface"
        ? ifaceMembers
        : membersText
            .split("\n")
            .map((m) => m.trim())
            .filter(Boolean);
    if (members.length === 0) {
      setError(type === "iface" ? "Pick at least one interface." : "Add at least one member.");
      return;
    }
    const bad = members.find((m) => !MEMBER_INFO[type].valid(m));
    if (bad) {
      setError(`"${bad}" is not a valid ${ALIAS_GROUP[type].label.toLowerCase()} entry.`);
      return;
    }

    setSaving(true);
    try {
      const applied = await applyAlias(existing, {
        name: n,
        display,
        type,
        description: description.trim() || null,
        members,
        original_name: initial?.name ?? null,
        original_type: initial?.type ?? null,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to alias ${display}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply alias.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={520}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Create"} Alias`}
        subtitle="Named hosts, networks, FQDNs, or interface groups for firewall rules"
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field
          label="Type"
          hint={locked ? `In use by rule${usedByRules.length === 1 ? "" : "s"} ${usedByRules.join(", ")} — type and name are locked.` : undefined}
        >
          <div style={locked ? { opacity: 0.5, pointerEvents: "none" } : undefined}>
            <Segmented
              items={[
                { value: "host", label: "IPv4 Host" },
                { value: "network", label: "IPv4 Network" },
                { value: "fqdn", label: "FQDN" },
                { value: "iface", label: "Interfaces" },
              ]}
              value={type}
              onChange={(v) => setType(v as AliasType)}
            />
          </div>
        </Field>

        <Field
          label="Name"
          hint={
            /\s/.test(name.trim())
              ? `Spaces are fine here — stored on the device as ${sanitizeAliasName(name)}.`
              : undefined
          }
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Approved DNS Servers"
            disabled={locked}
            className="clr-input"
            style={{ maxWidth: "none", ...monoFont }}
          />
        </Field>

        {type === "iface" ? (
          <Field
            label="Member interfaces"
            hint="In a rule this alias stands alone on its side and matches traffic on any of these interfaces — zone-like grouping, without zone-based mode."
          >
            <div
              className="overflow-y-auto"
              style={{
                border: "1px solid var(--cds-alias-object-border-color)",
                borderRadius: 4,
                ...monoFont,
                maxHeight: 180,
                padding: "4px 0",
              }}
            >
              {ifaceOptions.length === 0 ? (
                <div className="px-3 py-2" style={{ fontSize: 13, color: "var(--cds-alias-typography-color-200)" }}>
                  No configured interfaces found — set up interfaces (or their descriptions) first.
                </div>
              ) : (
                ifaceOptions.map((i) => (
                  <div key={i.name} className="clr-checkbox-wrapper px-3 py-[2px]">
                    <input
                      type="checkbox"
                      id={`alias-iface-${i.name}`}
                      checked={ifaceMembers.includes(i.name)}
                      onChange={() => toggleIface(i.name)}
                    />
                    <label htmlFor={`alias-iface-${i.name}`} style={monoFont}>
                      {i.label}
                    </label>
                  </div>
                ))
              )}
            </div>
          </Field>
        ) : (
          <Field label="Members" hint={MEMBER_INFO[type].hint}>
            <textarea
              value={membersText}
              onChange={(e) => setMembersText(e.target.value)}
              placeholder={MEMBER_INFO[type].placeholder}
              rows={5}
              className="clr-textarea"
              style={{ maxWidth: "none", ...monoFont }}
            />
          </Field>
        )}

        <Field label="Description">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Internal server subnet"
            className="clr-input"
            style={{ maxWidth: "none" }}
          />
        </Field>

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
            {saving ? "Applying…" : isEdit ? "Apply Changes" : "Create Alias"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
