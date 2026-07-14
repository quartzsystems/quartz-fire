"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { applyVxlan, VxlanInterface } from "@/lib/interfaces";

const inputCls = "w-full rounded-md px-3 py-[9px] text-[13px] text-[var(--qz-fg-1)] outline-none";
const inputSt = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;
const monoSt = { ...inputSt, fontFamily: "var(--qz-font-mono)" } as const;

function focusBorder(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) {
  e.currentTarget.style.borderColor = "var(--qz-accent)";
}
function blurBorder(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) {
  e.currentTarget.style.borderColor = "var(--qz-border)";
}

function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[12px] text-[var(--qz-fg-3)] mb-[6px]">
        {label} {required && <span style={{ color: "var(--qz-danger)" }}>*</span>}
      </label>
      {children}
      {hint && <p className="text-[11px] text-[var(--qz-fg-4)] m-0 mt-[5px]">{hint}</p>}
    </div>
  );
}

/// The three VXLAN control planes. EVPN sets `parameters external` (BGP carries
/// reachability); static lists remote VTEPs; multicast floods BUM to a group.
type Mode = "evpn" | "static" | "multicast";

interface ListRow {
  key: string;
  value: string;
}
let keyCounter = 0;
const nextKey = () => `vxlan-row-${keyCounter++}`;
const toRows = (values: string[]): ListRow[] => values.map((value) => ({ key: nextKey(), value }));

function initialMode(v?: VxlanInterface): Mode {
  if (!v) return "evpn";
  if (v.external) return "evpn";
  if (v.group) return "multicast";
  if (v.remotes.length) return "static";
  return "evpn";
}

const V46_ADDR_RE = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i;

/// Create/edit one VXLAN VTEP. Diffs against the live config and commits under
/// commit-confirm (the boot-config save runs after confirmation).
export function VxlanFormModal({
  initial,
  interfaces,
  existing,
  onClose,
  onSaved,
}: {
  /** Present when editing an existing VXLAN; absent when creating. */
  initial?: VxlanInterface;
  /** Interface names offered for the source-interface picker. */
  interfaces: string[];
  /** All current VXLANs, for duplicate detection. */
  existing: VxlanInterface[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;

  const [mode, setMode] = useState<Mode>(initialMode(initial));
  const [name, setName] = useState(initial?.name ?? "");
  const [vni, setVni] = useState(initial?.vni != null ? String(initial.vni) : "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [sourceAddress, setSourceAddress] = useState(initial?.source_address ?? "");
  const [sourceInterface, setSourceInterface] = useState(initial?.source_interface ?? "");
  const [remotes, setRemotes] = useState<ListRow[]>(toRows(initial?.remotes ?? []));
  const [group, setGroup] = useState(initial?.group ?? "");
  const [port, setPort] = useState(initial?.port != null ? String(initial.port) : "");
  const [mtu, setMtu] = useState(initial?.mtu != null ? String(initial.mtu) : "");
  const [addresses, setAddresses] = useState<ListRow[]>(toRows(initial?.addresses ?? []));
  const [nolearning, setNolearning] = useState(initial?.nolearning ?? false);
  const [neighborSuppress, setNeighborSuppress] = useState(initial?.neighbor_suppress ?? false);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const addRemote = () => setRemotes((p) => [...p, { key: nextKey(), value: "" }]);
  const removeRemote = (key: string) => setRemotes((p) => p.filter((r) => r.key !== key));
  const updateRemote = (key: string, value: string) =>
    setRemotes((p) => p.map((r) => (r.key === key ? { ...r, value } : r)));

  const addAddr = () => setAddresses((p) => [...p, { key: nextKey(), value: "" }]);
  const removeAddr = (key: string) => setAddresses((p) => p.filter((a) => a.key !== key));
  const updateAddr = (key: string, value: string) =>
    setAddresses((p) => p.map((a) => (a.key === key ? { ...a, value } : a)));

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const trimmedName = name.trim();
    if (!/^vxlan\d+$/.test(trimmedName)) {
      setError("Name must be vxlanN (e.g. vxlan2000).");
      return;
    }
    if (!isEdit && existing.some((v) => v.name === trimmedName)) {
      setError(`${trimmedName} already exists.`);
      return;
    }
    const vniNum = Number(vni);
    if (!vni.trim() || !Number.isInteger(vniNum) || vniNum < 0 || vniNum > 16777215) {
      setError("VNI must be a whole number between 0 and 16777215.");
      return;
    }
    const src = sourceAddress.trim();
    if (mode === "evpn" && !src) {
      setError("EVPN VTEPs require a source address (the local tunnel IP).");
      return;
    }
    if (src && !V46_ADDR_RE.test(src)) {
      setError("Source address must be an IPv4 or IPv6 address.");
      return;
    }
    const remoteVals = remotes.map((r) => r.value.trim()).filter(Boolean);
    if (mode === "static" && remoteVals.length === 0) {
      setError("Static unicast VXLAN needs at least one remote VTEP address.");
      return;
    }
    if (mode === "multicast" && !group.trim()) {
      setError("Multicast VXLAN needs a multicast group address.");
      return;
    }
    if (port.trim() !== "") {
      const p = Number(port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        setError("Port must be a whole number between 1 and 65535.");
        return;
      }
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
      const applied = await applyVxlan(initial ?? null, {
        name: trimmedName,
        description: description.trim() || null,
        addresses: addresses.map((a) => a.value.trim()).filter(Boolean),
        mtu: mtu.trim() === "" ? null : Number(mtu),
        enabled,
        vni: vniNum,
        source_address: src || null,
        source_interface: sourceInterface.trim() || null,
        remotes: mode === "static" ? remoteVals : [],
        group: mode === "multicast" ? group.trim() || null : null,
        port: port.trim() === "" ? null : Number(port),
        external: mode === "evpn",
        nolearning,
        neighbor_suppress: neighborSuppress,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to ${trimmedName}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply VXLAN changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={560}>
      <ModalHeader
        title={isEdit ? "Edit VXLAN" : "Create VXLAN"}
        subtitle={isEdit ? initial!.name : "Overlay tunnel endpoint (VTEP)"}
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <datalist id="vxlan-interfaces">
          {interfaces.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>

        <Field label="Control Plane" hint="EVPN hands MAC/IP reachability to BGP; static and multicast are self-contained.">
          <Segmented
            items={[
              { value: "evpn", label: "BGP-EVPN" },
              { value: "static", label: "Static unicast" },
              { value: "multicast", label: "Multicast" },
            ]}
            value={mode}
            onChange={(v) => setMode(v as Mode)}
          />
        </Field>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Name" required>
            <input
              value={name}
              disabled={isEdit}
              onChange={(e) => setName(e.target.value)}
              placeholder="vxlan2000"
              className={`${inputCls} disabled:opacity-70`}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
          <Field label="VNI" required hint="24-bit segment ID (0–16777215).">
            <input
              value={vni}
              onChange={(e) => setVni(e.target.value)}
              placeholder="2000"
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field
            label="Source Address"
            required={mode === "evpn"}
            hint="Local VTEP tunnel IP (usually a loopback address)."
          >
            <input
              value={sourceAddress}
              onChange={(e) => setSourceAddress(e.target.value)}
              placeholder="172.29.255.1"
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
          <Field
            label="Source Interface"
            required={mode === "multicast"}
            hint={mode === "multicast" ? "Interface multicast VXLAN traffic uses." : "Optional underlay interface."}
          >
            <input
              list="vxlan-interfaces"
              value={sourceInterface}
              onChange={(e) => setSourceInterface(e.target.value)}
              placeholder="lo"
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
        </div>

        {mode === "static" && (
          <div>
            <div className="flex items-center justify-between mb-[6px]">
              <label className="block text-[12px] text-[var(--qz-fg-3)]">Remote VTEPs</label>
              <button
                type="button"
                onClick={addRemote}
                className="flex items-center gap-[5px] text-[12px] text-[var(--qz-fg-3)] hover:text-[var(--qz-accent)] transition-colors cursor-pointer bg-transparent border-0 p-0"
              >
                <Plus size={13} /> Add remote
              </button>
            </div>
            {remotes.length === 0 ? (
              <p className="text-[12px] text-[var(--qz-fg-4)] m-0">Add the IP of each remote tunnel endpoint.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {remotes.map((r) => (
                  <div key={r.key} className="flex items-center gap-2">
                    <input
                      value={r.value}
                      onChange={(e) => updateRemote(r.key, e.target.value)}
                      placeholder="172.29.255.2"
                      className={inputCls}
                      style={monoSt}
                      onFocus={focusBorder}
                      onBlur={blurBorder}
                    />
                    <button
                      type="button"
                      onClick={() => removeRemote(r.key)}
                      title="Remove remote"
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

        {mode === "multicast" && (
          <Field label="Multicast Group" required hint="Group address for BUM (broadcast/unknown-unicast/multicast) flooding.">
            <input
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              placeholder="239.1.1.1"
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
        )}

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="UDP Port" hint="Default 8472; EVPN fabrics use 4789.">
            <input
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder={mode === "evpn" ? "4789" : "8472"}
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
          <Field label="MTU">
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
          </Field>
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
            <p className="text-[12px] text-[var(--qz-fg-4)] m-0">Optional — an L3 VTEP address like 10.0.0.1/24.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {addresses.map((a) => (
                <div key={a.key} className="flex items-center gap-2">
                  <input
                    value={a.value}
                    onChange={(e) => updateAddr(a.key, e.target.value)}
                    placeholder="10.0.0.1/24"
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

        <Field label="Description">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Tenant blue L2 segment"
            className={inputCls}
            style={inputSt}
            onFocus={focusBorder}
            onBlur={blurBorder}
          />
        </Field>

        <div className="flex flex-col gap-[10px] rounded-md p-3" style={inputSt}>
          <span className="text-[12px] text-[var(--qz-fg-3)]">Advanced parameters</span>
          <label className="flex items-center gap-[10px] cursor-pointer select-none">
            <Switch on={nolearning} onChange={setNolearning} />
            <span className="text-[13px] text-[var(--qz-fg-2)]">
              Disable MAC learning <span className="text-[var(--qz-fg-4)]">(nolearning — recommended for EVPN)</span>
            </span>
          </label>
          <label className="flex items-center gap-[10px] cursor-pointer select-none">
            <Switch on={neighborSuppress} onChange={setNeighborSuppress} />
            <span className="text-[13px] text-[var(--qz-fg-2)]">
              ARP/ND suppression <span className="text-[var(--qz-fg-4)]">(neighbor-suppress)</span>
            </span>
          </label>
        </div>

        <label className="flex items-center gap-[10px] cursor-pointer select-none">
          <Switch on={enabled} onChange={setEnabled} />
          <span className="text-[13px] text-[var(--qz-fg-2)]">Enabled</span>
        </label>

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
            {saving ? "Applying…" : isEdit ? "Apply changes" : "Create VXLAN"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
