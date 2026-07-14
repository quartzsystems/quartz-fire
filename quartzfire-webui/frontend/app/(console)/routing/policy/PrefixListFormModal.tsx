"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { applyPrefixList, PrefixFamily, PrefixList, PrefixRule } from "@/lib/routing-policy";

const inputCls = "w-full rounded-md px-2 py-[7px] text-[13px] text-[var(--qz-fg-1)] outline-none";
const inputSt = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;
const monoSt = { ...inputSt, fontFamily: "var(--qz-font-mono)" } as const;

function focusBorder(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) {
  e.currentTarget.style.borderColor = "var(--qz-accent)";
}
function blurBorder(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) {
  e.currentTarget.style.borderColor = "var(--qz-border)";
}

interface RuleRow extends PrefixRule {
  key: string;
}
let keyCounter = 0;
const nextKey = () => `pl-rule-${keyCounter++}`;

function nextSeq(rows: RuleRow[]): number {
  const max = rows.reduce((m, r) => Math.max(m, r.seq), 0);
  return max === 0 ? 10 : max + 10;
}

/// Create/edit a prefix-list as a whole (name + ordered rules). Diffs against
/// the live list and commits under commit-confirm.
export function PrefixListFormModal({
  initial,
  existing,
  onClose,
  onSaved,
}: {
  initial?: PrefixList;
  existing: PrefixList[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name ?? "");
  const [family, setFamily] = useState<PrefixFamily>(initial?.family ?? "ipv4");
  const [rows, setRows] = useState<RuleRow[]>(
    (initial?.rules ?? []).map((r) => ({ ...r, key: nextKey() })),
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const addRule = () =>
    setRows((p) => [...p, { key: nextKey(), seq: nextSeq(p), action: "permit", prefix: "", ge: null, le: null, description: null }]);
  const removeRule = (key: string) => setRows((p) => p.filter((r) => r.key !== key));
  const patch = (key: string, partial: Partial<RuleRow>) =>
    setRows((p) => p.map((r) => (r.key === key ? { ...r, ...partial } : r)));
  const num = (s: string) => (s.trim() === "" ? null : Number(s));

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const trimmedName = name.trim();
    if (!/^[\w.\-]+$/.test(trimmedName)) {
      setError("Name may contain letters, numbers, dot, underscore and hyphen.");
      return;
    }
    if (!isEdit && existing.some((p) => p.name === trimmedName && p.family === family)) {
      setError(`A ${family === "ipv4" ? "IPv4" : "IPv6"} prefix-list named ${trimmedName} already exists.`);
      return;
    }
    if (rows.length === 0) {
      setError("Add at least one rule.");
      return;
    }
    const seqs = new Set<number>();
    for (const r of rows) {
      if (!Number.isInteger(r.seq) || r.seq < 1 || r.seq > 65535) {
        setError("Each rule needs a sequence number between 1 and 65535.");
        return;
      }
      if (seqs.has(r.seq)) {
        setError(`Duplicate sequence number ${r.seq}.`);
        return;
      }
      seqs.add(r.seq);
      if (!r.prefix.trim()) {
        setError(`Rule ${r.seq} needs a prefix.`);
        return;
      }
    }

    const desired: PrefixList = {
      name: trimmedName,
      family,
      rules: rows
        .slice()
        .sort((a, b) => a.seq - b.seq)
        .map(({ key, ...rule }) => ({ ...rule, prefix: rule.prefix.trim(), description: rule.description?.trim() || null })),
    };

    setSaving(true);
    try {
      const applied = await applyPrefixList(initial ?? null, desired);
      onSaved(applied === 0 ? "No changes — config already matches." : `Applied ${applied} change${applied === 1 ? "" : "s"} to ${trimmedName}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply prefix-list.");
    } finally {
      setSaving(false);
    }
  };

  const maxLen = family === "ipv4" ? 32 : 128;

  return (
    <ModalShell onClose={onClose} maxWidth={680}>
      <ModalHeader title={`${isEdit ? "Edit" : "Create"} Prefix List`} subtitle={isEdit ? initial!.name : "Ordered IP prefix match list"} onClose={onClose} />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <div>
            <label className="block text-[12px] text-[var(--qz-fg-3)] mb-[6px]">Name <span style={{ color: "var(--qz-danger)" }}>*</span></label>
            <input value={name} disabled={isEdit} onChange={(e) => setName(e.target.value)} placeholder="ALLOW-LOOPBACKS" className={`${inputCls} disabled:opacity-70`} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
          </div>
          <div>
            <label className="block text-[12px] text-[var(--qz-fg-3)] mb-[6px]">Family</label>
            {isEdit ? (
              <div className="text-[13px] text-[var(--qz-fg-2)] px-1 py-[7px]" style={{ fontFamily: "var(--qz-font-mono)" }}>{family === "ipv4" ? "IPv4" : "IPv6"}</div>
            ) : (
              <Segmented items={[{ value: "ipv4", label: "IPv4" }, { value: "ipv6", label: "IPv6" }]} value={family} onChange={(v) => setFamily(v as PrefixFamily)} />
            )}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-[6px]">
            <label className="block text-[12px] text-[var(--qz-fg-3)]">Rules</label>
            <button type="button" onClick={addRule} className="flex items-center gap-[5px] text-[12px] text-[var(--qz-fg-3)] hover:text-[var(--qz-accent)] transition-colors cursor-pointer bg-transparent border-0 p-0">
              <Plus size={13} /> Add rule
            </button>
          </div>
          {rows.length === 0 ? (
            <p className="text-[12px] text-[var(--qz-fg-4)] m-0">No rules yet — an empty prefix-list matches nothing.</p>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="grid gap-2 text-[11px] text-[var(--qz-fg-4)] px-1" style={{ gridTemplateColumns: "70px 90px 1fr 60px 60px 32px" }}>
                <span>Seq</span><span>Action</span><span>Prefix</span><span>ge</span><span>le</span><span />
              </div>
              {rows.map((r) => (
                <div key={r.key} className="grid gap-2 items-center" style={{ gridTemplateColumns: "70px 90px 1fr 60px 60px 32px" }}>
                  <input value={r.seq} onChange={(e) => patch(r.key, { seq: Number(e.target.value) })} className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
                  <select value={r.action} onChange={(e) => patch(r.key, { action: e.target.value as PrefixRule["action"] })} className={inputCls} style={inputSt} onFocus={focusBorder} onBlur={blurBorder}>
                    <option value="permit">permit</option>
                    <option value="deny">deny</option>
                  </select>
                  <input value={r.prefix} onChange={(e) => patch(r.key, { prefix: e.target.value })} placeholder={family === "ipv4" ? "10.0.0.0/8" : "2001:db8::/32"} className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
                  <input value={r.ge ?? ""} onChange={(e) => patch(r.key, { ge: num(e.target.value) })} placeholder="0" title={`ge (0–${maxLen})`} className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
                  <input value={r.le ?? ""} onChange={(e) => patch(r.key, { le: num(e.target.value) })} placeholder={String(maxLen)} title={`le (0–${maxLen})`} className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
                  <button type="button" onClick={() => removeRule(r.key)} title="Remove rule" className="grid place-items-center w-8 h-8 rounded-md text-[var(--qz-fg-4)] hover:text-[var(--qz-danger)] transition-colors cursor-pointer bg-transparent" style={{ border: "1px solid var(--qz-border)" }}>
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && <p className="text-[12px] m-0" style={{ color: "var(--qz-danger)" }}>{error}</p>}

        <div className="flex gap-2 justify-end mt-1">
          <button type="button" onClick={onClose} className="px-4 py-[9px] rounded-md text-[13px] font-medium cursor-pointer" style={{ background: "transparent", border: "1px solid var(--qz-border)", color: "var(--qz-fg-2)" }}>Cancel</button>
          <button type="submit" disabled={saving} className="px-4 py-[9px] rounded-md text-[13px] font-semibold cursor-pointer border-0" style={{ background: "var(--qz-accent)", color: "var(--qz-fg-on-accent)", opacity: saving ? 0.7 : 1 }}>
            {saving ? "Applying…" : isEdit ? "Apply changes" : "Create prefix-list"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
