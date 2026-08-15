"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { applyIsisInterface, emptyIsisInterface, IsisCircuitType, IsisInterface } from "@/lib/isis";

const inputStyle = { maxWidth: "none", width: "100%" } as const;
const monoStyle = { ...inputStyle, fontFamily: "var(--qz-font-mono)" } as const;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="clr-form-control" style={{ marginTop: 0 }}>
      <label className="clr-control-label">{label}</label>
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

/// Create/edit an IS-IS interface. Diffs against the live config and commits
/// under commit-confirm.
export function InterfaceFormModal({ initial, existingNames, interfaces, onClose, onSaved }: {
  initial?: IsisInterface;
  existingNames: string[];
  interfaces: string[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const base = initial ?? emptyIsisInterface();
  const [name, setName] = useState(base.name);
  const [circuitType, setCircuitType] = useState<IsisCircuitType | "">(base.circuit_type ?? "");
  const [hello, setHello] = useState(numStr(base.hello_interval));
  const [helloMult, setHelloMult] = useState(numStr(base.hello_multiplier));
  const [metric, setMetric] = useState(numStr(base.metric));
  const [p2p, setP2p] = useState(base.point_to_point);
  const [passive, setPassive] = useState(base.passive);
  const [bfd, setBfd] = useState(base.bfd);
  const [password, setPassword] = useState(base.password ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    const ifName = name.trim();
    if (!ifName) {
      setError("Enter an interface name.");
      return;
    }
    if (!isEdit && existingNames.includes(ifName)) {
      setError(`Interface ${ifName} already has IS-IS settings.`);
      return;
    }
    const desired: IsisInterface = {
      name: ifName,
      circuit_type: circuitType === "" ? null : circuitType,
      hello_interval: numOrNull(hello),
      hello_multiplier: numOrNull(helloMult),
      metric: numOrNull(metric),
      point_to_point: p2p,
      passive,
      bfd,
      password: password.trim() || null,
    };
    setSaving(true);
    try {
      const applied = await applyIsisInterface(initial ?? null, desired);
      onSaved(applied === 0 ? "No changes — config already matches." : `Applied ${applied} change${applied === 1 ? "" : "s"} to ${ifName}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={560}>
      <ModalHeader title={`${isEdit ? "Edit" : "Add"} Interface`} subtitle={isEdit ? initial!.name : "IS-IS interface settings"} onClose={onClose} />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <datalist id="isis-if-interfaces">{interfaces.map((n) => <option key={n} value={n} />)}</datalist>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Interface">
            <input list="isis-if-interfaces" value={name} disabled={isEdit} onChange={(e) => setName(e.target.value)} placeholder="eth1" className="clr-input" style={monoStyle} />
          </Field>
          <Field label="Circuit type" hint="Which levels form adjacencies on this link.">
            <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
              <select value={circuitType} onChange={(e) => setCircuitType(e.target.value as IsisCircuitType | "")} className="clr-select" style={inputStyle}>
                <option value="">Default (level-1-2)</option>
                <option value="level-1">level-1</option>
                <option value="level-1-2">level-1-2</option>
                <option value="level-2-only">level-2-only</option>
              </select>
            </div>
          </Field>
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
          <Field label="Metric" hint="Wide metric (0–16777215).">
            <input value={metric} onChange={(e) => setMetric(e.target.value)} placeholder="10" className="clr-input" style={monoStyle} />
          </Field>
          <Field label="Hello interval" hint="Seconds between hellos.">
            <input value={hello} onChange={(e) => setHello(e.target.value)} placeholder="10" className="clr-input" style={monoStyle} />
          </Field>
          <Field label="Hello multiplier" hint="Missed hellos before down.">
            <input value={helloMult} onChange={(e) => setHelloMult(e.target.value)} placeholder="3" className="clr-input" style={monoStyle} />
          </Field>
        </div>

        <Field label="Password" hint="Per-interface plaintext authentication — leave blank for none.">
          <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="secret" type="password" className="clr-input" style={inputStyle} />
        </Field>

        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <label className="flex items-center gap-2 cursor-pointer select-none" style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>
            <Switch on={p2p} onChange={setP2p} />
            Point-to-point network
          </label>
          <label className="flex items-center gap-2 cursor-pointer select-none" style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>
            <Switch on={passive} onChange={setPassive} />
            Passive
          </label>
          <label className="flex items-center gap-2 cursor-pointer select-none" style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>
            <Switch on={bfd} onChange={setBfd} />
            BFD
          </label>
        </div>

        {error && (
          <div className="alert alert-danger alert-sm">
            <Icon shape="exclamation-circle" size={14} className="alert-icon" />
            <div className="alert-text">{error}</div>
          </div>
        )}

        <ModalFooter>
          <button type="button" className="btn btn-neutral" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "Applying…" : isEdit ? "Apply Changes" : "Add Interface"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
