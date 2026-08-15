"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { applyVxlan, VniMapping, VxlanInterface } from "@/lib/interfaces";

const mono = { fontFamily: "var(--qz-font-mono)" } as const;
const wide = { maxWidth: "none" } as const;
const wideMono = { ...wide, ...mono } as const;

/// Clarity field: label + control + optional helper sentence.
function Field({ label, hint, required, children }: { label: string; hint?: React.ReactNode; required?: boolean; children: React.ReactNode }) {
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

/// A VNI↔VLAN mapping row (strings while editing). `vlan` blank = a plain VNI
/// with no VLAN binding (typical L3VNI).
interface VniRow {
  key: string;
  vni: string;
  vlan: string;
}
const toVniRows = (vnis?: VniMapping[]): VniRow[] =>
  (vnis && vnis.length ? vnis : [{ vni: 0, vlan: null }]).map((m) => ({
    key: nextKey(),
    vni: m.vni ? String(m.vni) : "",
    vlan: m.vlan != null ? String(m.vlan) : "",
  }));

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
  bridges,
  existing,
  onClose,
  onSaved,
}: {
  /** Present when editing an existing VXLAN; absent when creating. */
  initial?: VxlanInterface;
  /** Interface names offered for the source-interface picker. */
  interfaces: string[];
  /** Configured bridge names offered for the bridge-membership picker. */
  bridges: string[];
  /** All current VXLANs, for duplicate detection. */
  existing: VxlanInterface[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;

  const [mode, setMode] = useState<Mode>(initialMode(initial));
  const [name, setName] = useState(initial?.name ?? "");
  const [vnis, setVnis] = useState<VniRow[]>(toVniRows(initial?.vnis));
  const [bridge, setBridge] = useState(initial?.bridge ?? "");
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

  const addVni = () => setVnis((p) => [...p, { key: nextKey(), vni: "", vlan: "" }]);
  const removeVni = (key: string) => setVnis((p) => (p.length > 1 ? p.filter((r) => r.key !== key) : p));
  const updateVni = (key: string, patch: Partial<Omit<VniRow, "key">>) =>
    setVnis((p) => p.map((r) => (r.key === key ? { ...r, ...patch } : r)));

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
    const vniRows = vnis.filter((r) => r.vni.trim() !== "");
    if (vniRows.length === 0) {
      setError("Add at least one VNI.");
      return;
    }
    const parsedVnis: VniMapping[] = [];
    const seenVni = new Set<number>();
    const seenVlan = new Set<number>();
    for (const r of vniRows) {
      const n = Number(r.vni);
      if (!Number.isInteger(n) || n < 0 || n > 16777215) {
        setError("Each VNI must be a whole number between 0 and 16777215.");
        return;
      }
      if (seenVni.has(n)) {
        setError(`VNI ${n} is listed more than once.`);
        return;
      }
      seenVni.add(n);
      let vlan: number | null = null;
      if (r.vlan.trim() !== "") {
        const v = Number(r.vlan);
        if (!Number.isInteger(v) || v < 1 || v > 4094) {
          setError("VLAN must be a whole number between 1 and 4094.");
          return;
        }
        if (seenVlan.has(v)) {
          setError(`VLAN ${v} is mapped more than once.`);
          return;
        }
        seenVlan.add(v);
        vlan = v;
      }
      parsedVnis.push({ vni: n, vlan });
    }
    // VyOS models these two ways and won't mix them on one interface: a single
    // unmapped VNI is the scalar `vni <n>`; VLAN-mapped VNIs are the SVD
    // `vlan-to-vni` set (which needs the BGP-EVPN control plane + a bridge).
    const mapped = parsedVnis.filter((m) => m.vlan != null);
    const unmapped = parsedVnis.filter((m) => m.vlan == null);
    if (mapped.length > 0 && unmapped.length > 0) {
      setError("Give every VNI a VLAN (a Single VXLAN Device), or use one VNI with no VLAN — VyOS can't mix the two on one interface.");
      return;
    }
    if (unmapped.length > 1) {
      setError("Only one VNI can be unmapped. Assign a VLAN to each VNI to carry several (SVD).");
      return;
    }
    if (mapped.length > 0 && mode !== "evpn") {
      setError("VLAN-to-VNI mapping (a Single VXLAN Device) requires the BGP-EVPN control plane.");
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
        vnis: parsedVnis,
        source_address: src || null,
        source_interface: sourceInterface.trim() || null,
        remotes: mode === "static" ? remoteVals : [],
        group: mode === "multicast" ? group.trim() || null : null,
        port: port.trim() === "" ? null : Number(port),
        external: mode === "evpn",
        nolearning,
        neighbor_suppress: neighborSuppress,
        bridge: bridge.trim() || null,
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
        subtitle={isEdit ? <span className="mono">{initial!.name}</span> : "Overlay tunnel endpoint (VTEP)"}
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <datalist id="vxlan-interfaces">
          {interfaces.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <datalist id="vxlan-bridges">
          {bridges.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>

        <Field label="Control Plane" hint="EVPN hands MAC/IP reachability to BGP; static and multicast are self-contained.">
          <Segmented
            items={[
              { value: "evpn", label: "BGP-EVPN" },
              { value: "static", label: "Static Unicast" },
              { value: "multicast", label: "Multicast" },
            ]}
            value={mode}
            onChange={(v) => setMode(v as Mode)}
          />
        </Field>

        <Field label="Name" required>
          <input
            value={name}
            disabled={isEdit}
            onChange={(e) => setName(e.target.value)}
            placeholder="vxlan2000"
            className="clr-input"
            style={wideMono}
          />
        </Field>

        <div className="clr-form-control" style={{ marginTop: 0 }}>
          <div className="flex items-center justify-between">
            <label className="clr-control-label" style={{ marginBottom: 0 }}>
              VNIs<span className="clr-required">*</span>
            </label>
            <button type="button" onClick={addVni} className="btn btn-sm btn-link-neutral">
              <Icon shape="plus" size={12} /> Add VNI
            </button>
          </div>
          <div className="flex flex-col gap-2" style={{ marginTop: 6 }}>
            {vnis.map((r) => (
              <div key={r.key} className="flex items-center gap-2">
                <input
                  value={r.vni}
                  onChange={(e) => updateVni(r.key, { vni: e.target.value })}
                  placeholder="VNI (e.g. 10010)"
                  className="clr-input"
                  style={wideMono}
                />
                <span className="clr-subtext" style={{ marginTop: 0, flexShrink: 0 }}>→ VLAN</span>
                <input
                  value={r.vlan}
                  onChange={(e) => updateVni(r.key, { vlan: e.target.value })}
                  placeholder="opt."
                  className="clr-input"
                  style={{ ...mono, maxWidth: 96 }}
                />
                <button
                  type="button"
                  onClick={() => removeVni(r.key)}
                  disabled={vnis.length === 1}
                  title="Remove VNI"
                  className="btn btn-sm btn-link-neutral btn-icon"
                  style={{ flexShrink: 0 }}
                >
                  <Icon shape="trash" size={14} />
                </button>
              </div>
            ))}
          </div>
          <div className="clr-subtext">
            <span>
              24-bit segment ID (0–16777215). Give every VNI a VLAN to carry several on this one device (a Single VXLAN Device →
              <span style={mono}> vlan-to-vni</span>, needs BGP-EVPN + a bridge). Leave VLAN blank for a single plain (L3) VNI.
            </span>
          </div>
        </div>

        <Field label="Bridge" hint="Add this VTEP to a bridge so its VLANs forward. Required for a Single VXLAN Device; configure the bridge itself under Interfaces → Bridge.">
          <input
            list="vxlan-bridges"
            value={bridge}
            onChange={(e) => setBridge(e.target.value)}
            placeholder="br0"
            className="clr-input"
            style={wideMono}
          />
        </Field>

        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field
            label="Source Address"
            required={mode === "evpn"}
            hint="Local VTEP tunnel IP (usually a loopback address)."
          >
            <input
              value={sourceAddress}
              onChange={(e) => setSourceAddress(e.target.value)}
              placeholder="172.29.255.1"
              className="clr-input"
              style={wideMono}
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
              className="clr-input"
              style={wideMono}
            />
          </Field>
        </div>

        {mode === "static" && (
          <div className="clr-form-control" style={{ marginTop: 0 }}>
            <div className="flex items-center justify-between">
              <label className="clr-control-label" style={{ marginBottom: 0 }}>Remote VTEPs</label>
              <button type="button" onClick={addRemote} className="btn btn-sm btn-link-neutral">
                <Icon shape="plus" size={12} /> Add Remote
              </button>
            </div>
            {remotes.length === 0 ? (
              <div className="clr-subtext">Add the IP of each remote tunnel endpoint.</div>
            ) : (
              <div className="flex flex-col gap-2" style={{ marginTop: 6 }}>
                {remotes.map((r) => (
                  <div key={r.key} className="flex items-center gap-2">
                    <input
                      value={r.value}
                      onChange={(e) => updateRemote(r.key, e.target.value)}
                      placeholder="172.29.255.2"
                      className="clr-input"
                      style={wideMono}
                    />
                    <button
                      type="button"
                      onClick={() => removeRemote(r.key)}
                      title="Remove remote"
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

        {mode === "multicast" && (
          <Field label="Multicast Group" required hint="Group address for BUM (broadcast/unknown-unicast/multicast) flooding.">
            <input
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              placeholder="239.1.1.1"
              className="clr-input"
              style={wideMono}
            />
          </Field>
        )}

        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="UDP Port" hint="Default 8472; EVPN fabrics use 4789.">
            <input
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder={mode === "evpn" ? "4789" : "8472"}
              className="clr-input"
              style={wideMono}
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
              className="clr-input"
              style={wideMono}
            />
          </Field>
        </div>

        <div className="clr-form-control" style={{ marginTop: 0 }}>
          <div className="flex items-center justify-between">
            <label className="clr-control-label" style={{ marginBottom: 0 }}>IP Addresses</label>
            <button type="button" onClick={addAddr} className="btn btn-sm btn-link-neutral">
              <Icon shape="plus" size={12} /> Add Address
            </button>
          </div>
          {addresses.length === 0 ? (
            <div className="clr-subtext">Optional — an L3 VTEP address like 10.0.0.1/24.</div>
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

        <Field label="Description">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Tenant blue L2 segment"
            className="clr-input"
            style={wide}
          />
        </Field>

        <div
          className="flex flex-col"
          style={{ gap: 10, border: "1px solid var(--cds-alias-object-border-color)", borderRadius: "var(--clr-base-border-radius-m)", padding: 12 }}
        >
          <span className="clr-control-label" style={{ marginBottom: 0 }}>Advanced Parameters</span>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <Switch on={nolearning} onChange={setNolearning} />
            <span style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>
              Disable MAC learning{" "}
              <span style={{ color: "var(--cds-alias-typography-color-200)" }}>(nolearning — recommended for EVPN)</span>
            </span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <Switch on={neighborSuppress} onChange={setNeighborSuppress} />
            <span style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>
              ARP/ND suppression{" "}
              <span style={{ color: "var(--cds-alias-typography-color-200)" }}>(neighbor-suppress)</span>
            </span>
          </label>
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
            {saving ? "Applying…" : isEdit ? "Apply Changes" : "Create VXLAN"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
