"use client";

import { useState } from "react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { L2tpPool, applyL2tpPool, emptyL2tpPool } from "@/lib/l2tp";

const inputCls = "w-full rounded-md px-3 py-[9px] text-[13px] text-[var(--qz-fg-1)] outline-none";
const monoSt = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)", fontFamily: "var(--qz-font-mono)" } as const;

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
          <input value={name} disabled={isEdit} onChange={(e) => setName(e.target.value)} placeholder="l2tp-pool" className={`${inputCls} disabled:opacity-70`} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
        </Field>
        <Field label="Range" required hint="Start–end (10.10.0.10-10.10.0.100) or a subnet (10.10.0.0/24).">
          <input value={range} onChange={(e) => setRange(e.target.value)} placeholder="10.10.0.10-10.10.0.100" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
        </Field>

        {error && <p className="text-[12px] m-0" style={{ color: "var(--qz-danger)" }}>{error}</p>}

        <div className="flex gap-2 justify-end mt-1">
          <button type="button" onClick={onClose} className="px-4 py-[9px] rounded-md text-[13px] font-medium cursor-pointer" style={{ background: "transparent", border: "1px solid var(--qz-border)", color: "var(--qz-fg-2)" }}>Cancel</button>
          <button type="submit" disabled={saving} className="px-4 py-[9px] rounded-md text-[13px] font-semibold cursor-pointer border-0" style={{ background: "var(--qz-accent)", color: "var(--qz-fg-on-accent)", opacity: saving ? 0.7 : 1 }}>
            {saving ? "Applying…" : isEdit ? "Apply changes" : "Add pool"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
