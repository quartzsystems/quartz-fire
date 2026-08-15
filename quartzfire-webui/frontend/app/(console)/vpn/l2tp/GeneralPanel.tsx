"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import {
  IpsecAuthMode,
  L2TP_AUTH_PROTOCOLS,
  L2tpAuthMode,
  L2tpAuthProtocol,
  L2tpGeneral,
  L2tpPool,
  applyL2tpGeneral,
} from "@/lib/l2tp";

const inputSt = { maxWidth: "none", width: "100%" } as const;
const monoSt = { maxWidth: "none", width: "100%", fontFamily: "var(--qz-font-mono)" } as const;

/// One cell of the mock's `1fr 1fr` settings grid. `first` kills the top margin
/// on the leading row, per the DC card layout.
function Field({ label, hint, first, span, children }: { label: string; hint?: string; first?: boolean; span?: boolean; children: React.ReactNode }) {
  return (
    <div className="clr-form-control" style={{ marginTop: first ? 0 : undefined, gridColumn: span ? "1 / -1" : undefined }}>
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
const toList = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

/// Editable inline panel for the server-wide `vpn l2tp remote-access` settings.
/// Diffs against `live` and applies on Save.
export function GeneralPanel({ live, pools, onSaved }: {
  live: L2tpGeneral;
  /** Configured pools, offered for the client-IP-pool picker. */
  pools: L2tpPool[];
  onSaved: (message: string) => void;
}) {
  const [outside, setOutside] = useState(live.outside_address ?? "");
  const [gateway, setGateway] = useState(live.gateway_address ?? "");
  const [nameServers, setNameServers] = useState(live.name_servers.join(", "));
  const [mtu, setMtu] = useState(numStr(live.mtu));
  const [authMode, setAuthMode] = useState<L2tpAuthMode | "">(live.auth_mode ?? "");
  const [protocols, setProtocols] = useState<L2tpAuthProtocol[]>(live.auth_protocols);
  const [defaultPool, setDefaultPool] = useState(live.default_pool ?? "");
  const [ipsecMode, setIpsecMode] = useState<IpsecAuthMode | "">(live.ipsec_auth_mode ?? "");
  const [psk, setPsk] = useState(live.ipsec_pre_shared_secret ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const toggleProto = (proto: L2tpAuthProtocol) =>
    setProtocols((p) => (p.includes(proto) ? p.filter((x) => x !== proto) : [...p, proto]));

  const desired: L2tpGeneral = useMemo(() => ({
    outside_address: outside.trim() || null,
    gateway_address: gateway.trim() || null,
    name_servers: toList(nameServers),
    mtu: numOrNull(mtu),
    auth_mode: authMode || null,
    auth_protocols: protocols,
    default_pool: defaultPool.trim() || null,
    ipsec_auth_mode: ipsecMode || null,
    ipsec_pre_shared_secret: psk.trim() || null,
  }), [outside, gateway, nameServers, mtu, authMode, protocols, defaultPool, ipsecMode, psk]);

  const save = async () => {
    setError("");
    setSaving(true);
    try {
      const applied = await applyL2tpGeneral(live, desired);
      onSaved(applied === 0 ? "No changes — L2TP config already matches." : `Applied ${applied} L2TP change${applied === 1 ? "" : "s"}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to apply L2TP settings.");
    } finally {
      setSaving(false);
    }
  };

  // The current pool may reference a name that no longer exists — keep it
  // selectable so the live value round-trips.
  const poolOptions = useMemo(() => {
    const opts = pools.map((p) => ({ value: p.name, label: p.range ? `${p.name} — ${p.range}` : p.name }));
    if (defaultPool && !pools.some((p) => p.name === defaultPool)) opts.push({ value: defaultPool, label: defaultPool });
    return opts;
  }, [pools, defaultPool]);

  return (
    <div className="card" style={{ maxWidth: 720 }}>
      <div className="card-block">
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
          <Field label="Outside address" first hint="Public address the server binds to.">
            <input value={outside} onChange={(e) => setOutside(e.target.value)} placeholder="203.0.113.1" className="clr-input" style={monoSt} />
          </Field>
          <Field label="Gateway address" first hint="Server's address inside the tunnel.">
            <input value={gateway} onChange={(e) => setGateway(e.target.value)} placeholder="10.10.0.1" className="clr-input" style={monoSt} />
          </Field>
          <Field label="Client IP pool" hint="Pool clients draw from by default.">
            <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
              <select value={defaultPool} onChange={(e) => setDefaultPool(e.target.value)} className="clr-select" style={{ maxWidth: "none", width: "100%" }}>
                <option value="">None</option>
                {poolOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </Field>
          <Field label="DNS servers" hint="DNS pushed to clients, comma-separated.">
            <input value={nameServers} onChange={(e) => setNameServers(e.target.value)} placeholder="10.10.0.1, 1.1.1.1" className="clr-input" style={monoSt} />
          </Field>
          <Field label="IPsec pre-shared secret" hint={ipsecMode === "pre-shared-secret" ? "Leave blank to keep the current secret." : "Applies when IPsec authentication is pre-shared-secret."}>
            <input
              value={psk}
              onChange={(e) => setPsk(e.target.value)}
              type="password"
              placeholder="shared secret"
              disabled={ipsecMode !== "pre-shared-secret"}
              className="clr-input"
              style={inputSt}
            />
          </Field>
          <Field label="Authentication">
            <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
              <select value={authMode} onChange={(e) => setAuthMode(e.target.value as L2tpAuthMode | "")} className="clr-select" style={{ maxWidth: "none", width: "100%" }}>
                <option value="">Local users (default)</option>
                <option value="local">Local users</option>
                <option value="radius">RADIUS</option>
              </select>
            </div>
          </Field>
          <Field label="IPsec authentication" hint="L2TP is carried inside an IPsec transport tunnel.">
            <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
              <select value={ipsecMode} onChange={(e) => setIpsecMode(e.target.value as IpsecAuthMode | "")} className="clr-select" style={monoSt}>
                <option value="">None</option>
                <option value="pre-shared-secret">pre-shared-secret</option>
                <option value="x509">x509</option>
              </select>
            </div>
          </Field>
          <Field label="MTU">
            <input value={mtu} onChange={(e) => setMtu(e.target.value)} placeholder="1400" className="clr-input" style={monoSt} />
          </Field>
          <Field label="Protocols" span hint="Allowed PPP authentication protocols.">
            <div className="flex flex-wrap gap-3">
              {L2TP_AUTH_PROTOCOLS.map((proto) => (
                <div key={proto} className="clr-checkbox-wrapper">
                  <input id={`l2tp-proto-${proto}`} type="checkbox" checked={protocols.includes(proto)} onChange={() => toggleProto(proto)} />
                  <label htmlFor={`l2tp-proto-${proto}`} style={{ fontFamily: "var(--qz-font-mono)" }}>{proto}</label>
                </div>
              ))}
            </div>
          </Field>
        </div>

        {error && (
          <div className="alert alert-danger alert-sm" style={{ marginTop: 16 }}>
            <Icon shape="exclamation-circle" size={14} className="alert-icon" />
            <span className="alert-text">{error}</span>
          </div>
        )}
      </div>
      <div className="card-footer">
        <Button kind="primary" onClick={save} disabled={saving}>
          {saving ? "Applying…" : "Save L2TP Settings"}
        </Button>
      </div>
    </div>
  );
}
