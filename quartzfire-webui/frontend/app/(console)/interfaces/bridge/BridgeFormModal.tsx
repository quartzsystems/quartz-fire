"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { applyBridge, BridgeInterface, BridgeVif } from "@/lib/interfaces";

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
const nextKey = () => `bridge-addr-${addrKeyCounter++}`;
const toRows = (values: string[]): AddrRow[] => values.map((value) => ({ key: nextKey(), value }));

/// One VLAN sub-interface (VIF) row while editing. `addresses` is a free-text
/// field of whitespace/comma-separated CIDRs so a VIF can carry several IPs and
/// round-trip cleanly.
interface VifRow {
  key: string;
  vlan: string;
  description: string;
  addresses: string;
}
const toVifRows = (vifs: BridgeVif[]): VifRow[] =>
  vifs.map((v) => ({
    key: nextKey(),
    vlan: String(v.vlan_id),
    description: v.description ?? "",
    addresses: v.addresses.join(", "),
  }));

export function BridgeFormModal({
  initial,
  candidates,
  existing,
  onClose,
  onSaved,
}: {
  /** Present when editing an existing bridge; absent when creating. */
  initial?: BridgeInterface;
  /** Interfaces free to attach (includes this bridge's own members). */
  candidates: string[];
  /** All current bridges, for duplicate detection. */
  existing: BridgeInterface[];
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [members, setMembers] = useState<string[]>(initial?.members ?? []);
  const [addresses, setAddresses] = useState<AddrRow[]>(toRows(initial?.addresses ?? []));
  const [mtu, setMtu] = useState(initial?.mtu != null ? String(initial.mtu) : "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [vlanAware, setVlanAware] = useState(initial?.vlan_aware ?? false);
  const [vifs, setVifs] = useState<VifRow[]>(toVifRows(initial?.vifs ?? []));

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const toggleMember = (n: string) =>
    setMembers((p) => (p.includes(n) ? p.filter((m) => m !== n) : [...p, n].sort()));

  const addAddr = () => setAddresses((p) => [...p, { key: nextKey(), value: "" }]);
  const removeAddr = (key: string) => setAddresses((p) => p.filter((a) => a.key !== key));
  const updateAddr = (key: string, value: string) =>
    setAddresses((p) => p.map((a) => (a.key === key ? { ...a, value } : a)));

  const addVif = () => setVifs((p) => [...p, { key: nextKey(), vlan: "", description: "", addresses: "" }]);
  const removeVif = (key: string) => setVifs((p) => p.filter((v) => v.key !== key));
  const updateVif = (key: string, patch: Partial<Omit<VifRow, "key">>) =>
    setVifs((p) => p.map((v) => (v.key === key ? { ...v, ...patch } : v)));

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const trimmedName = name.trim();
    if (!/^br\d+$/.test(trimmedName)) {
      setError("Name must be brN (e.g. br0).");
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

    // VLAN sub-interfaces (only meaningful on a VLAN-aware bridge).
    const parsedVifs: BridgeVif[] = [];
    const seenVlan = new Set<number>();
    for (const r of vifs) {
      if (r.vlan.trim() === "" && r.description.trim() === "" && r.addresses.trim() === "") continue;
      const id = Number(r.vlan);
      if (!Number.isInteger(id) || id < 1 || id > 4094) {
        setError("Each VLAN sub-interface needs a VLAN ID between 1 and 4094.");
        return;
      }
      if (seenVlan.has(id)) {
        setError(`VLAN ${id} is listed more than once.`);
        return;
      }
      seenVlan.add(id);
      parsedVifs.push({
        vlan_id: id,
        description: r.description.trim() || null,
        addresses: r.addresses.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
      });
    }
    // VIFs require VLAN filtering; enable it implicitly so the commit succeeds.
    const wantVlanAware = vlanAware || parsedVifs.length > 0;

    setSaving(true);
    try {
      const applied = await applyBridge(initial ?? null, {
        name: trimmedName,
        description: description.trim() || null,
        addresses: addresses.map((a) => a.value.trim()).filter(Boolean),
        mtu: mtu.trim() === "" ? null : Number(mtu),
        members,
        enabled,
        vlan_aware: wantVlanAware,
        vifs: parsedVifs,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to ${trimmedName}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply bridge changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <ModalHeader
        title={isEdit ? "Edit Bridge" : "Create Bridge"}
        subtitle={isEdit ? <span className="mono">{initial!.name}</span> : "Layer 2 bridge interface"}
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name" required>
          <input
            value={name}
            disabled={isEdit}
            onChange={(e) => setName(e.target.value)}
            placeholder="br0"
            className="clr-input"
            style={wideMono}
          />
        </Field>

        <Field label="Description">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="LAN bridge"
            className="clr-input"
            style={wide}
          />
        </Field>

        <Field label="Member interfaces">
          {candidates.length === 0 ? (
            <div className="clr-subtext">
              No free interfaces — members must have no addresses and not belong to a bond or
              another bridge.
            </div>
          ) : (
            <div
              className="flex flex-col overflow-auto"
              style={{
                gap: 6,
                maxHeight: 170,
                border: "1px solid var(--cds-alias-object-border-color)",
                borderRadius: "var(--clr-base-border-radius-m)",
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
            <label className="clr-control-label" style={{ marginBottom: 0 }}>IP addresses</label>
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

        <div
          className="flex flex-col gap-3"
          style={{ border: "1px solid var(--cds-alias-object-border-color)", borderRadius: "var(--clr-base-border-radius-m)", padding: 12 }}
        >
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <Switch on={vlanAware} onChange={setVlanAware} />
            <span style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>
              VLAN-aware bridging{" "}
              <span style={{ color: "var(--cds-alias-typography-color-200)" }}>(enable-vlan)</span>
            </span>
          </label>
          <div className="clr-subtext" style={{ marginTop: -6 }}>
            <span>
              VLAN filtering. Required before a VXLAN Single VXLAN Device (SVD) member can carry{" "}
              <span style={mono}>vlan-to-vni</span> mappings, and before VLAN sub-interfaces.
            </span>
          </div>

          {vlanAware && (
            <div className="clr-form-control" style={{ marginTop: 0 }}>
              <div className="flex items-center justify-between">
                <label className="clr-control-label" style={{ marginBottom: 0 }}>VLAN sub-interfaces (VIFs)</label>
                <button type="button" onClick={addVif} className="btn btn-sm btn-link-neutral">
                  <Icon shape="plus" size={12} /> Add VIF
                </button>
              </div>
              {vifs.length === 0 ? (
                <div className="clr-subtext">
                  <span>
                    No VLAN sub-interfaces. Each adds an L3 interface named{" "}
                    <span style={mono}>{name.trim() || "brN"}.&lt;vlan&gt;</span>.
                  </span>
                </div>
              ) : (
                <div className="flex flex-col gap-2" style={{ marginTop: 6 }}>
                  {vifs.map((v) => (
                    <div key={v.key} className="flex items-start gap-2">
                      <input
                        value={v.vlan}
                        onChange={(e) => updateVif(v.key, { vlan: e.target.value })}
                        placeholder="VLAN"
                        className="clr-input"
                        style={{ ...mono, maxWidth: 80 }}
                      />
                      <div className="flex flex-col gap-2 flex-1">
                        <input
                          value={v.addresses}
                          onChange={(e) => updateVif(v.key, { addresses: e.target.value })}
                          placeholder="10.0.10.1/24 (comma-separated for several)"
                          className="clr-input"
                          style={wideMono}
                        />
                        <input
                          value={v.description}
                          onChange={(e) => updateVif(v.key, { description: e.target.value })}
                          placeholder="Description (optional)"
                          className="clr-input"
                          style={wide}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => removeVif(v.key)}
                        title="Remove VLAN sub-interface"
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
            {saving ? "Applying…" : isEdit ? "Apply Changes" : "Create Bridge"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
