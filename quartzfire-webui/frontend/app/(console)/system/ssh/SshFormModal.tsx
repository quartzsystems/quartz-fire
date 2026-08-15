"use client";

import { useState } from "react";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { applySsh, SshSettings } from "@/lib/system";

const monoSt = { fontFamily: "var(--qz-font-mono)", maxWidth: "none" } as const;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="clr-form-control">
      <label className="clr-control-label">{label}</label>
      {children}
      {hint && <div className="clr-subtext">{hint}</div>}
    </div>
  );
}

const IP_RE = /^[0-9a-f.:]+$/i;

/// Edit the SSH service. Diffs against the live config and commits
/// immediately (the boot-config save runs in the background).
export function SshFormModal({
  live,
  keylessUsers,
  onClose,
  onSaved,
}: {
  live: SshSettings;
  /** Accounts with no public key — disabling password auth locks them out of SSH. */
  keylessUsers: string[];
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const [enabled, setEnabled] = useState(live.enabled);
  const [portsText, setPortsText] = useState(live.ports.join(", "));
  const [listenText, setListenText] = useState(live.listen_addresses.join(", "));
  const [keysOnly, setKeysOnly] = useState(live.password_auth_disabled);

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const ports = portsText.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const listen = listenText.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

    if (enabled) {
      const badPort = ports.find((p) => !/^\d+$/.test(p) || Number(p) < 1 || Number(p) > 65535);
      if (badPort) {
        setError(`"${badPort}" is not a valid port (1–65535).`);
        return;
      }
      const badListen = listen.find((s) => !IP_RE.test(s));
      if (badListen) {
        setError(`"${badListen}" is not a valid listen address.`);
        return;
      }
    }

    setSaving(true);
    try {
      const applied = await applySsh(live, {
        enabled,
        ports,
        listen_addresses: listen,
        password_auth_disabled: keysOnly,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to the SSH service.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply SSH settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={520}>
      <ModalHeader
        title="Edit SSH Service"
        subtitle="Remote console access to the firewall (sshd)"
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex items-center gap-[10px] cursor-pointer select-none">
          <Switch on={enabled} onChange={setEnabled} />
          <span style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>SSH Service enabled</span>
        </label>
        {!enabled && live.enabled && (
          <p className="m-0" style={{ fontSize: 12, color: "var(--cds-alias-status-warning)" }}>
            Disabling SSH removes remote console access — only the local console and this WebUI remain.
          </p>
        )}

        {enabled && (
          <>
            <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <Field label="Ports" hint="Comma-separated. Defaults to 22 when empty.">
                <input
                  value={portsText}
                  onChange={(e) => setPortsText(e.target.value)}
                  placeholder="22"
                  className="clr-input"
                  style={monoSt}
                />
              </Field>

              <Field label="Listen addresses" hint="Empty = listen on all addresses.">
                <input
                  value={listenText}
                  onChange={(e) => setListenText(e.target.value)}
                  placeholder="192.168.1.1"
                  className="clr-input"
                  style={monoSt}
                />
              </Field>
            </div>

            <label className="flex items-center gap-[10px] cursor-pointer select-none">
              <Switch on={keysOnly} onChange={setKeysOnly} />
              <span style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>
                Disable password authentication (keys only)
              </span>
            </label>
            {keysOnly && !live.password_auth_disabled && keylessUsers.length > 0 && (
              <p className="m-0" style={{ fontSize: 12, color: "var(--cds-alias-status-warning)" }}>
                {keylessUsers.length === 1 ? "Account" : "Accounts"}{" "}
                <span style={{ fontFamily: "var(--qz-font-mono)" }}>{keylessUsers.join(", ")}</span>{" "}
                {keylessUsers.length === 1 ? "has" : "have"} no SSH public key and will no longer be able to
                sign in over SSH. WebUI logins are unaffected.
              </p>
            )}
          </>
        )}

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
            {saving ? "Applying…" : "Apply Changes"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
