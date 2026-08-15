"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { applyEthernet, EthernetInterface, PhyInfo } from "@/lib/interfaces";

const mono = { fontFamily: "var(--qz-font-mono)" } as const;
const wide = { maxWidth: "none" } as const;
const wideMono = { ...wide, ...mono } as const;

// Mbit/s options VyOS accepts; "auto" maps to no explicit speed leaf.
const SPEED_OPTIONS = ["auto", "10", "100", "1000", "2500", "5000", "10000"];
const DUPLEX_OPTIONS = ["auto", "half", "full"];

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
const nextKey = () => `eth-addr-${addrKeyCounter++}`;
const toRows = (values: string[]): AddrRow[] => values.map((value) => ({ key: nextKey(), value }));

export function EthernetFormModal({
  initial,
  freeNames,
  phyByName = {},
  onClose,
  onSaved,
}: {
  /** Present when editing an existing interface; absent when adding. */
  initial?: EthernetInterface;
  /** Physical NICs free to configure (used only when adding). */
  freeNames: string[];
  /** Phy capabilities by NIC name — limits the Speed choices to what the
   *  selected port actually supports (unknown port = every speed). */
  phyByName?: Record<string, PhyInfo>;
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;

  const [name, setName] = useState(initial?.name ?? freeNames[0] ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [addresses, setAddresses] = useState<AddrRow[]>(toRows(initial?.addresses ?? []));
  const [mtu, setMtu] = useState(initial?.mtu != null ? String(initial.mtu) : "");
  const [speed, setSpeed] = useState(initial?.speed ?? "auto");
  const [duplex, setDuplex] = useState(initial?.duplex ?? "auto");
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

    if (!name) {
      setError("Select a physical interface.");
      return;
    }
    if (mtu.trim() !== "") {
      const m = Number(mtu);
      if (!Number.isInteger(m) || m < 68 || m > 16000) {
        setError("MTU must be a whole number between 68 and 16000.");
        return;
      }
    }
    // VyOS requires speed and duplex to both be auto, or both fixed.
    if ((speed === "auto") !== (duplex === "auto")) {
      setError("Speed and duplex must both be Auto, or both set to a fixed value.");
      return;
    }

    setSaving(true);
    try {
      const applied = await applyEthernet(initial ?? null, {
        name,
        description: description.trim() || null,
        addresses: addresses.map((a) => a.value.trim()).filter(Boolean),
        mtu: mtu.trim() === "" ? null : Number(mtu),
        speed: speed === "auto" ? null : speed,
        duplex: duplex === "auto" ? null : duplex,
        enabled,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to ${name}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply interface changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <ModalHeader
        title={isEdit ? "Edit Interface" : "Add Interface"}
        subtitle={isEdit ? <span className="mono">{initial!.name}</span> : "Configure a physical ethernet interface"}
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Physical interface" required>
          {isEdit ? (
            <input value={name} disabled className="clr-input" style={wideMono} />
          ) : (
            <div className="clr-select-wrapper" style={wide}>
              <select
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="clr-select"
                style={wideMono}
              >
                {freeNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          )}
        </Field>

        <Field label="Description">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="WAN uplink"
            className="clr-input"
            style={wide}
          />
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

        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <Field label="Speed">
            {(() => {
              // Offer only the speeds this port reports supporting; a port
              // with no phy data (or none reported) gets the full list. The
              // currently-configured value always stays selectable.
              const supported = phyByName[name]?.supported_speeds ?? [];
              const options = supported.length
                ? SPEED_OPTIONS.filter((s) => s === "auto" || supported.includes(Number(s)))
                : SPEED_OPTIONS;
              return (
                <div className="clr-select-wrapper" style={wide}>
                  <select
                    value={speed}
                    onChange={(e) => setSpeed(e.target.value)}
                    className="clr-select"
                    style={wideMono}
                  >
                    {(options.includes(speed) ? options : [speed, ...options]).map((s) => (
                      <option key={s} value={s}>
                        {s === "auto" ? "Auto" : s}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })()}
          </Field>
          <Field label="Duplex">
            <div className="clr-select-wrapper" style={wide}>
              <select
                value={duplex}
                onChange={(e) => setDuplex(e.target.value)}
                className="clr-select"
                style={wideMono}
              >
                {(DUPLEX_OPTIONS.includes(duplex) ? DUPLEX_OPTIONS : [duplex, ...DUPLEX_OPTIONS]).map((d) => (
                  <option key={d} value={d}>
                    {d === "auto" ? "Auto" : d.charAt(0).toUpperCase() + d.slice(1)}
                  </option>
                ))}
              </select>
            </div>
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
            {saving ? "Applying…" : isEdit ? "Apply Changes" : "Add Interface"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
