"use client";

import { useState } from "react";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { L2tpPool, applyL2tpPool, emptyL2tpPool } from "@/lib/l2tp";

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

/// Create/edit one L2TP client IP pool. Diffs against the live config.
export function PoolFormModal({ initial, existingNames, onClose, onSaved }: {
  initial?: L2tpPool;
  existingNames: string[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const base = initial ?? emptyL2tpPool();
  const [name, setName] = useState(base.name);
  const [range, setRange] = useState(base.range ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    const pName = name.trim();
    if (!pName) return setError("Enter a pool name.");
    if (!isEdit && existingNames.includes(pName)) return setError(`Pool ${pName} already exists.`);
    if (!range.trim()) return setError("Enter an address range for the pool.");

    const desired: L2tpPool = { name: pName, range: range.trim() || null };
    setSaving(true);
    try {
      const applied = await applyL2tpPool(initial ?? null, desired);
      onSaved(applied === 0 ? "No changes — config already matches." : `Applied ${applied} change${applied === 1 ? "" : "s"} to ${pName}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={480}>
      <ModalHeader title={`${isEdit ? "Edit" : "Add"} IP Pool`} subtitle={isEdit ? initial!.name : "Address range handed to L2TP clients"} onClose={onClose} />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Pool name" required>
          <input value={name} disabled={isEdit} onChange={(e) => setName(e.target.value)} placeholder="l2tp-pool" className="clr-input" style={monoSt} />
        </Field>
        <Field label="Range" required hint="Start–end (10.10.0.10-10.10.0.100) or a subnet (10.10.0.0/24).">
          <input value={range} onChange={(e) => setRange(e.target.value)} placeholder="10.10.0.10-10.10.0.100" className="clr-input" style={monoSt} />
        </Field>

        {error && <p className="text-[12px] m-0" style={{ color: "var(--cds-alias-status-danger)" }}>{error}</p>}

        <ModalFooter>
          <button type="button" onClick={onClose} className="btn btn-neutral">Cancel</button>
          <button type="submit" disabled={saving} className="btn btn-primary">
            {saving ? "Applying…" : isEdit ? "Apply Changes" : "Add Pool"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
