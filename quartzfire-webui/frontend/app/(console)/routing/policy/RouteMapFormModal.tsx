"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import {
  applyRouteMap,
  emptyRouteMapRule,
  RouteMap,
  RouteMapMatch,
  RouteMapRule,
  RouteMapSet,
} from "@/lib/routing-policy";

const inputCls = "w-full rounded-md px-2 py-[7px] text-[12.5px] text-[var(--qz-fg-1)] outline-none";
const inputSt = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;
const monoSt = { ...inputSt, fontFamily: "var(--qz-font-mono)" } as const;

function focusBorder(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) {
  e.currentTarget.style.borderColor = "var(--qz-accent)";
}
function blurBorder(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) {
  e.currentTarget.style.borderColor = "var(--qz-border)";
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] text-[var(--qz-fg-4)] mb-[3px]">{label}</label>
      {children}
    </div>
  );
}

interface RuleRow extends RouteMapRule {
  key: string;
}
let keyCounter = 0;
const nextKey = () => `rm-rule-${keyCounter++}`;
const nextSeq = (rows: RuleRow[]) => {
  const max = rows.reduce((m, r) => Math.max(m, r.seq), 0);
  return max === 0 ? 10 : max + 10;
};
const emptyStr = (s: string) => (s.trim() === "" ? null : s.trim());
const emptyNum = (s: string) => (s.trim() === "" ? null : Number(s));

function RuleCard({
  rule,
  onChange,
  onRemove,
}: {
  rule: RuleRow;
  onChange: (partial: Partial<RuleRow>) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(true);
  const m = rule.match;
  const s = rule.set;
  const setM = (partial: Partial<RouteMapMatch>) => onChange({ match: { ...m, ...partial } });
  const setS = (partial: Partial<RouteMapSet>) => onChange({ set: { ...s, ...partial } });
  const inp = (v: string | number | null, on: (val: string) => void, ph = "", mono = true) => (
    <input value={v ?? ""} onChange={(e) => on(e.target.value)} placeholder={ph} className={inputCls} style={mono ? monoSt : inputSt} onFocus={focusBorder} onBlur={blurBorder} />
  );

  return (
    <div className="rounded-md" style={inputSt}>
      <div className="flex items-center gap-2 px-3 py-[9px]">
        <button type="button" onClick={() => setOpen((o) => !o)} className="bg-transparent border-0 p-0 cursor-pointer text-[var(--qz-fg-3)]">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <span className="text-[12px] text-[var(--qz-fg-4)]">Seq</span>
        <input value={rule.seq} onChange={(e) => onChange({ seq: Number(e.target.value) })} className="w-[64px] rounded px-2 py-[5px] text-[12.5px] outline-none" style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
        <select value={rule.action} onChange={(e) => onChange({ action: e.target.value as RuleRow["action"] })} className="rounded px-2 py-[5px] text-[12.5px] outline-none" style={inputSt} onFocus={focusBorder} onBlur={blurBorder}>
          <option value="permit">permit</option>
          <option value="deny">deny</option>
        </select>
        <input value={rule.description ?? ""} onChange={(e) => onChange({ description: e.target.value || null })} placeholder="description" className="flex-1 rounded px-2 py-[5px] text-[12.5px] outline-none" style={inputSt} onFocus={focusBorder} onBlur={blurBorder} />
        <button type="button" onClick={onRemove} title="Remove rule" className="grid place-items-center w-8 h-8 rounded-md text-[var(--qz-fg-4)] hover:text-[var(--qz-danger)] transition-colors cursor-pointer bg-transparent" style={{ border: "1px solid var(--qz-border)" }}>
          <Trash2 size={13} />
        </button>
      </div>

      {open && (
        <div className="px-3 pb-3 flex flex-col gap-3 border-t" style={{ borderColor: "var(--qz-border)" }}>
          <div className="pt-3">
            <div className="text-[11px] font-semibold text-[var(--qz-fg-3)] mb-2 uppercase tracking-wide">Match</div>
            <div className="grid gap-2" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
              <Cell label="IPv4 prefix-list">{inp(m.ip_prefix_list, (v) => setM({ ip_prefix_list: emptyStr(v) }), "PL-NAME")}</Cell>
              <Cell label="IPv6 prefix-list">{inp(m.ipv6_prefix_list, (v) => setM({ ipv6_prefix_list: emptyStr(v) }), "PL6-NAME")}</Cell>
              <Cell label="AS-path list">{inp(m.as_path, (v) => setM({ as_path: emptyStr(v) }), "AS-LIST")}</Cell>
              <Cell label="Community list">{inp(m.community_list, (v) => setM({ community_list: emptyStr(v) }), "CL-NAME")}</Cell>
              <Cell label="Interface">{inp(m.interface, (v) => setM({ interface: emptyStr(v) }), "eth0")}</Cell>
              <Cell label="Metric">{inp(m.metric, (v) => setM({ metric: emptyNum(v) }), "100")}</Cell>
              <Cell label="Origin">
                <select value={m.origin ?? ""} onChange={(e) => setM({ origin: emptyStr(e.target.value) })} className={inputCls} style={inputSt} onFocus={focusBorder} onBlur={blurBorder}>
                  <option value="">—</option><option value="igp">igp</option><option value="egp">egp</option><option value="incomplete">incomplete</option>
                </select>
              </Cell>
              <Cell label="Peer">{inp(m.peer, (v) => setM({ peer: emptyStr(v) }), "192.0.2.2")}</Cell>
            </div>
          </div>

          <div>
            <div className="text-[11px] font-semibold text-[var(--qz-fg-3)] mb-2 uppercase tracking-wide">Set</div>
            <div className="grid gap-2" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
              <Cell label="AS-path prepend">{inp(s.as_path_prepend, (v) => setS({ as_path_prepend: emptyStr(v) }), "65001 65001")}</Cell>
              <Cell label="Community">{inp(s.community, (v) => setS({ community: emptyStr(v) }), "65001:100")}</Cell>
              <Cell label="Local-preference">{inp(s.local_preference, (v) => setS({ local_preference: emptyNum(v) }), "100")}</Cell>
              <Cell label="Metric">{inp(s.metric, (v) => setS({ metric: emptyStr(v) }), "+10 / 100")}</Cell>
              <Cell label="IP next-hop">{inp(s.ip_next_hop, (v) => setS({ ip_next_hop: emptyStr(v) }), "192.0.2.1")}</Cell>
              <Cell label="Origin">
                <select value={s.origin ?? ""} onChange={(e) => setS({ origin: emptyStr(e.target.value) })} className={inputCls} style={inputSt} onFocus={focusBorder} onBlur={blurBorder}>
                  <option value="">—</option><option value="igp">igp</option><option value="egp">egp</option><option value="incomplete">incomplete</option>
                </select>
              </Cell>
              <Cell label="Weight">{inp(s.weight, (v) => setS({ weight: emptyNum(v) }), "0")}</Cell>
              <Cell label="Tag">{inp(s.tag, (v) => setS({ tag: emptyNum(v) }), "0")}</Cell>
            </div>
          </div>

          <div className="grid gap-2" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
            <Cell label="On-match">
              <select
                value={rule.on_match.kind}
                onChange={(e) => onChange({ on_match: { kind: e.target.value as RuleRow["on_match"]["kind"], goto: e.target.value === "goto" ? rule.on_match.goto : null } })}
                className={inputCls}
                style={inputSt}
                onFocus={focusBorder}
                onBlur={blurBorder}
              >
                <option value="none">—</option><option value="next">next</option><option value="goto">goto</option>
              </select>
            </Cell>
            {rule.on_match.kind === "goto" && (
              <Cell label="Goto seq">{inp(rule.on_match.goto, (v) => onChange({ on_match: { kind: "goto", goto: emptyNum(v) } }), "50")}</Cell>
            )}
            <Cell label="Call route-map">{inp(rule.call, (v) => onChange({ call: emptyStr(v) }), "RM-NAME")}</Cell>
          </div>
        </div>
      )}
    </div>
  );
}

/// Create/edit a route-map as a whole (name + ordered rules). Diffs against the
/// live map and commits under commit-confirm.
export function RouteMapFormModal({
  initial,
  existingNames,
  onClose,
  onSaved,
}: {
  initial?: RouteMap;
  existingNames: string[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name ?? "");
  const [rows, setRows] = useState<RuleRow[]>((initial?.rules ?? []).map((r) => ({ ...r, key: nextKey() })));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const addRule = () => setRows((p) => [...p, { ...emptyRouteMapRule(nextSeq(p)), key: nextKey() }]);
  const patch = (key: string, partial: Partial<RuleRow>) => setRows((p) => p.map((r) => (r.key === key ? { ...r, ...partial } : r)));
  const removeRule = (key: string) => setRows((p) => p.filter((r) => r.key !== key));

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const trimmedName = name.trim();
    if (!/^[\w.\-]+$/.test(trimmedName)) {
      setError("Name may contain letters, numbers, dot, underscore and hyphen.");
      return;
    }
    if (!isEdit && existingNames.includes(trimmedName)) {
      setError(`A route-map named ${trimmedName} already exists.`);
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
      if (r.on_match.kind === "goto" && r.on_match.goto == null) {
        setError(`Rule ${r.seq}: on-match goto needs a target sequence.`);
        return;
      }
    }

    const desired: RouteMap = {
      name: trimmedName,
      rules: rows
        .slice()
        .sort((a, b) => a.seq - b.seq)
        .map(({ key, ...rule }) => rule),
    };

    setSaving(true);
    try {
      const applied = await applyRouteMap(initial ?? null, desired);
      onSaved(applied === 0 ? "No changes — config already matches." : `Applied ${applied} change${applied === 1 ? "" : "s"} to ${trimmedName}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply route-map.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={720}>
      <ModalHeader title={`${isEdit ? "Edit" : "Create"} Route Map`} subtitle={isEdit ? initial!.name : "Ordered match/set policy"} onClose={onClose} />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <div>
          <label className="block text-[12px] text-[var(--qz-fg-3)] mb-[6px]">Name <span style={{ color: "var(--qz-danger)" }}>*</span></label>
          <input value={name} disabled={isEdit} onChange={(e) => setName(e.target.value)} placeholder="RM-EVPN-IN" className={`${inputCls} py-[9px] disabled:opacity-70`} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
        </div>

        <div>
          <div className="flex items-center justify-between mb-[6px]">
            <label className="block text-[12px] text-[var(--qz-fg-3)]">Rules</label>
            <button type="button" onClick={addRule} className="flex items-center gap-[5px] text-[12px] text-[var(--qz-fg-3)] hover:text-[var(--qz-accent)] transition-colors cursor-pointer bg-transparent border-0 p-0">
              <Plus size={13} /> Add rule
            </button>
          </div>
          {rows.length === 0 ? (
            <p className="text-[12px] text-[var(--qz-fg-4)] m-0">No rules yet — an empty route-map denies everything.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {rows.map((r) => (
                <RuleCard key={r.key} rule={r} onChange={(partial) => patch(r.key, partial)} onRemove={() => removeRule(r.key)} />
              ))}
            </div>
          )}
        </div>

        {error && <p className="text-[12px] m-0" style={{ color: "var(--qz-danger)" }}>{error}</p>}

        <div className="flex gap-2 justify-end mt-1">
          <button type="button" onClick={onClose} className="px-4 py-[9px] rounded-md text-[13px] font-medium cursor-pointer" style={{ background: "transparent", border: "1px solid var(--qz-border)", color: "var(--qz-fg-2)" }}>Cancel</button>
          <button type="submit" disabled={saving} className="px-4 py-[9px] rounded-md text-[13px] font-semibold cursor-pointer border-0" style={{ background: "var(--qz-accent)", color: "var(--qz-fg-on-accent)", opacity: saving ? 0.7 : 1 }}>
            {saving ? "Applying…" : isEdit ? "Apply changes" : "Create route-map"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
