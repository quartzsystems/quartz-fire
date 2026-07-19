"use client";

import { useState } from "react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { L2tpRadiusServer, applyL2tpRadius, emptyL2tpRadius } from "@/lib/l2tp";

const inputCls = "w-full rounded-md px-3 py-[9px] text-[13px] text-[var(--qz-fg-1)] outline-none";
const inputSt = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;
const monoSt = { ...inputSt, fontFamily: "var(--qz-font-mono)" } as const;

function focusBorder(e: React.FocusEvent<HTMLInputElement>) {
  e.currentTarget.style.borderColor = "var(--qz-accent)";
}
function blurBorder(e: React.FocusEvent<HTMLInputElement>) {
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
          <input value={address} disabled={isEdit} onChange={(e) => setAddress(e.target.value)} placeholder="10.0.0.5" className={`${inputCls} disabled:opacity-70`} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
        </Field>
        <Field label="Shared key" required={!isEdit} hint={isEdit ? "Leave blank to keep the current key." : undefined}>
          <input value={key} onChange={(e) => setKey(e.target.value)} type="password" placeholder="shared secret" className={inputCls} style={inputSt} onFocus={focusBorder} onBlur={blurBorder} />
        </Field>
        <Field label="Port" hint="Default 1812.">
          <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="1812" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
        </Field>
        <label className="flex items-center gap-2 cursor-pointer select-none text-[13px] text-[var(--qz-fg-2)]">
          <Switch on={disabled} onChange={setDisabled} />
          Server disabled
        </label>

        {error && <p className="text-[12px] m-0" style={{ color: "var(--qz-danger)" }}>{error}</p>}

        <div className="flex gap-2 justify-end mt-1">
          <button type="button" onClick={onClose} className="px-4 py-[9px] rounded-md text-[13px] font-medium cursor-pointer" style={{ background: "transparent", border: "1px solid var(--qz-border)", color: "var(--qz-fg-2)" }}>Cancel</button>
          <button type="submit" disabled={saving} className="px-4 py-[9px] rounded-md text-[13px] font-semibold cursor-pointer border-0" style={{ background: "var(--qz-accent)", color: "var(--qz-fg-on-accent)", opacity: saving ? 0.7 : 1 }}>
            {saving ? "Applying…" : isEdit ? "Apply changes" : "Add server"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
