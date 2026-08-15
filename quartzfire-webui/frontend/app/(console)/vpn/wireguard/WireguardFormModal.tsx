"use client";

import { useState } from "react";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { Button, IconButton } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Switch } from "@/components/ui/Switch";
import {
  WireguardInterface,
  WireguardPeer,
  applyWireguard,
  emptyWireguardInterface,
} from "@/lib/wireguard";

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

const numOrNull = (s: string) => {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isInteger(n) ? n : null;
};
const numStr = (n: number | null) => (n == null ? "" : String(n));
/// Split a comma/whitespace-separated list into trimmed, non-empty tokens.
const toList = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

let keyCounter = 0;
const nextKey = () => `wg-peer-${keyCounter++}`;

/// A peer row while editing (strings + a stable react key). `allowed_ips` is a
/// single comma-separated field for compactness in the nested card.
interface PeerRow {
  key: string;
  name: string;
  public_key: string;
  preshared_key: string;
  allowed_ips: string;
  endpoint_address: string;
  endpoint_port: string;
  persistent_keepalive: string;
  disabled: boolean;
}

function toPeerRow(p: WireguardPeer): PeerRow {
  return {
    key: nextKey(),
    name: p.name,
    public_key: p.public_key ?? "",
    preshared_key: p.preshared_key ?? "",
    allowed_ips: p.allowed_ips.join(", "),
    endpoint_address: p.endpoint_address ?? "",
    endpoint_port: numStr(p.endpoint_port),
    persistent_keepalive: numStr(p.persistent_keepalive),
    disabled: p.disabled,
  };
}
const emptyPeerRow = (): PeerRow => ({
  key: nextKey(),
  name: "",
  public_key: "",
  preshared_key: "",
  allowed_ips: "",
  endpoint_address: "",
  endpoint_port: "",
  persistent_keepalive: "",
  disabled: false,
});

/// Create/edit one WireGuard interface and its peers. Diffs against the live
/// config and commits under commit-confirm.
export function WireguardFormModal({ initial, existingNames, interfaces, onClose, onSaved }: {
  initial?: WireguardInterface;
  existingNames: string[];
  interfaces: string[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const base = initial ?? emptyWireguardInterface();
  const [name, setName] = useState(base.name);
  const [description, setDescription] = useState(base.description ?? "");
  const [addresses, setAddresses] = useState(base.addresses.join(", "));
  const [privateKey, setPrivateKey] = useState(base.private_key ?? "");
  const [port, setPort] = useState(numStr(base.port));
  const [mtu, setMtu] = useState(numStr(base.mtu));
  const [enabled, setEnabled] = useState(base.enabled);
  const [peers, setPeers] = useState<PeerRow[]>(base.peers.map(toPeerRow));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const addPeer = () => setPeers((p) => [...p, emptyPeerRow()]);
  const removePeer = (key: string) => setPeers((p) => p.filter((r) => r.key !== key));
  const updatePeer = (key: string, patch: Partial<Omit<PeerRow, "key">>) =>
    setPeers((p) => p.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    const ifName = name.trim();
    if (!ifName) return setError("Enter an interface name (e.g. wg0).");
    if (!/^wg\d+$/.test(ifName)) return setError("Interface name must be wg followed by a number (e.g. wg0).");
    if (!isEdit && existingNames.includes(ifName)) return setError(`Interface ${ifName} already exists.`);

    // Peer validation: each needs a name and public key; names must be unique.
    const seen = new Set<string>();
    for (const row of peers) {
      const pn = row.name.trim();
      if (!pn) return setError("Every peer needs a name.");
      if (seen.has(pn)) return setError(`Duplicate peer name "${pn}".`);
      seen.add(pn);
      if (!row.public_key.trim()) return setError(`Peer "${pn}" needs a public key.`);
    }

    const desired: WireguardInterface = {
      name: ifName,
      description: description.trim() || null,
      addresses: toList(addresses),
      private_key: privateKey.trim() || null,
      port: numOrNull(port),
      mtu: numOrNull(mtu),
      enabled,
      peers: peers.map<WireguardPeer>((r) => ({
        name: r.name.trim(),
        public_key: r.public_key.trim() || null,
        preshared_key: r.preshared_key.trim() || null,
        allowed_ips: toList(r.allowed_ips),
        endpoint_address: r.endpoint_address.trim() || null,
        endpoint_port: numOrNull(r.endpoint_port),
        persistent_keepalive: numOrNull(r.persistent_keepalive),
        disabled: r.disabled,
      })),
    };

    setSaving(true);
    try {
      const applied = await applyWireguard(initial ?? null, desired);
      onSaved(applied === 0 ? "No changes — config already matches." : `Applied ${applied} change${applied === 1 ? "" : "s"} to ${ifName}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={680}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Add"} WireGuard Interface`}
        subtitle={isEdit ? initial!.name : "Tunnel endpoint and its peers"}
        onClose={onClose}
      />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <datalist id="wg-interfaces">{interfaces.map((n) => <option key={n} value={n} />)}</datalist>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
          <Field label="Name" required hint="wg0, wg1, …">
            <input value={name} disabled={isEdit} onChange={(e) => setName(e.target.value)} placeholder="wg0" className="clr-input" style={monoSt} />
          </Field>
          <Field label="Addresses" hint="Comma-separated (e.g. 10.0.0.1/24).">
            <input value={addresses} onChange={(e) => setAddresses(e.target.value)} placeholder="10.0.0.1/24" className="clr-input" style={monoSt} />
          </Field>
          <Field label="Listen port" hint="UDP port this endpoint listens on.">
            <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="51820" className="clr-input" style={monoSt} />
          </Field>
        </div>

        <Field label="Private key" required={!isEdit} hint="Base64 key from `generate pki wireguard key-pair`. Leave blank to keep the current key.">
          <input value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} type="password" placeholder="base64 private key" className="clr-input" style={monoSt} />
        </Field>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="MTU" hint="Default 1420.">
            <input value={mtu} onChange={(e) => setMtu(e.target.value)} placeholder="1420" className="clr-input" style={monoSt} />
          </Field>
          <Field label="Description">
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Site-to-site to HQ" className="clr-input" style={inputSt} />
          </Field>
        </div>

        <label className="flex items-center gap-2 cursor-pointer select-none text-[13px]" style={{ color: "var(--cds-alias-typography-color-400)" }}>
          <Switch on={enabled} onChange={setEnabled} />
          Interface enabled
        </label>

        {/* Peers — nested bordered cards, "Add Peer" bottom-left per the mock. */}
        <span className="clr-smallcaption mt-1">Peers</span>

        {peers.length === 0 && (
          <p className="text-[12px] m-0" style={{ color: "var(--cds-alias-typography-color-300)" }}>No peers yet. A tunnel needs at least one peer to pass traffic.</p>
        )}

        <div className="flex flex-col gap-3">
          {peers.map((peer) => (
            <div key={peer.key} className="flex flex-col gap-3" style={{ border: "1px solid var(--cds-alias-object-border-color)", borderRadius: "var(--clr-base-border-radius-m)", padding: "12px 16px" }}>
              <div className="flex items-center gap-2">
                <input value={peer.name} onChange={(e) => updatePeer(peer.key, { name: e.target.value })} placeholder="peer name" className="clr-input flex-1" style={monoSt} />
                <label className="flex items-center gap-1 text-[12px] whitespace-nowrap" style={{ color: "var(--cds-alias-typography-color-300)" }}>
                  <Switch on={peer.disabled} onChange={(v) => updatePeer(peer.key, { disabled: v })} />
                  Disabled
                </label>
                <IconButton icon="trash" onClick={() => removePeer(peer.key)} label="Remove peer" />
              </div>
              <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
                <Field label="Public key" required>
                  <input value={peer.public_key} onChange={(e) => updatePeer(peer.key, { public_key: e.target.value })} placeholder="peer base64 public key" className="clr-input" style={monoSt} />
                </Field>
                <Field label="Allowed IPs" hint="Networks routed into the tunnel, comma-separated.">
                  <input value={peer.allowed_ips} onChange={(e) => updatePeer(peer.key, { allowed_ips: e.target.value })} placeholder="10.0.0.2/32, 192.168.20.0/24" className="clr-input" style={monoSt} />
                </Field>
                <Field label="Endpoint" hint="Remote host and port (blank for roaming).">
                  <div className="flex gap-2">
                    <input value={peer.endpoint_address} onChange={(e) => updatePeer(peer.key, { endpoint_address: e.target.value })} placeholder="vpn.example.com" className="clr-input flex-1" style={monoSt} />
                    <input value={peer.endpoint_port} onChange={(e) => updatePeer(peer.key, { endpoint_port: e.target.value })} placeholder="51820" className="clr-input" style={{ ...monoSt, width: 90, flex: "none" }} />
                  </div>
                </Field>
                <Field label="Persistent keepalive" hint="Seconds.">
                  <input value={peer.persistent_keepalive} onChange={(e) => updatePeer(peer.key, { persistent_keepalive: e.target.value })} placeholder="25" className="clr-input" style={monoSt} />
                </Field>
              </div>
              <Field label="Pre-shared key" hint="Optional symmetric key. Leave blank to keep the current one.">
                <input value={peer.preshared_key} onChange={(e) => updatePeer(peer.key, { preshared_key: e.target.value })} type="password" placeholder="optional base64 pre-shared key" className="clr-input" style={monoSt} />
              </Field>
            </div>
          ))}
        </div>

        <div>
          <Button kind="outline" size="sm" onClick={addPeer}>Add Peer</Button>
        </div>

        {error && (
          <div className="alert alert-danger alert-sm">
            <Icon shape="exclamation-circle" size={14} className="alert-icon" />
            <span className="alert-text">{error}</span>
          </div>
        )}

        <ModalFooter>
          <button type="button" onClick={onClose} className="btn btn-neutral">
            Cancel
          </button>
          <button type="submit" disabled={saving} className="btn btn-primary">
            {saving ? "Applying…" : isEdit ? "Apply Changes" : "Add Interface"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
