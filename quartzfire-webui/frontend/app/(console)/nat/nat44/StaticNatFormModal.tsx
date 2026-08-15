"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { applyStaticNat, StaticNatMapping } from "@/lib/nat";

const mono = { fontFamily: "var(--qz-font-mono)" } as const;
const wide = { maxWidth: "none" } as const;
const wideMono = { ...wide, ...mono } as const;

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

/// Create/edit a 1-to-1 (static) NAT mapping — a paired source + destination
/// rule applied in one transaction and saved to the boot config.
export function StaticNatFormModal({
  initial,
  interfaces,
  descriptions,
  existing,
  takenRules,
  onClose,
  onSaved,
}: {
  /** Present when editing an existing mapping; absent when creating. */
  initial?: StaticNatMapping;
  /** Interface names offered as a datalist for the interface field. */
  interfaces: string[];
  /** Interface descriptions by name, shown next to the datalist entries. */
  descriptions?: Record<string, string>;
  /** Existing mappings, for duplicate rule-number detection. */
  existing: StaticNatMapping[];
  /** Rule numbers used by plain source/destination rules (unavailable here). */
  takenRules: number[];
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;

  const [rule, setRule] = useState(initial ? String(initial.rule) : "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [iface, setIface] = useState(initial?.interface ?? "");
  const [internalAddress, setInternalAddress] = useState(initial?.internal_address ?? "");
  const [externalAddress, setExternalAddress] = useState(initial?.external_address ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const num = Number(rule);
    if (!Number.isInteger(num) || num < 1 || num > 999999) {
      setError("Rule number must be a whole number between 1 and 999999.");
      return;
    }
    if (!internalAddress.trim() || !externalAddress.trim()) {
      setError("Internal and external addresses are both required.");
      return;
    }
    // Block collisions with another mapping (allow re-saving the edited one).
    const clash = existing.some((m) => m.rule === num && !(isEdit && m.rule === initial!.rule));
    if (clash) {
      setError(`Rule ${num} already exists.`);
      return;
    }
    if (takenRules.includes(num)) {
      setError(`Rule ${num} is already used by a source or destination NAT rule.`);
      return;
    }

    setSaving(true);
    try {
      const applied = await applyStaticNat({
        rule: num,
        description: description.trim() || null,
        interface: iface.trim() || null,
        internal_address: internalAddress.trim(),
        external_address: externalAddress.trim(),
        enabled,
        original_rule: initial?.rule ?? null,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to 1-to-1 NAT rule ${num}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply mapping.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={560}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Create"} 1-to-1 NAT Mapping`}
        subtitle="Bidirectional static IPv4 mapping (paired SNAT + DNAT)"
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <datalist id="static-nat-interfaces">
          {interfaces.map((n) => (
            <option key={n} value={n} label={descriptions?.[n]} />
          ))}
        </datalist>

        <div className="grid" style={{ gridTemplateColumns: "100px 1fr", gap: 12 }}>
          <Field label="Rule #" required>
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
          <Field label="Description">
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Mail server 1-to-1"
              className="clr-input"
              style={wide}
            />
          </Field>
        </div>

        <Field label="Interface" hint="Optional — leave blank to match any interface.">
          <input
            list="static-nat-interfaces"
            value={iface}
            onChange={(e) => setIface(e.target.value)}
            placeholder="eth0"
            className="clr-input"
            style={wideMono}
          />
        </Field>

        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="External address" required hint="The public address (WAN side).">
            <input
              value={externalAddress}
              onChange={(e) => setExternalAddress(e.target.value)}
              placeholder="203.0.113.10"
              className="clr-input"
              style={wideMono}
            />
          </Field>
          <Field label="Internal address" required hint="The private host (LAN side).">
            <input
              value={internalAddress}
              onChange={(e) => setInternalAddress(e.target.value)}
              placeholder="172.16.10.30"
              className="clr-input"
              style={wideMono}
            />
          </Field>
        </div>

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
            {saving ? "Applying…" : isEdit ? "Apply Changes" : "Create Mapping"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
