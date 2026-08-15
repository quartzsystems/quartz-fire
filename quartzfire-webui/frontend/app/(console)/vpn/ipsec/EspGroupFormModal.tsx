"use client";

import { useState } from "react";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { EspGroup, EspMode, applyEspGroup, emptyEspGroup } from "@/lib/ipsec";
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

/// Create/edit one IPsec ESP (phase-2) group. Diffs against the live config and
/// commits under commit-confirm.
export function EspGroupFormModal({ initial, existingNames, onClose, onSaved }: {
  initial?: EspGroup;
  existingNames: string[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const base = initial ?? emptyEspGroup();
  const [name, setName] = useState(base.name);
  const [pfs, setPfs] = useState(base.pfs ?? "");
  const [mode, setMode] = useState<EspMode | "">(base.mode ?? "");
  const [lifetime, setLifetime] = useState(numStr(base.lifetime));
  const [proposals, setProposals] = useState<ProposalRow[]>(toProposalRows(base.proposals));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    const gName = name.trim();
    if (!gName) return setError("Enter a group name.");
    if (!isEdit && existingNames.includes(gName)) return setError(`ESP group ${gName} already exists.`);

    const desired: EspGroup = {
      name: gName,
      pfs: pfs.trim() || null,
      mode: mode || null,
      lifetime: numOrNull(lifetime),
      proposals: rowsToProposals(proposals, false),
    };

    setSaving(true);
    try {
      const applied = await applyEspGroup(initial ?? null, desired);
      onSaved(applied === 0 ? "No changes — config already matches." : `Applied ${applied} change${applied === 1 ? "" : "s"} to ${gName}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={560}>
      <ModalHeader title={`${isEdit ? "Edit" : "Add"} ESP Group`} subtitle={isEdit ? initial!.name : "ESP (phase-2) proposals and PFS"} onClose={onClose} />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Name" required>
            <input value={name} disabled={isEdit} onChange={(e) => setName(e.target.value)} placeholder="ESP-DEFAULT" className="clr-input" style={monoSt} />
          </Field>
          <Field label="Mode">
            <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
              <select value={mode} onChange={(e) => setMode(e.target.value as EspMode | "")} className="clr-select" style={monoSt}>
                <option value="">Default (tunnel)</option>
                <option value="tunnel">tunnel</option>
                <option value="transport">transport</option>
              </select>
            </div>
          </Field>
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="PFS" hint="Perfect forward secrecy: enable / disable / dh-group<N>.">
            <input value={pfs} onChange={(e) => setPfs(e.target.value)} placeholder="enable" className="clr-input" style={monoSt} />
          </Field>
          <Field label="Lifetime" hint="ESP SA lifetime in seconds (default 3600).">
            <input value={lifetime} onChange={(e) => setLifetime(e.target.value)} placeholder="3600" className="clr-input" style={monoSt} />
          </Field>
        </div>

        <ProposalsEditor rows={proposals} onChange={setProposals} withDh={false} />

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
