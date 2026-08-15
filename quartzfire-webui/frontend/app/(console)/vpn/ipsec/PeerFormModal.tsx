"use client";

import { useState } from "react";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { Button, IconButton } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Segmented } from "@/components/ui/Segmented";
import {
  AuthMode,
  ConnectionType,
  IpsecPeer,
  IpsecTunnel,
  applyPeer,
  emptyPeer,
} from "@/lib/ipsec";

const inputSt = { maxWidth: "none" } as const;
const monoSt = { maxWidth: "none", fontFamily: "var(--qz-font-mono)" } as const;

function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="clr-form-control" style={{ marginTop: 0 }}>
      <label className="clr-control-label">
        {label} {required && <span className="clr-required">*</span>}
      </label>
      {children}
      {hint && <div className="clr-subtext">{hint}</div>}
    </div>
  );
}

/// The two IPsec designs. Policy-based selects traffic by local/remote prefix
/// tunnels; route-based binds the SA to a VTI interface and routes over it.
type Design = "policy" | "route";

let keyCounter = 0;
const nextKey = () => `tun-${keyCounter++}`;

interface TunnelRow {
  key: string;
  seq: string;
  local_prefix: string;
  remote_prefix: string;
}
const toTunnelRows = (ts: IpsecTunnel[]): TunnelRow[] =>
  ts.map((t) => ({ key: nextKey(), seq: String(t.seq), local_prefix: t.local_prefix ?? "", remote_prefix: t.remote_prefix ?? "" }));
const newTunnelRow = (seq: number): TunnelRow => ({ key: nextKey(), seq: String(seq), local_prefix: "", remote_prefix: "" });

/// Create/edit one IPsec site-to-site peer. Diffs against the live config and
/// commits under commit-confirm.
export function PeerFormModal({ initial, existingNames, ikeGroups, espGroups, onClose, onSaved }: {
  initial?: IpsecPeer;
  existingNames: string[];
  ikeGroups: string[];
  espGroups: string[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const base = initial ?? emptyPeer();
  const [design, setDesign] = useState<Design>(base.vti_bind ? "route" : "policy");
  const [name, setName] = useState(base.name);
  const [authMode, setAuthMode] = useState<AuthMode | "">(base.auth_mode ?? "pre-shared-secret");
  const [psk, setPsk] = useState(base.pre_shared_secret ?? "");
  const [localId, setLocalId] = useState(base.local_id ?? "");
  const [remoteId, setRemoteId] = useState(base.remote_id ?? "");
  const [connType, setConnType] = useState<ConnectionType | "">(base.connection_type ?? "");
  const [ikeGroup, setIkeGroup] = useState(base.ike_group ?? "");
  const [espGroup, setEspGroup] = useState(base.default_esp_group ?? "");
  const [localAddress, setLocalAddress] = useState(base.local_address ?? "");
  const [remoteAddress, setRemoteAddress] = useState(base.remote_address ?? "");
  const [vtiBind, setVtiBind] = useState(base.vti_bind ?? "");
  const [tunnels, setTunnels] = useState<TunnelRow[]>(toTunnelRows(base.tunnels));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const addTunnel = () => setTunnels((p) => [...p, newTunnelRow(p.length)]);
  const removeTunnel = (key: string) => setTunnels((p) => p.filter((r) => r.key !== key));
  const updateTunnel = (key: string, patch: Partial<Omit<TunnelRow, "key">>) =>
    setTunnels((p) => p.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    const pName = name.trim();
    if (!pName) return setError("Enter a peer name.");
    if (!isEdit && existingNames.includes(pName)) return setError(`Peer ${pName} already exists.`);

    // Tunnel sequences must be unique integers.
    const seen = new Set<string>();
    if (design === "policy") {
      for (const t of tunnels) {
        const s = t.seq.trim();
        if (s === "") continue;
        if (seen.has(s)) return setError(`Duplicate tunnel sequence "${s}".`);
        seen.add(s);
      }
    }

    const desired: IpsecPeer = {
      name: pName,
      auth_mode: authMode || null,
      pre_shared_secret: authMode === "pre-shared-secret" ? psk.trim() || null : null,
      local_id: localId.trim() || null,
      remote_id: remoteId.trim() || null,
      connection_type: connType || null,
      ike_group: ikeGroup.trim() || null,
      default_esp_group: espGroup.trim() || null,
      local_address: localAddress.trim() || null,
      remote_address: remoteAddress.trim() || null,
      vti_bind: design === "route" ? vtiBind.trim() || null : null,
      tunnels:
        design === "policy"
          ? tunnels
              .filter((t) => Number.isInteger(Number(t.seq.trim())) && t.seq.trim() !== "")
              .map<IpsecTunnel>((t) => ({
                seq: Number(t.seq.trim()),
                local_prefix: t.local_prefix.trim() || null,
                remote_prefix: t.remote_prefix.trim() || null,
                protocol: null,
                esp_group: null,
              }))
          : [],
    };

    setSaving(true);
    try {
      const applied = await applyPeer(initial ?? null, desired);
      onSaved(applied === 0 ? "No changes — config already matches." : `Applied ${applied} change${applied === 1 ? "" : "s"} to ${pName}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={640}>
      <ModalHeader title={`${isEdit ? "Edit" : "Add"} IPsec Peer`} subtitle={isEdit ? initial!.name : "Site-to-site tunnel to a remote gateway"} onClose={onClose} />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <datalist id="ipsec-ike-groups">{ikeGroups.map((g) => <option key={g} value={g} />)}</datalist>
        <datalist id="ipsec-esp-groups">{espGroups.map((g) => <option key={g} value={g} />)}</datalist>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Peer name" required hint="A label, or the peer's address / hostname.">
            <input value={name} disabled={isEdit} onChange={(e) => setName(e.target.value)} placeholder="peer-hq" className="clr-input" style={monoSt} />
          </Field>
          <Field label="Connection type">
            <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
              <select value={connType} onChange={(e) => setConnType(e.target.value as ConnectionType | "")} className="clr-select" style={monoSt}>
                <option value="">Default</option>
                <option value="initiate">initiate</option>
                <option value="respond">respond</option>
                <option value="none">none</option>
              </select>
            </div>
          </Field>
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Local address" hint="Local WAN address (must be a bound interface).">
            <input value={localAddress} onChange={(e) => setLocalAddress(e.target.value)} placeholder="203.0.113.1" className="clr-input" style={monoSt} />
          </Field>
          <Field label="Remote address" hint="Peer's public address.">
            <input value={remoteAddress} onChange={(e) => setRemoteAddress(e.target.value)} placeholder="198.51.100.1" className="clr-input" style={monoSt} />
          </Field>
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="IKE group" required>
            <input list="ipsec-ike-groups" value={ikeGroup} onChange={(e) => setIkeGroup(e.target.value)} placeholder="IKE-DEFAULT" className="clr-input" style={monoSt} />
          </Field>
          <Field label="Default ESP group" required>
            <input list="ipsec-esp-groups" value={espGroup} onChange={(e) => setEspGroup(e.target.value)} placeholder="ESP-DEFAULT" className="clr-input" style={monoSt} />
          </Field>
        </div>

        {/* Authentication */}
        <span className="clr-smallcaption mt-1">Authentication</span>
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Mode">
            <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
              <select value={authMode} onChange={(e) => setAuthMode(e.target.value as AuthMode | "")} className="clr-select" style={monoSt}>
                <option value="pre-shared-secret">pre-shared-secret</option>
                <option value="x509">x509</option>
              </select>
            </div>
          </Field>
          {authMode === "pre-shared-secret" && (
            <Field label="Pre-shared secret" hint="Leave blank to keep the current secret.">
              <input value={psk} onChange={(e) => setPsk(e.target.value)} type="password" placeholder="shared secret" className="clr-input" style={inputSt} />
            </Field>
          )}
        </div>
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Local ID" hint="IKE identity sent to the peer (optional).">
            <input value={localId} onChange={(e) => setLocalId(e.target.value)} placeholder="203.0.113.1" className="clr-input" style={monoSt} />
          </Field>
          <Field label="Remote ID" hint="Expected IKE identity of the peer (optional).">
            <input value={remoteId} onChange={(e) => setRemoteId(e.target.value)} placeholder="198.51.100.1" className="clr-input" style={monoSt} />
          </Field>
        </div>

        {/* Design: policy vs route (VTI) */}
        <div className="flex items-center gap-3 mt-1">
          <span className="clr-smallcaption">Tunnels</span>
          <Segmented
            items={[{ value: "policy", label: "Policy-based" }, { value: "route", label: "Route-based (VTI)" }]}
            value={design}
            onChange={(v) => setDesign(v as Design)}
          />
        </div>

        {design === "route" ? (
          <Field label="VTI interface" required hint="Bind the SA to this VTI (`interfaces vti <vtiN>`); route traffic over it.">
            <input value={vtiBind} onChange={(e) => setVtiBind(e.target.value)} placeholder="vti0" className="clr-input" style={monoSt} />
          </Field>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px]" style={{ color: "var(--cds-alias-typography-color-300)" }}>Traffic selectors — local → remote prefixes.</span>
              <Button kind="ghost" size="sm" icon="plus" onClick={addTunnel}>Add Tunnel</Button>
            </div>
            {tunnels.length === 0 && <p className="text-[12px] m-0" style={{ color: "var(--cds-alias-typography-color-300)" }}>No tunnels — a policy-based peer needs at least one.</p>}
            {tunnels.map((t) => (
              <div key={t.key} className="flex items-center gap-2">
                <input value={t.seq} onChange={(e) => updateTunnel(t.key, { seq: e.target.value })} placeholder="#" className="clr-input text-center" style={{ ...monoSt, width: 52, flex: "none" }} />
                <input value={t.local_prefix} onChange={(e) => updateTunnel(t.key, { local_prefix: e.target.value })} placeholder="192.168.0.0/24" className="clr-input flex-1" style={monoSt} />
                <span className="text-[12px]" style={{ color: "var(--cds-alias-typography-color-200)" }}>→</span>
                <input value={t.remote_prefix} onChange={(e) => updateTunnel(t.key, { remote_prefix: e.target.value })} placeholder="192.168.1.0/24" className="clr-input flex-1" style={monoSt} />
                <IconButton icon="trash" onClick={() => removeTunnel(t.key)} label="Remove tunnel" />
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="alert alert-danger alert-sm">
            <Icon shape="exclamation-circle" size={14} className="alert-icon" />
            <span className="alert-text">{error}</span>
          </div>
        )}

        <ModalFooter>
          <button type="button" onClick={onClose} className="btn btn-neutral">Cancel</button>
          <button type="submit" disabled={saving} className="btn btn-primary">
            {saving ? "Applying…" : isEdit ? "Apply Changes" : "Add Peer"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
