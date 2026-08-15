"use client";

import { Button, IconButton } from "@/components/ui/Button";
import { IpsecProposal } from "@/lib/ipsec";

const monoSt = { maxWidth: "none", fontFamily: "var(--qz-font-mono)" } as const;

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
        <span className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--cds-alias-typography-color-400)" }}>Proposals</span>
        <Button kind="ghost" size="sm" icon="plus" onClick={add}>Add Proposal</Button>
      </div>

      {rows.length === 0 && <p className="text-[12px] m-0" style={{ color: "var(--cds-alias-typography-color-300)" }}>No proposals — at least one is required for the group to negotiate.</p>}

      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-2">
          <input value={r.seq} onChange={(e) => update(r.key, { seq: e.target.value })} placeholder="#" className="clr-input text-center" style={{ ...monoSt, width: 52, flex: "none" }} />
          <input value={r.encryption} onChange={(e) => update(r.key, { encryption: e.target.value })} placeholder="aes256" className="clr-input flex-1" style={monoSt} />
          <input value={r.hash} onChange={(e) => update(r.key, { hash: e.target.value })} placeholder="sha256" className="clr-input flex-1" style={monoSt} />
          {withDh && (
            <input value={r.dh_group} onChange={(e) => update(r.key, { dh_group: e.target.value })} placeholder="dh 14" className="clr-input" style={{ ...monoSt, width: 72, flex: "none" }} />
          )}
          <IconButton icon="trash" onClick={() => remove(r.key)} label="Remove proposal" />
        </div>
      ))}
      <p className="clr-subtext m-0">Columns: sequence · encryption · hash{withDh ? " · DH group" : ""}.</p>
    </div>
  );
}
