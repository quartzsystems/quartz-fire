"use client";

import { useState } from "react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { IkeGroup, KeyExchange, applyIkeGroup, emptyIkeGroup } from "@/lib/ipsec";
import { ProposalRow, ProposalsEditor, rowsToProposals, toProposalRows } from "./ProposalsEditor";

const inputCls = "w-full rounded-md px-3 py-[9px] text-[13px] text-[var(--qz-fg-1)] outline-none";
const inputSt = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;
const monoSt = { ...inputSt, fontFamily: "var(--qz-font-mono)" } as const;

function focusBorder(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) {
  e.currentTarget.style.borderColor = "var(--qz-accent)";
}
function blurBorder(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) {
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
            <input value={name} disabled={isEdit} onChange={(e) => setName(e.target.value)} placeholder="IKE-DEFAULT" className={`${inputCls} disabled:opacity-70`} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
          </Field>
          <Field label="Key exchange">
            <select value={keyExchange} onChange={(e) => setKeyExchange(e.target.value as KeyExchange | "")} className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder}>
              <option value="">Default (ikev2)</option>
              <option value="ikev1">ikev1</option>
              <option value="ikev2">ikev2</option>
            </select>
          </Field>
        </div>

        <Field label="Lifetime" hint="IKE SA lifetime in seconds (default 28800).">
          <input value={lifetime} onChange={(e) => setLifetime(e.target.value)} placeholder="28800" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
        </Field>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
          <Field label="DPD action" hint="hold / clear / restart / trap.">
            <select value={dpdAction} onChange={(e) => setDpdAction(e.target.value)} className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder}>
              <option value="">None</option>
              <option value="hold">hold</option>
              <option value="clear">clear</option>
              <option value="restart">restart</option>
              <option value="trap">trap</option>
            </select>
          </Field>
          <Field label="DPD interval" hint="Seconds.">
            <input value={dpdInterval} onChange={(e) => setDpdInterval(e.target.value)} placeholder="30" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
          </Field>
          <Field label="DPD timeout" hint="Seconds.">
            <input value={dpdTimeout} onChange={(e) => setDpdTimeout(e.target.value)} placeholder="120" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
          </Field>
        </div>

        <ProposalsEditor rows={proposals} onChange={setProposals} withDh />

        {error && <p className="text-[12px] m-0" style={{ color: "var(--qz-danger)" }}>{error}</p>}

        <div className="flex gap-2 justify-end mt-1">
          <button type="button" onClick={onClose} className="px-4 py-[9px] rounded-md text-[13px] font-medium cursor-pointer" style={{ background: "transparent", border: "1px solid var(--qz-border)", color: "var(--qz-fg-2)" }}>Cancel</button>
          <button type="submit" disabled={saving} className="px-4 py-[9px] rounded-md text-[13px] font-semibold cursor-pointer border-0" style={{ background: "var(--qz-accent)", color: "var(--qz-fg-on-accent)", opacity: saving ? 0.7 : 1 }}>
            {saving ? "Applying…" : isEdit ? "Apply changes" : "Add group"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
