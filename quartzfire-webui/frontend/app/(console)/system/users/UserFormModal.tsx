"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { applyUser, SshPublicKey, SystemUser } from "@/lib/system";

const monoSt = { fontFamily: "var(--qz-font-mono)", maxWidth: "none" } as const;
const plainSt = { maxWidth: "none" } as const;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="clr-form-control">
      <label className="clr-control-label">{label}</label>
      {children}
      {hint && <div className="clr-subtext">{hint}</div>}
    </div>
  );
}

const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

/// SSH key algorithms VyOS accepts for `public-keys … type`.
const KEY_TYPES = [
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "ssh-dss",
];

/// Editable working copy of one public key row.
interface KeyRow {
  id: string;
  type: string;
  key: string;
}

/// Parse a pasted OpenSSH public key line ("ssh-ed25519 AAAA… user@host")
/// into its parts; returns null when it doesn't look like one.
function parseOpenSshLine(line: string): { type: string; key: string; comment: string | null } | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2 || !KEY_TYPES.includes(parts[0])) return null;
  return { type: parts[0], key: parts[1], comment: parts[2] ?? null };
}

/// Create or edit a `system login user` account: full name, password, and
/// SSH public keys. Passwords are sent as `plaintext-password` — VyOS hashes
/// them into `encrypted-password` at commit.
export function UserFormModal({
  initial,
  existing,
  onClose,
  onSaved,
}: {
  /** Account being edited; undefined = create. */
  initial?: SystemUser;
  existing: SystemUser[];
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = initial !== undefined;

  const [name, setName] = useState(initial?.name ?? "");
  const [fullName, setFullName] = useState(initial?.full_name ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [keys, setKeys] = useState<KeyRow[]>(
    (initial?.keys ?? []).map((k) => ({ id: k.id, type: k.type ?? "ssh-ed25519", key: k.key ?? "" })),
  );

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const setKeyRow = (index: number, patch: Partial<KeyRow>) =>
    setKeys((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  /// The key field accepts either the bare base64 body or a full pasted
  /// OpenSSH line — the latter auto-fills type and (empty) identifier.
  const onKeyPaste = (index: number, value: string) => {
    const parsed = parseOpenSshLine(value);
    if (parsed) {
      setKeys((rows) =>
        rows.map((r, i) =>
          i === index
            ? {
                id: r.id || parsed.comment || "",
                type: parsed.type,
                key: parsed.key,
              }
            : r,
        ),
      );
    } else {
      setKeyRow(index, { key: value.trim() });
    }
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const username = name.trim();
    if (!USERNAME_RE.test(username)) {
      setError("Username must start with a letter or underscore and contain only lowercase letters, digits, hyphens, or underscores.");
      return;
    }
    if (!isEdit && existing.some((u) => u.name === username)) {
      setError(`User ${username} already exists.`);
      return;
    }
    if (!isEdit && password === "") {
      setError("A password is required for a new account.");
      return;
    }
    if (password !== "" && password !== confirm) {
      setError("Passwords don't match.");
      return;
    }

    const desired: SshPublicKey[] = [];
    for (const [i, k] of keys.entries()) {
      const id = k.id.trim();
      const body = k.key.trim();
      if (id === "" && body === "") continue; // blank row — ignore
      if (id === "") {
        setError(`Key ${i + 1} needs an identifier (conventionally user@host).`);
        return;
      }
      if (/\s/.test(id)) {
        setError(`Key identifier "${id}" can't contain spaces.`);
        return;
      }
      if (!/^[A-Za-z0-9+/=]+$/.test(body)) {
        setError(`Key "${id}" doesn't look like a base64 key body. Paste the full OpenSSH line or just the base64 part.`);
        return;
      }
      if (desired.some((d) => d.id === id)) {
        setError(`Duplicate key identifier "${id}".`);
        return;
      }
      desired.push({ id, type: k.type, key: body });
    }

    setSaving(true);
    try {
      const applied = await applyUser(existing, {
        name: username,
        full_name: fullName.trim() || null,
        password: password === "" ? null : password,
        keys: desired,
        original_name: initial?.name ?? null,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : isEdit
            ? `Updated user ${username}.`
            : `Created user ${username}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply the user account.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={600}>
      <ModalHeader
        title={isEdit ? `Edit User — ${initial.name}` : "Create User"}
        subtitle="Administrator account for the WebUI and console/SSH logins"
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Username">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="admin"
              disabled={isEdit}
              autoComplete="off"
              className="clr-input"
              style={monoSt}
            />
          </Field>
          <Field label="Full Name" hint="Optional display name.">
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Jane Admin"
              className="clr-input"
              style={plainSt}
            />
          </Field>
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label={isEdit ? "New Password" : "Password"} hint={isEdit ? "Leave empty to keep the current password." : undefined}>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              className="clr-input"
              style={plainSt}
            />
          </Field>
          <Field label="Confirm Password">
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              className="clr-input"
              style={plainSt}
            />
          </Field>
        </div>

        <div>
          <div className="flex items-center justify-between mb-[6px]">
            <label className="clr-control-label" style={{ marginBottom: 0 }}>SSH Public Keys</label>
            <button
              type="button"
              onClick={() => setKeys((rows) => [...rows, { id: "", type: "ssh-ed25519", key: "" }])}
              className="btn btn-sm btn-link-neutral"
              style={{ margin: 0 }}
            >
              <Icon shape="plus" size={13} /> Add Key
            </button>
          </div>

          {keys.length === 0 ? (
            <p className="clr-subtext" style={{ margin: 0 }}>
              No keys — this account signs in with its password only.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {keys.map((k, i) => (
                <div
                  key={i}
                  className="rounded-md p-3 flex flex-col gap-2"
                  style={{ border: "1px solid var(--cds-alias-object-border-color-tint)" }}
                >
                  <div className="flex items-center gap-2">
                    <input
                      value={k.id}
                      onChange={(e) => setKeyRow(i, { id: e.target.value })}
                      placeholder="user@host"
                      className="clr-input"
                      style={{ ...monoSt, flex: 1 }}
                    />
                    <div className="clr-select-wrapper" style={{ width: 200, flexShrink: 0 }}>
                      <select
                        value={k.type}
                        onChange={(e) => setKeyRow(i, { type: e.target.value })}
                        className="clr-select"
                        style={{ ...monoSt, width: "100%" }}
                      >
                        {KEY_TYPES.map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    </div>
                    <button
                      type="button"
                      title="Remove key"
                      aria-label="Remove key"
                      onClick={() => setKeys((rows) => rows.filter((_, j) => j !== i))}
                      className="btn btn-sm btn-link-neutral btn-icon"
                      style={{ margin: 0, flexShrink: 0 }}
                    >
                      <Icon shape="trash" size={14} />
                    </button>
                  </div>
                  <textarea
                    value={k.key}
                    onChange={(e) => onKeyPaste(i, e.target.value)}
                    placeholder="Paste the full OpenSSH public key line, or just its base64 body"
                    rows={2}
                    className="clr-textarea resize-y"
                    style={monoSt}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {error && (
          <p className="m-0" style={{ fontSize: 12, color: "var(--cds-alias-status-danger)" }}>
            {error}
          </p>
        )}

        <ModalFooter>
          <button type="button" className="btn btn-neutral" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "Applying…" : isEdit ? "Apply Changes" : "Create User"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
