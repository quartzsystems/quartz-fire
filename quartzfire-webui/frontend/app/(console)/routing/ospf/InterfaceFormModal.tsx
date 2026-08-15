"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import {
  applyOspfInterface,
  emptyOspfInterface,
  OspfInterface,
  OspfNetworkType,
  OSPF_NETWORK_TYPES,
} from "@/lib/ospf";

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

/// Create/edit an OSPF interface. Diffs against the live config and commits
/// under commit-confirm.
export function InterfaceFormModal({ initial, existingNames, areas, interfaces, onClose, onSaved }: {
  initial?: OspfInterface;
  existingNames: string[];
  areas: string[];
  interfaces: string[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const base = initial ?? emptyOspfInterface();
  const [name, setName] = useState(base.name);
  const [area, setArea] = useState(base.area ?? "");
  const [cost, setCost] = useState(numStr(base.cost));
  const [priority, setPriority] = useState(numStr(base.priority));
  const [hello, setHello] = useState(numStr(base.hello_interval));
  const [dead, setDead] = useState(numStr(base.dead_interval));
  const [networkType, setNetworkType] = useState<OspfNetworkType | "">(base.network_type ?? "");
  const [passive, setPassive] = useState(base.passive);
  const [bfd, setBfd] = useState(base.bfd);
  const [mtuIgnore, setMtuIgnore] = useState(base.mtu_ignore);
  const [authPassword, setAuthPassword] = useState(base.auth_password ?? "");
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
      setError(`Interface ${ifName} already has OSPF settings.`);
      return;
    }
    const desired: OspfInterface = {
      name: ifName,
      area: area.trim() || null,
      cost: numOrNull(cost),
      priority: numOrNull(priority),
      hello_interval: numOrNull(hello),
      dead_interval: numOrNull(dead),
      network_type: networkType === "" ? null : networkType,
      passive,
      bfd,
      mtu_ignore: mtuIgnore,
      auth_password: authPassword.trim() || null,
    };
    setSaving(true);
    try {
      const applied = await applyOspfInterface(initial ?? null, desired);
      onSaved(applied === 0 ? "No changes — config already matches." : `Applied ${applied} change${applied === 1 ? "" : "s"} to ${ifName}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={600}>
      <ModalHeader title={`${isEdit ? "Edit" : "Add"} Interface`} subtitle={isEdit ? initial!.name : "OSPF interface settings"} onClose={onClose} />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <datalist id="ospf-if-interfaces">{interfaces.map((n) => <option key={n} value={n} />)}</datalist>
        <datalist id="ospf-if-areas">{areas.map((a) => <option key={a} value={a} />)}</datalist>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Interface">
            <input list="ospf-if-interfaces" value={name} disabled={isEdit} onChange={(e) => setName(e.target.value)} placeholder="eth1" className="clr-input" style={monoStyle} />
          </Field>
          <Field label="Area" hint="Area this interface belongs to.">
            <input list="ospf-if-areas" value={area} onChange={(e) => setArea(e.target.value)} placeholder="0" className="clr-input" style={monoStyle} />
          </Field>
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Cost" hint="Interface output cost (1–65535).">
            <input value={cost} onChange={(e) => setCost(e.target.value)} placeholder="auto" className="clr-input" style={monoStyle} />
          </Field>
          <Field label="Priority" hint="DR election priority (0 = never DR).">
            <input value={priority} onChange={(e) => setPriority(e.target.value)} placeholder="1" className="clr-input" style={monoStyle} />
          </Field>
          <Field label="Hello Interval" hint="Seconds between hellos.">
            <input value={hello} onChange={(e) => setHello(e.target.value)} placeholder="10" className="clr-input" style={monoStyle} />
          </Field>
          <Field label="Dead Interval" hint="Seconds before declaring a neighbor down.">
            <input value={dead} onChange={(e) => setDead(e.target.value)} placeholder="40" className="clr-input" style={monoStyle} />
          </Field>
        </div>

        <Field label="Network Type">
          <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
            <select value={networkType} onChange={(e) => setNetworkType(e.target.value as OspfNetworkType | "")} className="clr-select" style={{ ...inputStyle, fontFamily: "var(--qz-font-mono)" }}>
              <option value="">Default</option>
              {OSPF_NETWORK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </Field>

        <Field label="Authentication Password" hint="Simple (plaintext) OSPF authentication — leave blank for none.">
          <input value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} placeholder="secret" type="password" className="clr-input" style={inputStyle} />
        </Field>

        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <label className="flex items-center gap-2 cursor-pointer select-none" style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>
            <Switch on={passive} onChange={setPassive} />
            Passive
          </label>
          <label className="flex items-center gap-2 cursor-pointer select-none" style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>
            <Switch on={bfd} onChange={setBfd} />
            BFD
          </label>
          <label className="flex items-center gap-2 cursor-pointer select-none" style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>
            <Switch on={mtuIgnore} onChange={setMtuIgnore} />
            MTU ignore
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
