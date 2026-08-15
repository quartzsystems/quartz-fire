"use client";

import { useState } from "react";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { IkeGroup, KeyExchange, applyIkeGroup, emptyIkeGroup } from "@/lib/ipsec";
import { ProposalRow, ProposalsEditor, rowsToProposals, toProposalRows } from "./ProposalsEditor";

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

/// Create/edit one IPsec IKE (phase-1) group. Diffs against the live config and
/// commits under commit-confirm.
export function IkeGroupFormModal({ initial, existingNames, onClose, onSaved }: {
  initial?: IkeGroup;
  existingNames: string[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const base = initial ?? emptyIkeGroup();
  const [name, setName] = useState(base.name);
  const [keyExchange, setKeyExchange] = useState<KeyExchange | "">(base.key_exchange ?? "");
  const [lifetime, setLifetime] = useState(numStr(base.lifetime));
  const [dpdAction, setDpdAction] = useState(base.dpd_action ?? "");
  const [dpdInterval, setDpdInterval] = useState(numStr(base.dpd_interval));
  const [dpdTimeout, setDpdTimeout] = useState(numStr(base.dpd_timeout));
  const [proposals, setProposals] = useState<ProposalRow[]>(toProposalRows(base.proposals));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    const gName = name.trim();
    if (!gName) return setError("Enter a group name.");
    if (!isEdit && existingNames.includes(gName)) return setError(`IKE group ${gName} already exists.`);

    const desired: IkeGroup = {
      name: gName,
      key_exchange: keyExchange || null,
      lifetime: numOrNull(lifetime),
      dpd_action: dpdAction.trim() || null,
      dpd_interval: numOrNull(dpdInterval),
      dpd_timeout: numOrNull(dpdTimeout),
      proposals: rowsToProposals(proposals, true),
    };

    setSaving(true);
    try {
      const applied = await applyIkeGroup(initial ?? null, desired);
      onSaved(applied === 0 ? "No changes — config already matches." : `Applied ${applied} change${applied === 1 ? "" : "s"} to ${gName}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={560}>
      <ModalHeader title={`${isEdit ? "Edit" : "Add"} IKE Group`} subtitle={isEdit ? initial!.name : "IKE (phase-1) proposals and timers"} onClose={onClose} />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Name" required>
            <input value={name} disabled={isEdit} onChange={(e) => setName(e.target.value)} placeholder="IKE-DEFAULT" className="clr-input" style={monoSt} />
          </Field>
          <Field label="Key exchange">
            <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
              <select value={keyExchange} onChange={(e) => setKeyExchange(e.target.value as KeyExchange | "")} className="clr-select" style={monoSt}>
                <option value="">Default (ikev2)</option>
                <option value="ikev1">ikev1</option>
                <option value="ikev2">ikev2</option>
              </select>
            </div>
          </Field>
        </div>

        <Field label="Lifetime" hint="IKE SA lifetime in seconds (default 28800).">
          <input value={lifetime} onChange={(e) => setLifetime(e.target.value)} placeholder="28800" className="clr-input" style={monoSt} />
        </Field>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
          <Field label="DPD action" hint="hold / clear / restart / trap.">
            <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
              <select value={dpdAction} onChange={(e) => setDpdAction(e.target.value)} className="clr-select" style={monoSt}>
                <option value="">None</option>
                <option value="hold">hold</option>
                <option value="clear">clear</option>
                <option value="restart">restart</option>
                <option value="trap">trap</option>
              </select>
            </div>
          </Field>
          <Field label="DPD interval" hint="Seconds.">
            <input value={dpdInterval} onChange={(e) => setDpdInterval(e.target.value)} placeholder="30" className="clr-input" style={monoSt} />
          </Field>
          <Field label="DPD timeout" hint="Seconds.">
            <input value={dpdTimeout} onChange={(e) => setDpdTimeout(e.target.value)} placeholder="120" className="clr-input" style={monoSt} />
          </Field>
        </div>

        <ProposalsEditor rows={proposals} onChange={setProposals} withDh />

        {error && <p className="text-[12px] m-0" style={{ color: "var(--cds-alias-status-danger)" }}>{error}</p>}

        <ModalFooter>
          <button type="button" onClick={onClose} className="btn btn-neutral">Cancel</button>
          <button type="submit" disabled={saving} className="btn btn-primary">
            {saving ? "Applying…" : isEdit ? "Apply Changes" : "Add Group"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
