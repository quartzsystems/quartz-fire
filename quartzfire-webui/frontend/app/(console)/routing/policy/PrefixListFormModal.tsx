"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { applyPrefixList, PrefixFamily, PrefixList, PrefixRule } from "@/lib/routing-policy";

const inputStyle = { maxWidth: "none", width: "100%" } as const;
const monoStyle = { ...inputStyle, fontFamily: "var(--qz-font-mono)" } as const;

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
          <div className="clr-form-control" style={{ marginTop: 0 }}>
            <label className="clr-control-label">Name <span style={{ color: "var(--cds-alias-status-danger)" }}>*</span></label>
            <input value={name} disabled={isEdit} onChange={(e) => setName(e.target.value)} placeholder="ALLOW-LOOPBACKS" className="clr-input" style={monoStyle} />
          </div>
          <div className="clr-form-control" style={{ marginTop: 0 }}>
            <label className="clr-control-label">Family</label>
            {isEdit ? (
              <div style={{ fontSize: 13, padding: "7px 4px", fontFamily: "var(--qz-font-mono)", color: "var(--cds-alias-typography-color-400)" }}>{family === "ipv4" ? "IPv4" : "IPv6"}</div>
            ) : (
              <Segmented items={[{ value: "ipv4", label: "IPv4" }, { value: "ipv6", label: "IPv6" }]} value={family} onChange={(v) => setFamily(v as PrefixFamily)} />
            )}
          </div>
        </div>

        <div className="clr-form-control" style={{ marginTop: 0 }}>
          <div className="flex items-center justify-between">
            <label className="clr-control-label" style={{ marginBottom: 0 }}>Rules</label>
            <button type="button" onClick={addRule} className="btn btn-sm btn-link-neutral">
              <Icon shape="plus" size={12} /> Add Rule
            </button>
          </div>
          {rows.length === 0 ? (
            <p className="clr-subtext" style={{ margin: 0 }}>No rules yet — an empty prefix-list matches nothing.</p>
          ) : (
            <div className="flex flex-col gap-2" style={{ marginTop: 6 }}>
              <div className="grid gap-2 clr-subtext px-1" style={{ gridTemplateColumns: "70px 90px 1fr 60px 60px 32px", marginTop: 0 }}>
                <span>Seq</span><span>Action</span><span>Prefix</span><span>ge</span><span>le</span><span />
              </div>
              {rows.map((r) => (
                <div key={r.key} className="grid gap-2 items-center" style={{ gridTemplateColumns: "70px 90px 1fr 60px 60px 32px" }}>
                  <input value={r.seq} onChange={(e) => patch(r.key, { seq: Number(e.target.value) })} className="clr-input" style={monoStyle} />
                  <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
                    <select value={r.action} onChange={(e) => patch(r.key, { action: e.target.value as PrefixRule["action"] })} className="clr-select" style={inputStyle}>
                      <option value="permit">permit</option>
                      <option value="deny">deny</option>
                    </select>
                  </div>
                  <input value={r.prefix} onChange={(e) => patch(r.key, { prefix: e.target.value })} placeholder={family === "ipv4" ? "10.0.0.0/8" : "2001:db8::/32"} className="clr-input" style={monoStyle} />
                  <input value={r.ge ?? ""} onChange={(e) => patch(r.key, { ge: num(e.target.value) })} placeholder="0" title={`ge (0–${maxLen})`} className="clr-input" style={monoStyle} />
                  <input value={r.le ?? ""} onChange={(e) => patch(r.key, { le: num(e.target.value) })} placeholder={String(maxLen)} title={`le (0–${maxLen})`} className="clr-input" style={monoStyle} />
                  <button
                    type="button"
                    onClick={() => removeRule(r.key)}
                    title="Remove rule"
                    aria-label="Remove rule"
                    className="btn btn-sm btn-link-neutral btn-icon"
                  >
                    <Icon shape="trash" size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && (
          <div className="alert alert-danger alert-sm">
            <Icon shape="exclamation-circle" size={14} className="alert-icon" />
            <div className="alert-text">{error}</div>
          </div>
        )}

        <ModalFooter>
          <button type="button" className="btn btn-neutral" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "Applying…" : isEdit ? "Apply Changes" : "Create Prefix-List"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
