"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { applyVlan, VlanInterface } from "@/lib/interfaces";

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

interface AddrRow {
  key: string;
  value: string;
}

let addrKeyCounter = 0;
const nextKey = () => `vlan-addr-${addrKeyCounter++}`;
const toRows = (values: string[]): AddrRow[] =>
  values.map((value) => ({ key: nextKey(), value }));

export function VlanFormModal({
  initial,
  parents,
  descriptions,
  existing,
  onClose,
  onSaved,
}: {
  /** Present when editing an existing VLAN; absent when creating. */
  initial?: VlanInterface;
  /** Ethernet interface names available as VLAN parents. */
  parents: string[];
  /** Parent interface descriptions by name, shown next to the picker entries. */
  descriptions?: Record<string, string>;
  /** All current VLANs, for duplicate detection and diffing. */
  existing: VlanInterface[];
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;

  const [parent, setParent] = useState(initial?.parent ?? parents[0] ?? "");
  const [vlanId, setVlanId] = useState(initial ? String(initial.vlan_id) : "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [addresses, setAddresses] = useState<AddrRow[]>(toRows(initial?.addresses ?? []));
  const [mtu, setMtu] = useState(initial?.mtu != null ? String(initial.mtu) : "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const addAddr = () => setAddresses((p) => [...p, { key: nextKey(), value: "" }]);
  const removeAddr = (key: string) => setAddresses((p) => p.filter((a) => a.key !== key));
  const updateAddr = (key: string, value: string) =>
    setAddresses((p) => p.map((a) => (a.key === key ? { ...a, value } : a)));

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    if (!parent) {
      setError("Select a parent interface.");
      return;
    }
    const id = Number(vlanId);
    if (!Number.isInteger(id) || id < 1 || id > 4094) {
      setError("VLAN ID must be a whole number between 1 and 4094.");
      return;
    }
    if (mtu.trim() !== "") {
      const m = Number(mtu);
      if (!Number.isInteger(m) || m < 68 || m > 9000) {
        setError("MTU must be a whole number between 68 and 9000.");
        return;
      }
    }
    // Block collisions with another existing VLAN (allow re-saving the one being edited).
    const clash = existing.some(
      (v) =>
        v.parent === parent &&
        v.vlan_id === id &&
        !(isEdit && v.parent === initial!.parent && v.vlan_id === initial!.vlan_id),
    );
    if (clash) {
      setError(`${parent}.${id} already exists.`);
      return;
    }

    setSaving(true);
    try {
      const name = `${parent}.${id}`;
      const applied = await applyVlan(existing, {
        parent,
        vlan_id: id,
        description: description.trim() || null,
        addresses: addresses.map((a) => a.value.trim()).filter(Boolean),
        mtu: mtu.trim() === "" ? null : Number(mtu),
        enabled,
        original_parent: initial?.parent ?? null,
        original_vlan_id: initial?.vlan_id ?? null,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to ${name}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply VLAN changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <ModalHeader
        title={isEdit ? "Edit VLAN" : "Create VLAN"}
        subtitle={isEdit ? <span className="mono">{initial!.name}</span> : "802.1Q VLAN sub-interface"}
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Parent Interface" required>
            {parents.length > 0 ? (
              <div className="clr-select-wrapper" style={wide}>
                <select
                  value={parent}
                  onChange={(e) => setParent(e.target.value)}
                  className="clr-select"
                  style={wideMono}
                >
                  {/* Keep the original parent selectable even if it's missing from the list. */}
                  {(parents.includes(parent) || !parent ? parents : [parent, ...parents]).map((p) => (
                    <option key={p} value={p}>
                      {descriptions?.[p] ? `${p} — ${descriptions[p]}` : p}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <input
                value={parent}
                onChange={(e) => setParent(e.target.value)}
                placeholder="eth0"
                className="clr-input"
                style={wideMono}
              />
            )}
          </Field>
          <Field label="VLAN ID" required>
            <input
              type="number"
              min={1}
              max={4094}
              value={vlanId}
              onChange={(e) => setVlanId(e.target.value)}
              placeholder="100"
              className="clr-input"
              style={wideMono}
            />
          </Field>
        </div>

        <Field label="Description">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Management VLAN"
            className="clr-input"
            style={wide}
          />
        </Field>

        <div className="clr-form-control" style={{ marginTop: 0 }}>
          <div className="flex items-center justify-between">
            <label className="clr-control-label" style={{ marginBottom: 0 }}>IP Addresses</label>
            <button type="button" onClick={addAddr} className="btn btn-sm btn-link-neutral">
              <Icon shape="plus" size={12} /> Add Address
            </button>
          </div>
          {addresses.length === 0 ? (
            <div className="clr-subtext">
              No addresses — leave empty for an unnumbered VLAN.
            </div>
          ) : (
            <div className="flex flex-col gap-2" style={{ marginTop: 6 }}>
              {addresses.map((a) => (
                <div key={a.key} className="flex items-center gap-2">
                  <input
                    value={a.value}
                    onChange={(e) => updateAddr(a.key, e.target.value)}
                    placeholder="10.0.0.1/24"
                    className="clr-input"
                    style={wideMono}
                  />
                  <button
                    type="button"
                    onClick={() => removeAddr(a.key)}
                    title="Remove address"
                    className="btn btn-sm btn-link-neutral btn-icon"
                    style={{ flexShrink: 0 }}
                  >
                    <Icon shape="trash" size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="grid items-end" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="MTU">
            <input
              type="number"
              min={68}
              max={9000}
              value={mtu}
              onChange={(e) => setMtu(e.target.value)}
              placeholder="1500"
              className="clr-input"
              style={wideMono}
            />
          </Field>
          <label className="flex items-center gap-2 cursor-pointer select-none" style={{ paddingBottom: 8 }}>
            <Switch on={enabled} onChange={setEnabled} />
            <span style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>Enabled</span>
          </label>
        </div>

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
            {saving ? "Applying…" : isEdit ? "Apply Changes" : "Create VLAN"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
