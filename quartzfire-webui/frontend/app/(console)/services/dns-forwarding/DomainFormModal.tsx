"use client";

import { useState } from "react";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { applyDnsDomain, DnsForwardingDomain } from "@/lib/services";

const mono = { maxWidth: "none", fontFamily: "var(--qz-font-mono)" } as const;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="clr-form-control" style={{ marginTop: 0 }}>
      <label className="clr-control-label">{label}</label>
      {children}
      {hint && <div className="clr-subtext">{hint}</div>}
    </div>
  );
}

const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;
const IP_RE = /^[0-9a-f.:]+$/i;

/// Create/edit a conditional forwarding domain — queries for it go to its own
/// name servers instead of the upstream ones.
export function DomainFormModal({
  initial,
  existing,
  onClose,
  onSaved,
}: {
  /** Present when editing an existing domain; absent when creating. */
  initial?: DnsForwardingDomain;
  /** All existing domains, for duplicate detection and diffing. */
  existing: DnsForwardingDomain[];
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;

  const [name, setName] = useState(initial?.name ?? "");
  const [serversText, setServersText] = useState(initial?.name_servers.join("\n") ?? "");

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const n = name.trim().toLowerCase();
    if (!DOMAIN_RE.test(n)) {
      setError("Domain must be a valid DNS name (e.g. corp.example.com).");
      return;
    }
    const clash = existing.some((d) => d.name === n && !(isEdit && d.name === initial!.name));
    if (clash) {
      setError(`Domain ${n} is already configured.`);
      return;
    }
    const servers = serversText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (servers.length === 0) {
      setError("Add at least one name server for this domain.");
      return;
    }
    const bad = servers.find((s) => !IP_RE.test(s));
    if (bad) {
      setError(`"${bad}" is not a valid name server address.`);
      return;
    }

    setSaving(true);
    try {
      const applied = await applyDnsDomain(existing, {
        name: n,
        name_servers: servers,
        original_name: initial?.name ?? null,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to domain ${n}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply domain.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={460}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Create"} Conditional Domain`}
        subtitle="Send queries for one domain to dedicated name servers"
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Domain">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="corp.example.com"
            className="clr-input"
            style={mono}
          />
        </Field>

        <Field label="Name Servers" hint="One address per line.">
          <textarea
            value={serversText}
            onChange={(e) => setServersText(e.target.value)}
            placeholder={"10.0.0.53"}
            rows={3}
            className="clr-textarea"
            style={mono}
          />
        </Field>

        {error && (
          <p className="text-[12px] m-0" style={{ color: "var(--cds-alias-status-danger)" }}>
            {error}
          </p>
        )}

        <ModalFooter>
          <button type="button" className="btn btn-neutral" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "Applying…" : isEdit ? "Apply Changes" : "Create Domain"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
