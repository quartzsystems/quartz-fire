"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { applyBond, BondInterface } from "@/lib/interfaces";

const mono = { fontFamily: "var(--qz-font-mono)" } as const;
const wide = { maxWidth: "none" } as const;
const wideMono = { ...wide, ...mono } as const;

// Bond modes VyOS accepts; 802.3ad is the default when the leaf is absent.
const MODE_OPTIONS = [
  { value: "802.3ad", label: "802.3ad (LACP)" },
  { value: "active-backup", label: "Active-backup" },
  { value: "adaptive-load-balance", label: "Adaptive load balance" },
  { value: "broadcast", label: "Broadcast" },
  { value: "round-robin", label: "Round-robin" },
  { value: "transmit-load-balance", label: "Transmit load balance" },
  { value: "xor-hash", label: "XOR hash" },
];

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
const nextKey = () => `bond-addr-${addrKeyCounter++}`;
const toRows = (values: string[]): AddrRow[] => values.map((value) => ({ key: nextKey(), value }));

export function BondFormModal({
  initial,
  candidates,
  existing,
  onClose,
  onSaved,
}: {
  /** Present when editing an existing bond; absent when creating. */
  initial?: BondInterface;
  /** Ethernet interfaces free to enslave (includes this bond's own members). */
  candidates: string[];
  /** All current bonds, for duplicate detection. */
  existing: BondInterface[];
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [mode, setMode] = useState(initial?.mode ?? "802.3ad");
  const [members, setMembers] = useState<string[]>(initial?.members ?? []);
  const [addresses, setAddresses] = useState<AddrRow[]>(toRows(initial?.addresses ?? []));
  const [mtu, setMtu] = useState(initial?.mtu != null ? String(initial.mtu) : "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const toggleMember = (n: string) =>
    setMembers((p) => (p.includes(n) ? p.filter((m) => m !== n) : [...p, n].sort()));

  const addAddr = () => setAddresses((p) => [...p, { key: nextKey(), value: "" }]);
  const removeAddr = (key: string) => setAddresses((p) => p.filter((a) => a.key !== key));
  const updateAddr = (key: string, value: string) =>
    setAddresses((p) => p.map((a) => (a.key === key ? { ...a, value } : a)));

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const trimmedName = name.trim();
    if (!/^bond\d+$/.test(trimmedName)) {
      setError("Name must be bondN (e.g. bond0).");
      return;
    }
    if (!isEdit && existing.some((b) => b.name === trimmedName)) {
      setError(`${trimmedName} already exists.`);
      return;
    }
    if (mtu.trim() !== "") {
      const m = Number(mtu);
      if (!Number.isInteger(m) || m < 68 || m > 16000) {
        setError("MTU must be a whole number between 68 and 16000.");
        return;
      }
    }

    setSaving(true);
    try {
      const applied = await applyBond(initial ?? null, {
        name: trimmedName,
        description: description.trim() || null,
        addresses: addresses.map((a) => a.value.trim()).filter(Boolean),
        mtu: mtu.trim() === "" ? null : Number(mtu),
        mode,
        members,
        enabled,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to ${trimmedName}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply bond changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <ModalHeader
        title={isEdit ? "Edit Bond" : "Create Bond"}
        subtitle={isEdit ? initial!.name : "Link aggregation (bonding) interface"}
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Name" required>
            <input
              value={name}
              disabled={isEdit}
              onChange={(e) => setName(e.target.value)}
              placeholder="bond0"
              className="clr-input"
              style={wideMono}
            />
          </Field>
          <Field label="Mode">
            <div className="clr-select-wrapper" style={wide}>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value)}
                className="clr-select"
                style={wideMono}
              >
                {(MODE_OPTIONS.some((o) => o.value === mode)
                  ? MODE_OPTIONS
                  : [{ value: mode, label: mode }, ...MODE_OPTIONS]
                ).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </Field>
        </div>

        <Field label="Description">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Uplink LAG"
            className="clr-input"
            style={wide}
          />
        </Field>

        <Field label="Member Interfaces">
          {candidates.length === 0 ? (
            <div className="clr-subtext">
              No free ethernet interfaces — members must have no addresses and not belong to
              another bond or bridge.
            </div>
          ) : (
            <div
              className="flex flex-col overflow-auto"
              style={{
                gap: 6,
                maxHeight: 170,
                border: "1px solid var(--cds-alias-object-border-color)",
                borderRadius: 4,
                padding: "10px 12px",
              }}
            >
              {candidates.map((n) => (
                <label key={n} className="clr-checkbox-wrapper" style={{ cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={members.includes(n)}
                    onChange={() => toggleMember(n)}
                  />
                  <span style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)", ...mono }}>
                    {n}
                  </span>
                </label>
              ))}
            </div>
          )}
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
              No addresses — use <span style={mono}>dhcp</span> or a CIDR like 10.0.0.1/24.
            </div>
          ) : (
            <div className="flex flex-col gap-2" style={{ marginTop: 6 }}>
              {addresses.map((a) => (
                <div key={a.key} className="flex items-center gap-2">
                  <input
                    value={a.value}
                    onChange={(e) => updateAddr(a.key, e.target.value)}
                    placeholder="10.0.0.1/24 or dhcp"
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
              max={16000}
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
            {saving ? "Applying…" : isEdit ? "Apply Changes" : "Create Bond"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
