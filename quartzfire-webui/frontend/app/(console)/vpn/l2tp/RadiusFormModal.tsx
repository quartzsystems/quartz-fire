"use client";

import { useState } from "react";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { Icon } from "@/components/ui/Icon";
import { Switch } from "@/components/ui/Switch";
import { L2tpRadiusServer, applyL2tpRadius, emptyL2tpRadius } from "@/lib/l2tp";

const inputSt = { maxWidth: "none" } as const;
const monoSt = { maxWidth: "none", fontFamily: "var(--qz-font-mono)" } as const;

function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="clr-form-control" style={{ marginTop: 0 }}>
      <label className="clr-control-label">
        {label} {required && <span className="clr-required">*</span>}
      </label>
      {children}
      {hint && <div className="clr-subtext">{hint}</div>}
    </div>
  );
}

const numOrNull = (s: string) => {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isInteger(n) ? n : null;
};
const numStr = (n: number | null) => (n == null ? "" : String(n));

/// Create/edit one RADIUS server for L2TP authentication. Keyed by address.
export function RadiusFormModal({ initial, existingAddresses, onClose, onSaved }: {
  initial?: L2tpRadiusServer;
  existingAddresses: string[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const base = initial ?? emptyL2tpRadius();
  const [address, setAddress] = useState(base.address);
  const [key, setKey] = useState(base.key ?? "");
  const [port, setPort] = useState(numStr(base.port));
  const [disabled, setDisabled] = useState(base.disabled);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    const addr = address.trim();
    if (!addr) return setError("Enter the server address.");
    if (!isEdit && existingAddresses.includes(addr)) return setError(`Server ${addr} already exists.`);
    if (!isEdit && !key.trim()) return setError("Enter the shared key for the new server.");

    const desired: L2tpRadiusServer = {
      address: addr,
      key: key.trim() || null,
      port: numOrNull(port),
      disabled,
    };
    setSaving(true);
    try {
      const applied = await applyL2tpRadius(initial ?? null, desired);
      onSaved(applied === 0 ? "No changes — config already matches." : `Applied ${applied} change${applied === 1 ? "" : "s"} to ${addr}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={480}>
      <ModalHeader title={`${isEdit ? "Edit" : "Add"} RADIUS Server`} subtitle={isEdit ? initial!.address : "External authentication server"} onClose={onClose} />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Address" required>
          <input value={address} disabled={isEdit} onChange={(e) => setAddress(e.target.value)} placeholder="10.0.0.5" className="clr-input" style={monoSt} />
        </Field>
        <Field label="Shared key" required={!isEdit} hint={isEdit ? "Leave blank to keep the current key." : undefined}>
          <input value={key} onChange={(e) => setKey(e.target.value)} type="password" placeholder="shared secret" className="clr-input" style={inputSt} />
        </Field>
        <Field label="Port" hint="Default 1812.">
          <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="1812" className="clr-input" style={monoSt} />
        </Field>
        <label className="flex items-center gap-2 cursor-pointer select-none text-[13px]" style={{ color: "var(--cds-alias-typography-color-400)" }}>
          <Switch on={disabled} onChange={setDisabled} />
          Server disabled
        </label>

        {error && (
          <div className="alert alert-danger alert-sm">
            <Icon shape="exclamation-circle" size={14} className="alert-icon" />
            <span className="alert-text">{error}</span>
          </div>
        )}

        <ModalFooter>
          <button type="button" onClick={onClose} className="btn btn-neutral">Cancel</button>
          <button type="submit" disabled={saving} className="btn btn-primary">
            {saving ? "Applying…" : isEdit ? "Apply Changes" : "Add Server"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
