"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { applyLoopback, LoopbackInterface } from "@/lib/interfaces";

const mono = { fontFamily: "var(--qz-font-mono)" } as const;
const wide = { maxWidth: "none" } as const;
const wideMono = { ...wide, ...mono } as const;

interface AddrRow {
  key: string;
  value: string;
}

let addrKeyCounter = 0;
const nextKey = () => `lo-addr-${addrKeyCounter++}`;
const toRows = (values: string[]): AddrRow[] => values.map((value) => ({ key: nextKey(), value }));

export function LoopbackFormModal({
  initial,
  onClose,
  onSaved,
}: {
  /** Present when editing; absent when configuring `lo` for the first time. */
  initial?: LoopbackInterface;
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  // VyOS supports exactly one loopback node, `lo`.
  const name = initial?.name ?? "lo";

  const [description, setDescription] = useState(initial?.description ?? "");
  const [addresses, setAddresses] = useState<AddrRow[]>(toRows(initial?.addresses ?? []));

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const addAddr = () => setAddresses((p) => [...p, { key: nextKey(), value: "" }]);
  const removeAddr = (key: string) => setAddresses((p) => p.filter((a) => a.key !== key));
  const updateAddr = (key: string, value: string) =>
    setAddresses((p) => p.map((a) => (a.key === key ? { ...a, value } : a)));

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    setSaving(true);
    try {
      const applied = await applyLoopback(initial ?? null, {
        name,
        description: description.trim() || null,
        addresses: addresses.map((a) => a.value.trim()).filter(Boolean),
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to ${name}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply loopback changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <ModalHeader
        title={isEdit ? "Edit Interface" : "Configure Loopback"}
        subtitle={name}
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="clr-form-control" style={{ marginTop: 0 }}>
          <label className="clr-control-label">Interface</label>
          <input value={name} disabled className="clr-input" style={wideMono} />
        </div>

        <div className="clr-form-control" style={{ marginTop: 0 }}>
          <label className="clr-control-label">Description</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Router ID"
            className="clr-input"
            style={wide}
          />
        </div>

        <div className="clr-form-control" style={{ marginTop: 0 }}>
          <div className="flex items-center justify-between">
            <label className="clr-control-label" style={{ marginBottom: 0 }}>IP Addresses</label>
            <button type="button" onClick={addAddr} className="btn btn-sm btn-link-neutral">
              <Icon shape="plus" size={12} /> Add Address
            </button>
          </div>
          {addresses.length === 0 ? (
            <div className="clr-subtext">
              No addresses — add a stable /32 like 10.255.0.1/32.
            </div>
          ) : (
            <div className="flex flex-col gap-2" style={{ marginTop: 6 }}>
              {addresses.map((a) => (
                <div key={a.key} className="flex items-center gap-2">
                  <input
                    value={a.value}
                    onChange={(e) => updateAddr(a.key, e.target.value)}
                    placeholder="10.255.0.1/32"
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
            {saving ? "Applying…" : isEdit ? "Apply Changes" : "Configure lo"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
