"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { applyBridge, BridgeInterface, BridgeVif } from "@/lib/interfaces";

const inputCls = "w-full rounded-md px-3 py-[9px] text-[13px] text-[var(--qz-fg-1)] outline-none";
const inputSt = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;
const monoSt = { ...inputSt, fontFamily: "var(--qz-font-mono)" } as const;

function focusBorder(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) {
  e.currentTarget.style.borderColor = "var(--qz-accent)";
}
function blurBorder(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) {
  e.currentTarget.style.borderColor = "var(--qz-border)";
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
        subtitle={isEdit ? initial!.name : "Layer 2 bridge interface"}
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <div>
          <label className="block text-[12px] text-[var(--qz-fg-3)] mb-[6px]">
            Name <span style={{ color: "var(--qz-danger)" }}>*</span>
          </label>
          <input
            value={name}
            disabled={isEdit}
            onChange={(e) => setName(e.target.value)}
            placeholder="br0"
            className={`${inputCls} disabled:opacity-70`}
            style={monoSt}
            onFocus={focusBorder}
            onBlur={blurBorder}
          />
        </div>

        <div>
          <label className="block text-[12px] text-[var(--qz-fg-3)] mb-[6px]">Description</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="LAN bridge"
            className={inputCls}
            style={inputSt}
            onFocus={focusBorder}
            onBlur={blurBorder}
          />
        </div>

        <div>
          <label className="block text-[12px] text-[var(--qz-fg-3)] mb-[6px]">Member Interfaces</label>
          {candidates.length === 0 ? (
            <p className="text-[12px] text-[var(--qz-fg-4)] m-0">
              No free interfaces — members must have no addresses and not belong to a bond or
              another bridge.
            </p>
          ) : (
            <div
              className="flex flex-col gap-[2px] rounded-md p-[6px] max-h-[170px] overflow-auto"
              style={inputSt}
            >
              {candidates.map((n) => (
                <label
                  key={n}
                  className="flex items-center gap-[10px] px-2 py-[6px] rounded cursor-pointer select-none hover:bg-[color-mix(in_oklab,white_5%,transparent)] transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={members.includes(n)}
                    onChange={() => toggleMember(n)}
                    style={{ accentColor: "var(--qz-accent)" }}
                  />
                  <span className="text-[13px] text-[var(--qz-fg-2)]" style={{ fontFamily: "var(--qz-font-mono)" }}>
                    {n}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-[6px]">
            <label className="block text-[12px] text-[var(--qz-fg-3)]">IP Addresses</label>
            <button
              type="button"
              onClick={addAddr}
              className="flex items-center gap-[5px] text-[12px] text-[var(--qz-fg-3)] hover:text-[var(--qz-accent)] transition-colors cursor-pointer bg-transparent border-0 p-0"
            >
              <Plus size={13} /> Add address
            </button>
          </div>
          {addresses.length === 0 ? (
            <p className="text-[12px] text-[var(--qz-fg-4)] m-0">
              No addresses — use <span style={{ fontFamily: "var(--qz-font-mono)" }}>dhcp</span> or a CIDR like 10.0.0.1/24.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {addresses.map((a) => (
                <div key={a.key} className="flex items-center gap-2">
                  <input
                    value={a.value}
                    onChange={(e) => updateAddr(a.key, e.target.value)}
                    placeholder="10.0.0.1/24 or dhcp"
                    className={inputCls}
                    style={monoSt}
                    onFocus={focusBorder}
                    onBlur={blurBorder}
                  />
                  <button
                    type="button"
                    onClick={() => removeAddr(a.key)}
                    title="Remove address"
                    className="grid place-items-center w-9 h-9 flex-shrink-0 rounded-md text-[var(--qz-fg-4)] hover:text-[var(--qz-danger)] transition-colors cursor-pointer bg-transparent"
                    style={{ border: "1px solid var(--qz-border)" }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3 rounded-md p-3" style={inputSt}>
          <label className="flex items-center gap-[10px] cursor-pointer select-none">
            <Switch on={vlanAware} onChange={setVlanAware} />
            <span className="text-[13px] text-[var(--qz-fg-2)]">
              VLAN-aware bridging{" "}
              <span className="text-[var(--qz-fg-4)]">(enable-vlan)</span>
            </span>
          </label>
          <p className="text-[11px] text-[var(--qz-fg-4)] m-0 -mt-1">
            VLAN filtering. Required before a VXLAN Single VXLAN Device (SVD) member can carry{" "}
            <span style={{ fontFamily: "var(--qz-font-mono)" }}>vlan-to-vni</span> mappings, and before VLAN
            sub-interfaces.
          </p>

          {vlanAware && (
            <div>
              <div className="flex items-center justify-between mb-[6px]">
                <label className="block text-[12px] text-[var(--qz-fg-3)]">VLAN sub-interfaces (VIFs)</label>
                <button
                  type="button"
                  onClick={addVif}
                  className="flex items-center gap-[5px] text-[12px] text-[var(--qz-fg-3)] hover:text-[var(--qz-accent)] transition-colors cursor-pointer bg-transparent border-0 p-0"
                >
                  <Plus size={13} /> Add VIF
                </button>
              </div>
              {vifs.length === 0 ? (
                <p className="text-[12px] text-[var(--qz-fg-4)] m-0">
                  No VLAN sub-interfaces. Each adds an L3 interface named{" "}
                  <span style={{ fontFamily: "var(--qz-font-mono)" }}>{name.trim() || "brN"}.&lt;vlan&gt;</span>.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {vifs.map((v) => (
                    <div key={v.key} className="flex items-start gap-2">
                      <input
                        value={v.vlan}
                        onChange={(e) => updateVif(v.key, { vlan: e.target.value })}
                        placeholder="VLAN"
                        className={inputCls}
                        style={{ ...monoSt, maxWidth: 80 }}
                        onFocus={focusBorder}
                        onBlur={blurBorder}
                      />
                      <div className="flex flex-col gap-2 flex-1">
                        <input
                          value={v.addresses}
                          onChange={(e) => updateVif(v.key, { addresses: e.target.value })}
                          placeholder="10.0.10.1/24 (comma-separated for several)"
                          className={inputCls}
                          style={monoSt}
                          onFocus={focusBorder}
                          onBlur={blurBorder}
                        />
                        <input
                          value={v.description}
                          onChange={(e) => updateVif(v.key, { description: e.target.value })}
                          placeholder="Description (optional)"
                          className={inputCls}
                          style={inputSt}
                          onFocus={focusBorder}
                          onBlur={blurBorder}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => removeVif(v.key)}
                        title="Remove VLAN sub-interface"
                        className="grid place-items-center w-9 h-9 flex-shrink-0 rounded-md text-[var(--qz-fg-4)] hover:text-[var(--qz-danger)] transition-colors cursor-pointer bg-transparent"
                        style={{ border: "1px solid var(--qz-border)" }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="grid gap-4 items-end" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <div>
            <label className="block text-[12px] text-[var(--qz-fg-3)] mb-[6px]">MTU</label>
            <input
              type="number"
              min={68}
              max={16000}
              value={mtu}
              onChange={(e) => setMtu(e.target.value)}
              placeholder="1500"
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </div>
          <label className="flex items-center gap-[10px] cursor-pointer select-none pb-[9px]">
            <Switch on={enabled} onChange={setEnabled} />
            <span className="text-[13px] text-[var(--qz-fg-2)]">Enabled</span>
          </label>
        </div>

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
            {saving ? "Applying…" : isEdit ? "Apply changes" : "Create bridge"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
