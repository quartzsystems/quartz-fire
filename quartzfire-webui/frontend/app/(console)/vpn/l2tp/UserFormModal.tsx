"use client";

import { useState } from "react";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { Icon } from "@/components/ui/Icon";
import { Switch } from "@/components/ui/Switch";
import { L2tpUser, applyL2tpUser, emptyL2tpUser } from "@/lib/l2tp";

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
          <input value={username} disabled={isEdit} onChange={(e) => setUsername(e.target.value)} placeholder="alice" className="clr-input" style={monoSt} />
        </Field>
        <Field label="Password" required={!isEdit} hint={isEdit ? "Leave blank to keep the current password." : undefined}>
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="••••••" className="clr-input" style={inputSt} />
        </Field>
        <Field label="Static IP" hint="Fixed address for this user (optional).">
          <input value={staticIp} onChange={(e) => setStaticIp(e.target.value)} placeholder="10.10.0.50" className="clr-input" style={monoSt} />
        </Field>
        <label className="flex items-center gap-2 cursor-pointer select-none text-[13px]" style={{ color: "var(--cds-alias-typography-color-400)" }}>
          <Switch on={disabled} onChange={setDisabled} />
          Account disabled
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
            {saving ? "Applying…" : isEdit ? "Apply Changes" : "Add User"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
