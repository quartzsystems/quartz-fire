"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import {
  applyRouteMap,
  emptyRouteMapRule,
  RouteMap,
  RouteMapMatch,
  RouteMapRule,
  RouteMapSet,
} from "@/lib/routing-policy";

const inputStyle = { maxWidth: "none", width: "100%" } as const;
const monoStyle = { ...inputStyle, fontFamily: "var(--qz-font-mono)" } as const;

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="clr-form-control" style={{ marginTop: 0 }}>
      <label className="clr-control-label">{label}</label>
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
    <input value={v ?? ""} onChange={(e) => on(e.target.value)} placeholder={ph} className="clr-input" style={mono ? monoStyle : inputStyle} />
  );

  return (
    <div style={{ border: "1px solid var(--cds-alias-object-border-color)", borderRadius: "var(--clr-base-border-radius-s)", background: "var(--cds-alias-object-container-background)" }}>
      <div className="flex items-center gap-2 px-3 py-[9px]">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="bg-transparent border-0 p-0 cursor-pointer"
          style={{ color: "var(--cds-alias-typography-color-300)" }}
          aria-label={open ? "Collapse rule" : "Expand rule"}
        >
          <Icon shape="angle" dir={open ? "down" : "right"} size={14} />
        </button>
        <span className="clr-secondary">Seq</span>
        <input value={rule.seq} onChange={(e) => onChange({ seq: Number(e.target.value) })} className="clr-input" style={{ width: 64, fontFamily: "var(--qz-font-mono)" }} />
        <div className="clr-select-wrapper">
          <select value={rule.action} onChange={(e) => onChange({ action: e.target.value as RuleRow["action"] })} className="clr-select">
            <option value="permit">permit</option>
            <option value="deny">deny</option>
          </select>
        </div>
        <input value={rule.description ?? ""} onChange={(e) => onChange({ description: e.target.value || null })} placeholder="description" className="clr-input flex-1" style={{ maxWidth: "none" }} />
        <button
          type="button"
          onClick={onRemove}
          title="Remove rule"
          aria-label="Remove rule"
          className="btn btn-sm btn-link-neutral btn-icon"
        >
          <Icon shape="trash" size={13} />
        </button>
      </div>

      {open && (
        <div className="px-3 pb-3 flex flex-col gap-3 border-t" style={{ borderColor: "var(--cds-alias-object-border-subtle)" }}>
          <div className="pt-3">
            <div className="clr-smallcaption" style={{ marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, color: "var(--cds-alias-typography-color-300)" }}>Match</div>
            <div className="grid gap-2" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
              <Cell label="IPv4 prefix-list">{inp(m.ip_prefix_list, (v) => setM({ ip_prefix_list: emptyStr(v) }), "PL-NAME")}</Cell>
              <Cell label="IPv6 prefix-list">{inp(m.ipv6_prefix_list, (v) => setM({ ipv6_prefix_list: emptyStr(v) }), "PL6-NAME")}</Cell>
              <Cell label="AS-path list">{inp(m.as_path, (v) => setM({ as_path: emptyStr(v) }), "AS-LIST")}</Cell>
              <Cell label="Community list">{inp(m.community_list, (v) => setM({ community_list: emptyStr(v) }), "CL-NAME")}</Cell>
              <Cell label="Interface">{inp(m.interface, (v) => setM({ interface: emptyStr(v) }), "eth0")}</Cell>
              <Cell label="Metric">{inp(m.metric, (v) => setM({ metric: emptyNum(v) }), "100")}</Cell>
              <Cell label="Origin">
                <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
                  <select value={m.origin ?? ""} onChange={(e) => setM({ origin: emptyStr(e.target.value) })} className="clr-select" style={inputStyle}>
                    <option value="">—</option><option value="igp">igp</option><option value="egp">egp</option><option value="incomplete">incomplete</option>
                  </select>
                </div>
              </Cell>
              <Cell label="Peer">{inp(m.peer, (v) => setM({ peer: emptyStr(v) }), "192.0.2.2")}</Cell>
            </div>
          </div>

          <div>
            <div className="clr-smallcaption" style={{ marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, color: "var(--cds-alias-typography-color-300)" }}>Set</div>
            <div className="grid gap-2" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
              <Cell label="AS-path prepend">{inp(s.as_path_prepend, (v) => setS({ as_path_prepend: emptyStr(v) }), "65001 65001")}</Cell>
              <Cell label="Community">{inp(s.community, (v) => setS({ community: emptyStr(v) }), "65001:100")}</Cell>
              <Cell label="Local-preference">{inp(s.local_preference, (v) => setS({ local_preference: emptyNum(v) }), "100")}</Cell>
              <Cell label="Metric">{inp(s.metric, (v) => setS({ metric: emptyStr(v) }), "+10 / 100")}</Cell>
              <Cell label="IP next-hop">{inp(s.ip_next_hop, (v) => setS({ ip_next_hop: emptyStr(v) }), "192.0.2.1")}</Cell>
              <Cell label="Origin">
                <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
                  <select value={s.origin ?? ""} onChange={(e) => setS({ origin: emptyStr(e.target.value) })} className="clr-select" style={inputStyle}>
                    <option value="">—</option><option value="igp">igp</option><option value="egp">egp</option><option value="incomplete">incomplete</option>
                  </select>
                </div>
              </Cell>
              <Cell label="Weight">{inp(s.weight, (v) => setS({ weight: emptyNum(v) }), "0")}</Cell>
              <Cell label="Tag">{inp(s.tag, (v) => setS({ tag: emptyNum(v) }), "0")}</Cell>
            </div>
          </div>

          <div className="grid gap-2" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
            <Cell label="On-match">
              <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
                <select
                  value={rule.on_match.kind}
                  onChange={(e) => onChange({ on_match: { kind: e.target.value as RuleRow["on_match"]["kind"], goto: e.target.value === "goto" ? rule.on_match.goto : null } })}
                  className="clr-select"
                  style={inputStyle}
                >
                  <option value="none">—</option><option value="next">next</option><option value="goto">goto</option>
                </select>
              </div>
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
        <div className="clr-form-control" style={{ marginTop: 0 }}>
          <label className="clr-control-label">Name <span style={{ color: "var(--cds-alias-status-danger)" }}>*</span></label>
          <input value={name} disabled={isEdit} onChange={(e) => setName(e.target.value)} placeholder="RM-EVPN-IN" className="clr-input" style={monoStyle} />
        </div>

        <div className="clr-form-control" style={{ marginTop: 0 }}>
          <div className="flex items-center justify-between">
            <label className="clr-control-label" style={{ marginBottom: 0 }}>Rules</label>
            <button type="button" onClick={addRule} className="btn btn-sm btn-link-neutral">
              <Icon shape="plus" size={12} /> Add Rule
            </button>
          </div>
          {rows.length === 0 ? (
            <p className="clr-subtext" style={{ margin: 0 }}>No rules yet — an empty route-map denies everything.</p>
          ) : (
            <div className="flex flex-col gap-2" style={{ marginTop: 6 }}>
              {rows.map((r) => (
                <RuleCard key={r.key} rule={r} onChange={(partial) => patch(r.key, partial)} onRemove={() => removeRule(r.key)} />
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
            {saving ? "Applying…" : isEdit ? "Apply Changes" : "Create Route-Map"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
