"use client";

import { useState } from "react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { L2tpUser, applyL2tpUser, emptyL2tpUser } from "@/lib/l2tp";

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

/// Create/edit one L2TP local user. Diffs against the live config.
export function UserFormModal({ initial, existingNames, onClose, onSaved }: {
  initial?: L2tpUser;
  existingNames: string[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const base = initial ?? emptyL2tpUser();
  const [username, setUsername] = useState(base.username);
  const [password, setPassword] = useState(base.password ?? "");
  const [staticIp, setStaticIp] = useState(base.static_ip ?? "");
  const [disabled, setDisabled] = useState(base.disabled);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    const name = username.trim();
    if (!name) return setError("Enter a username.");
    if (!isEdit && existingNames.includes(name)) return setError(`User ${name} already exists.`);
    if (!isEdit && !password.trim()) return setError("Set a password for the new user.");

    const desired: L2tpUser = {
      username: name,
      password: password.trim() || null,
      static_ip: staticIp.trim() || null,
      disabled,
    };
    setSaving(true);
    try {
      const applied = await applyL2tpUser(initial ?? null, desired);
      onSaved(applied === 0 ? "No changes — config already matches." : `Applied ${applied} change${applied === 1 ? "" : "s"} to ${name}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={480}>
      <ModalHeader title={`${isEdit ? "Edit" : "Add"} L2TP User`} subtitle={isEdit ? initial!.username : "Local remote-access account"} onClose={onClose} />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Username" required>
          <input value={username} disabled={isEdit} onChange={(e) => setUsername(e.target.value)} placeholder="alice" className={`${inputCls} disabled:opacity-70`} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
        </Field>
        <Field label="Password" required={!isEdit} hint={isEdit ? "Leave blank to keep the current password." : undefined}>
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="••••••" className={inputCls} style={inputSt} onFocus={focusBorder} onBlur={blurBorder} />
        </Field>
        <Field label="Static IP" hint="Fixed address for this user (optional).">
          <input value={staticIp} onChange={(e) => setStaticIp(e.target.value)} placeholder="10.10.0.50" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
        </Field>
        <label className="flex items-center gap-2 cursor-pointer select-none text-[13px] text-[var(--qz-fg-2)]">
          <Switch on={disabled} onChange={setDisabled} />
          Account disabled
        </label>

        {error && <p className="text-[12px] m-0" style={{ color: "var(--qz-danger)" }}>{error}</p>}

        <div className="flex gap-2 justify-end mt-1">
          <button type="button" onClick={onClose} className="px-4 py-[9px] rounded-md text-[13px] font-medium cursor-pointer" style={{ background: "transparent", border: "1px solid var(--qz-border)", color: "var(--qz-fg-2)" }}>Cancel</button>
          <button type="submit" disabled={saving} className="px-4 py-[9px] rounded-md text-[13px] font-semibold cursor-pointer border-0" style={{ background: "var(--qz-accent)", color: "var(--qz-fg-on-accent)", opacity: saving ? 0.7 : 1 }}>
            {saving ? "Applying…" : isEdit ? "Apply changes" : "Add user"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
