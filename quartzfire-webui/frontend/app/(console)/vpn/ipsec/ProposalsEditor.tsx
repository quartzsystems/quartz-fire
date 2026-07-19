"use client";

import { Plus, Trash2 } from "lucide-react";
import { IpsecProposal } from "@/lib/ipsec";

const inputCls = "w-full rounded-md px-2 py-[7px] text-[13px] text-[var(--qz-fg-1)] outline-none";
const monoSt = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)", fontFamily: "var(--qz-font-mono)" } as const;

function focusBorder(e: React.FocusEvent<HTMLInputElement>) {
  e.currentTarget.style.borderColor = "var(--qz-accent)";
}
function blurBorder(e: React.FocusEvent<HTMLInputElement>) {
  e.currentTarget.style.borderColor = "var(--qz-border)";
}

let keyCounter = 0;
const nextKey = () => `prop-${keyCounter++}`;

/// A proposal row while editing (all strings + a stable react key).
export interface ProposalRow {
  key: string;
  seq: string;
  encryption: string;
  hash: string;
  dh_group: string;
}

export const newProposalRow = (seq = 10): ProposalRow => ({
  key: nextKey(),
  seq: String(seq),
  encryption: "",
  hash: "",
  dh_group: "",
});

export function toProposalRows(ps: IpsecProposal[]): ProposalRow[] {
  return ps.map((p) => ({
    key: nextKey(),
    seq: String(p.seq),
    encryption: p.encryption ?? "",
    hash: p.hash ?? "",
    dh_group: p.dh_group ?? "",
  }));
}

/// Turn edited rows into `IpsecProposal`s, dropping blank/invalid sequence rows.
export function rowsToProposals(rows: ProposalRow[], withDh: boolean): IpsecProposal[] {
  const out: IpsecProposal[] = [];
  for (const r of rows) {
    const seq = Number(r.seq.trim());
    if (!Number.isInteger(seq) || seq <= 0) continue;
    out.push({
      seq,
      encryption: r.encryption.trim() || null,
      hash: r.hash.trim() || null,
      dh_group: withDh ? r.dh_group.trim() || null : null,
    });
  }
  return out;
}

/// Repeatable proposal-row editor shared by the IKE and ESP group modals.
/// `withDh` shows the Diffie-Hellman group column (IKE proposals only).
export function ProposalsEditor({ rows, onChange, withDh }: {
  rows: ProposalRow[];
  onChange: (rows: ProposalRow[]) => void;
  withDh: boolean;
}) {
  const add = () => onChange([...rows, newProposalRow((rows.length + 1) * 10)]);
  const remove = (key: string) => onChange(rows.filter((r) => r.key !== key));
  const update = (key: string, patch: Partial<Omit<ProposalRow, "key">>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold text-[var(--qz-fg-2)] uppercase tracking-wide">Proposals</span>
        <button type="button" onClick={add} className="inline-flex items-center gap-1 text-[12px] text-[var(--qz-accent)] cursor-pointer bg-transparent border-0 p-0">
          <Plus size={13} /> Add proposal
        </button>
      </div>

      {rows.length === 0 && <p className="text-[12px] text-[var(--qz-fg-4)] m-0">No proposals — at least one is required for the group to negotiate.</p>}

      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-2">
          <input value={r.seq} onChange={(e) => update(r.key, { seq: e.target.value })} placeholder="#" className={`${inputCls} w-[52px] text-center`} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
          <input value={r.encryption} onChange={(e) => update(r.key, { encryption: e.target.value })} placeholder="aes256" className={`${inputCls} flex-1`} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
          <input value={r.hash} onChange={(e) => update(r.key, { hash: e.target.value })} placeholder="sha256" className={`${inputCls} flex-1`} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
          {withDh && (
            <input value={r.dh_group} onChange={(e) => update(r.key, { dh_group: e.target.value })} placeholder="dh 14" className={`${inputCls} w-[72px]`} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
          )}
          <button type="button" onClick={() => remove(r.key)} className="text-[var(--qz-fg-4)] hover:text-[var(--qz-danger)] cursor-pointer bg-transparent border-0 p-1" title="Remove proposal">
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      <p className="text-[11px] text-[var(--qz-fg-4)] m-0">Columns: sequence · encryption · hash{withDh ? " · DH group" : ""}.</p>
    </div>
  );
}
