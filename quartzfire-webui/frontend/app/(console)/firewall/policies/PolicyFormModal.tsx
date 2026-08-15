"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { applyPolicy, FirewallPolicy, FirewallRule, PolicyProtocol, PROTOCOL_LABEL } from "@/lib/firewall";

const monoFont = { fontFamily: "var(--qz-font-mono)" } as const;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="clr-form-control" style={{ marginTop: 0 }}>
      <label className="clr-control-label">{label}</label>
      {children}
      {hint && <div className="clr-subtext">{hint}</div>}
    </div>
  );
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/// A port entry: a number (443), a range (8000-8010), or a service name (https).
function validPort(p: string): boolean {
  if (/^[a-z][a-z0-9-]*$/i.test(p)) return true;
  const inRange = (n: string) => Number(n) >= 1 && Number(n) <= 65535;
  const m = p.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return false;
  if (!inRange(m[1])) return false;
  return m[2] === undefined || (inRange(m[2]) && Number(m[1]) < Number(m[2]));
}

/// Create/edit a policy (a named port set with a protocol). Diffs against the
/// live config and commits immediately (the boot-config save runs in the background). Changing the
/// protocol also updates every rule using the policy.
export function PolicyFormModal({
  initial,
  existing,
  rules,
  usedByRules,
  onClose,
  onSaved,
}: {
  /** Present when editing an existing policy; absent when creating. */
  initial?: FirewallPolicy;
  /** All existing policies, for duplicate detection and diffing. */
  existing: FirewallPolicy[];
  /** All rules — a protocol change is propagated to rules using this policy. */
  rules: FirewallRule[];
  /** Rule numbers referencing the edited policy — locks renaming. */
  usedByRules: number[];
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const locked = isEdit && usedByRules.length > 0;

  const [name, setName] = useState(initial?.name ?? "");
  const [protocol, setProtocol] = useState<PolicyProtocol>(initial?.protocol ?? "tcp");
  const [portsText, setPortsText] = useState(initial?.ports.join("\n") ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const n = name.trim();
    if (!NAME_RE.test(n)) {
      setError("Name must start with a letter and use only letters, digits, hyphens, and underscores.");
      return;
    }
    const clash = existing.some((p) => p.name === n && !(isEdit && p.name === initial!.name));
    if (clash) {
      setError(`A policy named ${n} already exists.`);
      return;
    }

    const ports = portsText
      .split(/[\s,]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (ports.length === 0) {
      setError("Add at least one port.");
      return;
    }
    const bad = ports.find((p) => !validPort(p));
    if (bad) {
      setError(`"${bad}" is not a valid port, range, or service name.`);
      return;
    }

    setSaving(true);
    try {
      const applied = await applyPolicy(existing, rules, {
        name: n,
        protocol,
        ports,
        description: description.trim() || null,
        original_name: initial?.name ?? null,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to policy ${n}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply policy.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={520}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Create"} Policy`}
        subtitle="A named set of TCP/UDP ports for firewall rules"
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field
          label="Name"
          hint={locked ? `In use by rule${usedByRules.length === 1 ? "" : "s"} ${usedByRules.join(", ")} — the name is locked.` : undefined}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="HTTPS"
            disabled={locked}
            className="clr-input"
            style={{ maxWidth: "none", ...monoFont }}
          />
        </Field>

        <Field
          label="Protocol"
          hint={locked ? "Changing the protocol updates every rule using this policy." : undefined}
        >
          <Segmented
            items={(Object.keys(PROTOCOL_LABEL) as PolicyProtocol[]).map((p) => ({
              value: p,
              label: PROTOCOL_LABEL[p],
            }))}
            value={protocol}
            onChange={(v) => setProtocol(v as PolicyProtocol)}
          />
        </Field>

        <Field label="Ports" hint="One per line (commas work too): numbers (443), ranges (8000-8010), or service names (https).">
          <textarea
            value={portsText}
            onChange={(e) => setPortsText(e.target.value)}
            placeholder={"80\n443\n8000-8010"}
            rows={4}
            className="clr-textarea"
            style={{ maxWidth: "none", ...monoFont }}
          />
        </Field>

        <Field label="Description">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Web browsing"
            className="clr-input"
            style={{ maxWidth: "none" }}
          />
        </Field>

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
            {saving ? "Applying…" : isEdit ? "Apply Changes" : "Create Policy"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
